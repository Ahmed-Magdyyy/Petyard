import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoReplacementStatusEnum,
  videoProviderOperationTypeEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
} from "../../../shared/constants/enums.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";

const conflict = () => new ApiError("Product Video replacement changed or is unavailable", 409,
  [{ code: "VIDEO_UPLOAD_CONFLICT" }]);

// Internal persistence implementation; callers use the Product Video application.
export function createReplacementPersistence({
  libraryId, placements, assets, replacements, attempts,
  withTransaction, recordOperation, now,
}) {
  async function retireAsset(asset, session, dedupeKey) {
    await assets.updateOne({ _id: asset._id },
      { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) } }, { session });
    const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
      libraryId: asset.libraryId, providerGuid: asset.providerGuid, dedupeKey, session });
    return String(operation._id);
  }

  return {
    async getRefreshableReplacement({ productId, videoId, replacementId }) {
      const replacement = await replacements.findOne({ _id: replacementId,
        productId, videoId, status: productVideoReplacementStatusEnum.ISSUED, abandonAt: { $gt: new Date(now()) } }).lean();
      if (!replacement) throw conflict();
      const row = await placements.findOne({ _id: videoId, productId,
        activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY, replacementId, pendingAssetId: replacement.assetId }).lean();
      if (!row) throw conflict();
      const asset = await assets.findOne({ _id: replacement.assetId,
        ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
        deletionRequestedAt: { $exists: false } }).lean();
      if (!asset) throw conflict();
      return { id: String(replacementId), position: row.position,
        providerGuid: asset.providerGuid, abandonAt: replacement.abandonAt,
        uploadUrl: asset.tusUploadUrl, resourceExpiresAt: asset.tusResourceExpiresAt };
    },
    async cancelReplacement({ productId, videoId, replacementId }) {
      const operationId = await withTransaction(async (session) => {
        const replacement = await replacements.findOne({ _id: replacementId, productId, videoId }).session(session);
        if (replacement?.status === productVideoReplacementStatusEnum.CANCELLED) return null;
        if (replacement?.status !== productVideoReplacementStatusEnum.ISSUED) throw conflict();
        const row = await placements.findOneAndUpdate({ _id: videoId, productId,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY, replacementId, pendingAssetId: replacement.assetId },
        { $unset: { pendingAssetId: "", replacementId: "", uploadRecoveryId: "" } }, { session, new: true });
        if (!row) throw conflict();
        const asset = await assets.findOne({ _id: replacement.assetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO,
          ownerId: videoId, libraryId,
          technicalState: { $in: Object.values(videoAssetTechnicalStateEnum) } }).session(session);
        if (!asset) throw conflict();
        const finishedAt = new Date(now());
        await replacements.updateOne({ _id: replacementId, status: productVideoReplacementStatusEnum.ISSUED },
          { $set: { status: productVideoReplacementStatusEnum.CANCELLED, finishedAt } }, { session });
        const id = asset.deletionRequestedAt ? null : await retireAsset(asset, session, `replacement-cancel:${replacementId}`);
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
          actorId: replacement.actorId, safeFilename: replacement.safeFilename, assetId: asset._id,
          stage: videoUploadAttemptStageEnum.UPLOAD, outcome: videoUploadAttemptOutcomeEnum.CANCELLED, finishedAt }], { session });
        return id;
      });
      return { operationId };
    },
    async failReplacementSetup({ productId, videoId, replacementId, providerGuid }) {
      const operationId = await withTransaction(async (session) => {
        const replacement = await replacements.findOne({ _id: replacementId,
          productId, videoId }).session(session);
        // An uncertain commit may have issued the session. Never compensate a
        // resource already adopted by an issued or completed replacement.
        const expiredSetup = replacement?.status === productVideoReplacementStatusEnum.FAILED &&
          replacement.failureCode === "VIDEO_UPLOAD_SETUP_EXPIRED" && !replacement.issuedAt;
        if (!replacement || (replacement.status !== productVideoReplacementStatusEnum.RESERVING && !expiredSetup)) return null;
        if (expiredSetup && !providerGuid) return null;
        let cleanupId = null;
        let asset;
        if (providerGuid) {
          asset = await assets.findOne({ libraryId, providerGuid }).session(session);
          if (asset) {
            if (expiredSetup && String(asset._id) === String(replacement.assetId) &&
                asset.ownerType === videoAssetOwnerTypeEnum.PRODUCT_VIDEO && String(asset.ownerId) === String(videoId) && asset.deletionRequestedAt) return null;
            if (String(asset._id) !== String(replacement.assetId) ||
                asset.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO || String(asset.ownerId) !== String(videoId)) {
              throw new Error("VIDEO_REPLACEMENT_UNEXPECTED_ASSET");
            }
          } else {
            [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
              libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) }], { session });
          }
          cleanupId = await retireAsset(asset, session, `replacement-setup:${replacementId}`);
        }
        if (expiredSetup) {
          // A suspended create request returned after recovery. Capture its GUID
          // without clearing a newer replacement marker or changing the old video.
          await replacements.updateOne({ _id: replacementId, status: productVideoReplacementStatusEnum.FAILED,
            failureCode: "VIDEO_UPLOAD_SETUP_EXPIRED" }, { $set: { assetId: asset._id } }, { session });
          return cleanupId;
        }
        const finishedAt = new Date(now());
        const failureCode = "VIDEO_PROVIDER_UNAVAILABLE";
        await replacements.updateOne({ _id: replacementId, status: productVideoReplacementStatusEnum.RESERVING },
          { $set: { status: productVideoReplacementStatusEnum.FAILED, failureCode, finishedAt, ...(asset ? { assetId: asset._id } : {}) } }, { session });
        await placements.updateOne({ _id: videoId, productId, replacementId },
          { $unset: { replacementId: "", pendingAssetId: "" }, $set: { replacementFailureCode: failureCode } }, { session });
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
          actorId: replacement.actorId, safeFilename: replacement.safeFilename,
          ...(asset ? { assetId: asset._id } : {}),
          stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: failureCode, finishedAt }], { session });
        return cleanupId;
      });
      return { operationId };
    },
    async commitReplacementFailure({ placementId, assetId, failureCode }) {
      const result = await withTransaction(async (session) => {
        const row = await placements.findOne({ _id: placementId, activeSlot: true,
          lifecycleState: productVideoLifecycleStateEnum.READY, pendingAssetId: assetId }).session(session);
        if (!row) return null;
        const replacement = await replacements.findOne({ _id: row.replacementId,
          videoId: placementId, assetId, status: productVideoReplacementStatusEnum.ISSUED }).session(session);
        const asset = await assets.findOne({ _id: assetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO,
          ownerId: placementId, technicalState: videoAssetTechnicalStateEnum.FAILED }).session(session);
        if (!replacement || !asset) return null;
        const changed = await placements.findOneAndUpdate({ _id: row._id,
          pendingAssetId: assetId, replacementId: replacement._id, activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY },
        { $unset: { pendingAssetId: "", replacementId: "" }, $set: { replacementFailureCode: failureCode } },
        { session, new: true });
        if (!changed) throw conflict();
        const finishedAt = new Date(now());
        await replacements.updateOne({ _id: replacement._id, status: productVideoReplacementStatusEnum.ISSUED },
          { $set: { status: productVideoReplacementStatusEnum.FAILED, failureCode, finishedAt } }, { session });
        const operationId = await retireAsset(asset, session, `replacement-failed:${replacement._id}`);
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId,
          actorId: replacement.actorId, assetId, safeFilename: replacement.safeFilename,
          stage: videoUploadAttemptStageEnum.PROCESSING, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: failureCode, finishedAt }], { session });
        return { operationId };
      });
      return result || false;
    },
    async commitReplacementReady({ placementId, assetId }) {
      const result = await withTransaction(async (session) => {
        const asset = await assets.findOne({ _id: assetId, ownerId: placementId,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, technicalState: videoAssetTechnicalStateEnum.READY,
          deletionRequestedAt: { $exists: false } }).session(session);
        if (!asset) return null;
        const row = await placements.findOne({ _id: placementId, pendingAssetId: assetId,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY, replacementId: { $exists: true } }).session(session);
        if (!row) return null;
        const replacement = await replacements.findOne({ _id: row.replacementId,
          videoId: placementId, assetId, status: productVideoReplacementStatusEnum.ISSUED }).session(session);
        if (!replacement) return null;
        const old = await assets.findOne({ _id: row.activeAssetId, ownerId: placementId,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, technicalState: videoAssetTechnicalStateEnum.READY,
          deletionRequestedAt: { $exists: false } }).session(session);
        if (!old) throw conflict();
        const finishedAt = new Date(now());
        const switched = await placements.findOneAndUpdate({ _id: row._id,
          activeAssetId: old._id, pendingAssetId: assetId, replacementId: replacement._id,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY },
        { $set: { activeAssetId: asset._id }, $unset: { pendingAssetId: "", replacementId: "" } },
        { session, new: true });
        if (!switched) throw conflict();
        await replacements.updateOne({ _id: replacement._id, status: productVideoReplacementStatusEnum.ISSUED },
          { $set: { status: productVideoReplacementStatusEnum.COMPLETED, finishedAt } }, { session });
        await assets.updateOne({ _id: old._id },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: finishedAt } }, { session });
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.DELETE, assetId: old._id,
          libraryId: old.libraryId, providerGuid: old.providerGuid,
          dedupeKey: `replacement-old:${replacement._id}:${old._id}`, session });
        await attempts.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId, assetId,
          actorId: replacement.actorId, safeFilename: replacement.safeFilename,
          stage: videoUploadAttemptStageEnum.PROCESSING, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED, finishedAt,
        }], { session });
        return { operationId: String(operation._id), productId: row.productId };
      });
      return result || false;
    },
    async reserveReplacement({ productId, videoId, actorId, idempotencyKey, file }) {
      const requestFingerprint = createHash("sha256").update(JSON.stringify([
        String(actorId), file.clientId, file.filename, file.mimeType, file.sizeBytes,
      ])).digest("hex");
      return withTransaction(async (session) => {
        const existing = await replacements.findOne({ videoId, idempotencyKey }).session(session);
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint || String(existing.productId) !== String(productId)) throw conflict();
          const placement = await placements.findOne({ _id: videoId, productId,
            activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY }).session(session);
          if (!placement || existing.status === productVideoReplacementStatusEnum.RESERVING) throw conflict();
          const result = { id: String(existing._id), position: placement.position,
            clientId: existing.clientId, status: existing.status };
          if (existing.status !== productVideoReplacementStatusEnum.ISSUED) return result;
          if (String(placement.replacementId) !== String(existing._id) ||
              String(placement.pendingAssetId) !== String(existing.assetId)) throw conflict();
          const asset = await assets.findOne({ _id: existing.assetId,
            ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
            deletionRequestedAt: { $exists: false } }).session(session);
          if (!asset) throw conflict();
          if (asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD) return { ...result, status: asset.technicalState };
          if (!existing.abandonAt || existing.abandonAt.getTime() <= now()) throw conflict();
          return { ...result, providerGuid: asset.providerGuid, abandonAt: existing.abandonAt,
            uploadUrl: asset.tusUploadUrl, resourceExpiresAt: asset.tusResourceExpiresAt };
        }
        const id = new mongoose.Types.ObjectId();
        const row = await placements.findOneAndUpdate({
          _id: videoId, productId, activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY,
          replacementId: { $exists: false }, pendingAssetId: { $exists: false },
        }, { $set: { replacementId: id }, $unset: { replacementFailureCode: "" } }, { session, new: true });
        if (!row) throw conflict();
        const active = await assets.findOne({ _id: row.activeAssetId,
          ownerId: row._id, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, technicalState: videoAssetTechnicalStateEnum.READY,
          deletionRequestedAt: { $exists: false } }).session(session);
        if (!active) throw conflict();
        await replacements.create([{
          _id: id, productId, videoId, actorId, idempotencyKey,
          requestFingerprint, clientId: file.clientId, safeFilename: file.filename,
          status: productVideoReplacementStatusEnum.RESERVING,
        }], { session });
        return { id: String(id), position: row.position, clientId: file.clientId, status: productVideoReplacementStatusEnum.RESERVING };
      });
    },
    async attachReplacementVideo({ productId, videoId, replacementId, providerGuid }) {
      return withTransaction(async (session) => {
        const replacement = await replacements.findOne({ _id: replacementId,
          videoId, productId, status: productVideoReplacementStatusEnum.RESERVING, assetId: { $exists: false } }).session(session);
        if (!replacement) throw conflict();
        const [asset] = await assets.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId, libraryId, providerGuid,
          technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
        }], { session });
        const row = await placements.findOneAndUpdate({
          _id: videoId, productId, replacementId, activeSlot: true,
          lifecycleState: productVideoLifecycleStateEnum.READY, pendingAssetId: { $exists: false },
        }, { $set: { pendingAssetId: asset._id } }, { session, new: true });
        if (!row) throw conflict();
        await replacements.updateOne({ _id: replacementId, status: productVideoReplacementStatusEnum.RESERVING },
          { $set: { assetId: asset._id } }, { session });
      });
    },
    async issueReplacement({ productId, videoId, replacementId, providerGuid, uploadUrl, resourceExpiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl) || !Number.isSafeInteger(resourceExpiresAt) ||
          resourceExpiresAt <= Math.floor(now() / 1000)) throw conflict();
      return withTransaction(async (session) => {
        const replacement = await replacements.findOne({ _id: replacementId,
          videoId, productId, status: productVideoReplacementStatusEnum.RESERVING }).session(session);
        if (!replacement?.assetId) throw conflict();
        const row = await placements.findOne({ _id: videoId, productId, replacementId,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY, pendingAssetId: replacement.assetId }).session(session);
        if (!row) throw conflict();
        const asset = await assets.findOneAndUpdate({ _id: replacement.assetId, libraryId, providerGuid,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
          deletionRequestedAt: { $exists: false }, tusUploadUrl: { $exists: false } },
        { $set: { tusUploadUrl: uploadUrl, tusResourceExpiresAt: resourceExpiresAt } }, { session, new: true });
        if (!asset) throw conflict();
        const issuedAt = new Date(now());
        const abandonAt = new Date(now() + 24 * 60 * 60 * 1000);
        await replacements.updateOne({ _id: replacementId, status: productVideoReplacementStatusEnum.RESERVING },
          { $set: { status: productVideoReplacementStatusEnum.ISSUED, assetId: asset._id, issuedAt, abandonAt } }, { session });
        await attempts.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId, assetId: asset._id,
          actorId: replacement.actorId, safeFilename: replacement.safeFilename,
          stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED, finishedAt: issuedAt,
        }], { session });
        return { id: String(replacementId), position: row.position,
          clientId: replacement.clientId, status: productVideoReplacementStatusEnum.ISSUED, providerGuid, abandonAt, uploadUrl, resourceExpiresAt };
      });
    },
  };
}
