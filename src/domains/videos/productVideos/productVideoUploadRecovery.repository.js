import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoReplacementStatusEnum,
  videoUploadRecoveryStatusEnum,
  videoProviderOperationTypeEnum,
  videoProviderOperationStatusEnum,
} from "../../../shared/constants/enums.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";

const conflict = () => new ApiError("Product Video recovery changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);

export function createProductVideoUploadRecoveryPersistence({
  libraryId, placements, replacements, assets, recoveries, operations, withTransaction, recordOperation, now,
}) {
  const binding = row => ({ _id: row.videoId, productId: row.productId, activeSlot: true,
    uploadRecoveryId: row._id,
    ...(row.replacementId ? { lifecycleState: productVideoLifecycleStateEnum.READY, replacementId: row.replacementId,
      activeAssetId: row.previousActiveAssetId, pendingAssetId: row.previousAssetId } : { lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD, activeAssetId: row.previousAssetId,
      replacementId: { $exists: false }, pendingAssetId: { $exists: false } }),
  });
  async function target({ productId, videoId, replacementId }, session = null) {
    const placement = await placements.findOne({ _id: videoId, productId, activeSlot: true,
      ...(replacementId ? { lifecycleState: productVideoLifecycleStateEnum.READY, replacementId } : {
        lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD, replacementId: { $exists: false }, pendingAssetId: { $exists: false } }),
    }).session(session).lean();
    if (!placement) throw conflict();
    const replacement = replacementId ? await replacements.findOne({ _id: replacementId, productId,
      videoId, assetId: placement.pendingAssetId, status: productVideoReplacementStatusEnum.ISSUED }).session(session).lean() : null;
    if (replacementId && !replacement) throw conflict();
    const abandonAt = (replacement ?? placement).abandonAt;
    if (!(abandonAt instanceof Date) || abandonAt.getTime() <= now()) throw conflict();
    const asset = await assets.findOne({ _id: replacementId ? placement.pendingAssetId : placement.activeAssetId,
      libraryId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
      technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.DELETING, videoAssetTechnicalStateEnum.DELETED] },
    }).session(session).lean();
    if (!asset || !isBunnyTusUploadUrl(asset.tusUploadUrl)) throw conflict();
    return { placement, replacement, asset, abandonAt };
  }
  async function retire(asset, session, recoveryId) {
    if (!asset.deletionRequestedAt) await assets.updateOne({ _id: asset._id, libraryId,
      providerGuid: asset.providerGuid, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: asset.ownerId },
    { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) } }, { session });
    const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
      libraryId, providerGuid: asset.providerGuid, dedupeKey: `recovery-new:${recoveryId}:${asset._id}`, session });
    return String(operation._id);
  }
  async function fail({ recoveryId, providerGuid, uploadUrl, resourceExpiresAt,
    failureCode = "VIDEO_PROVIDER_UNAVAILABLE", expectedUpdatedAt }) {
    return withTransaction(async session => {
      const row = await recoveries.findOne({ _id: recoveryId }).session(session);
      if (!row || row.status === videoUploadRecoveryStatusEnum.ISSUED) return null;
      if (expectedUpdatedAt && row.updatedAt?.getTime() !== expectedUpdatedAt.getTime()) return null;
      let asset = row.assetId ? await assets.findOne({ _id: row.assetId, libraryId,
        ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row.videoId }).session(session) : null;
      if (row.assetId && !asset) throw conflict();
      if (providerGuid) {
        const existing = await assets.findOne({ libraryId, providerGuid }).session(session);
        if (existing && (!asset || String(existing._id) !== String(asset._id))) throw conflict();
        if (asset && asset.providerGuid !== providerGuid) throw conflict();
        if (!asset) [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row.videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
      }
      const operationIds = [];
      if (asset) {
        if (isBunnyTusUploadUrl(uploadUrl) && Number.isSafeInteger(resourceExpiresAt)) {
          await assets.updateOne({ _id: asset._id }, { $set: { tusUploadUrl: uploadUrl,
            tusResourceExpiresAt: resourceExpiresAt } }, { session });
        }
        operationIds.push(await retire(asset, session, row._id));
      }
      const finishedAt = new Date(now());
      await recoveries.updateOne({ _id: row._id, status: { $in: [videoUploadRecoveryStatusEnum.WAITING_CLEANUP, videoUploadRecoveryStatusEnum.RESERVING, videoUploadRecoveryStatusEnum.FAILED] } },
        { $set: { status: videoUploadRecoveryStatusEnum.FAILED, failureCode, finishedAt, ...(asset ? { assetId: asset._id } : {}) } }, { session });
      const expired = row.abandonAt <= finishedAt;
      if (expired) {
        const detached = await placements.updateOne(binding(row), row.replacementId ? {
          $unset: { pendingAssetId: "", replacementId: "", uploadRecoveryId: "" },
          $set: { replacementFailureCode: "VIDEO_UPLOAD_ABANDONED" },
        } : { $set: { activeSlot: false, lifecycleState: productVideoLifecycleStateEnum.REMOVED, removedAt: finishedAt },
          $unset: { uploadRecoveryId: "" } }, { session });
        if (detached.modifiedCount && row.replacementId) await replacements.updateOne({ _id: row.replacementId,
          assetId: row.previousAssetId, status: productVideoReplacementStatusEnum.ISSUED },
        { $set: { status: productVideoReplacementStatusEnum.FAILED, failureCode: "VIDEO_UPLOAD_ABANDONED", finishedAt } }, { session });
        await recoveries.updateOne({ _id: row._id }, { $set: { expiredAt: finishedAt } }, { session });
      } else if (asset || row.status === videoUploadRecoveryStatusEnum.WAITING_CLEANUP) {
        // Unknown creates retain the marker: a new key cannot blindly allocate again.
        await placements.updateOne({ _id: row.videoId, uploadRecoveryId: row._id },
          { $unset: { uploadRecoveryId: "" } }, { session });
      }
      return { operationIds };
    });
  }
  return {
    async getUploadRecoveryReplay({ productId, videoId, replacementId, actorId, idempotencyKey, file }) {
      const row = await recoveries.findOne({ videoId, idempotencyKey }).lean();
      if (!row) return null;
      const requestFingerprint = createHash("sha256").update(JSON.stringify({ actorId: String(actorId),
        replacementId: replacementId ?? null, file })).digest("hex");
      if (String(row.productId) !== String(productId) || row.requestFingerprint !== requestFingerprint ||
          row.status === videoUploadRecoveryStatusEnum.FAILED || row.abandonAt <= new Date(now())) throw conflict();
      const context = await target({ productId, videoId, replacementId });
      if (row.replacementId && String(context.placement.activeAssetId) !== String(row.previousActiveAssetId)) throw conflict();
      if (row.status === videoUploadRecoveryStatusEnum.ISSUED) {
        if (String(context.asset._id) !== String(row.assetId) || context.asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD ||
            context.asset.deletionRequestedAt) throw conflict();
        return { status: videoUploadRecoveryStatusEnum.ISSUED, id: String(row._id), position: context.placement.position,
          providerGuid: context.asset.providerGuid, uploadUrl: context.asset.tusUploadUrl,
          resourceExpiresAt: context.asset.tusResourceExpiresAt, abandonAt: row.abandonAt };
      }
      if (String(context.placement.uploadRecoveryId) !== String(row._id) ||
          String(context.asset._id) !== String(row.previousAssetId)) throw conflict();
      return { ...row, id: String(row._id), position: context.placement.position };
    },
    async getUploadRecoveryTarget(input) {
      const context = await target(input);
      if (context.placement.uploadRecoveryId) throw conflict();
      const descriptor = context.replacement ?? context.placement;
      if (descriptor.clientId !== input.file.clientId || descriptor.safeFilename !== input.file.filename) throw conflict();
      return context;
    },
    async reserveUploadRecovery({ productId, videoId, replacementId, actorId, idempotencyKey, file, expectedAsset }) {
      return withTransaction(async session => {
        const context = await target({ productId, videoId, replacementId }, session);
        const { asset, placement, abandonAt } = context;
        if (placement.uploadRecoveryId || String(asset._id) !== String(expectedAsset._id) ||
            asset.providerGuid !== expectedAsset.providerGuid || asset.tusUploadUrl !== expectedAsset.tusUploadUrl ||
            asset.technicalState !== expectedAsset.technicalState) throw conflict();
        const id = new mongoose.Types.ObjectId();
        const changed = await placements.updateOne({ _id: placement._id, activeSlot: true,
          uploadRecoveryId: { $exists: false }, ...(replacementId ? { replacementId,
            activeAssetId: placement.activeAssetId, pendingAssetId: asset._id } :
            { activeAssetId: asset._id, lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD }) },
        { $set: { uploadRecoveryId: id } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        await assets.updateOne({ _id: asset._id, technicalState: asset.technicalState },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) } }, { session });
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
          libraryId, providerGuid: asset.providerGuid, dedupeKey: `recovery-old:${id}`, session });
        const requestFingerprint = createHash("sha256").update(JSON.stringify({ actorId: String(actorId),
          replacementId: replacementId ?? null, file })).digest("hex");
        await recoveries.create([{ _id: id, productId, videoId, actorId, idempotencyKey,
          ...(replacementId ? { replacementId, previousActiveAssetId: placement.activeAssetId } : {}), previousAssetId: asset._id,
          requestFingerprint, abandonAt, cleanupOperationId: operation._id, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP }], { session });
        return { id: String(id), position: placement.position, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP,
          operationId: String(operation._id), abandonAt };
      });
    },
    async beginUploadRecovery(recoveryId) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP,
          abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row) return null;
        const cleanup = await operations.findOne({ _id: row.cleanupOperationId, status: videoProviderOperationStatusEnum.COMPLETED,
          assetId: row.previousAssetId, libraryId }).session(session);
        if (!cleanup) return null;
        const previous = await assets.findOne({ _id: row.previousAssetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO,
          ownerId: row.videoId, libraryId, providerGuid: cleanup.providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETED,
          deletionRequestedAt: { $exists: true }, deleteAcceptedAt: { $exists: true } }).session(session);
        if (!previous) throw conflict();
        if (!await placements.findOne(binding(row)).session(session)) throw conflict();
        return recoveries.findOneAndUpdate({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP },
          { $set: { status: videoUploadRecoveryStatusEnum.RESERVING } }, { session, new: true });
      });
    },
    async attachUploadRecoveryVideo({ recoveryId, providerGuid }) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.RESERVING,
          assetId: { $exists: false }, abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row || !await placements.findOne(binding(row)).session(session)) throw conflict();
        if (await assets.findOne({ libraryId, providerGuid }).session(session)) throw conflict();
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row.videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
        await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.RESERVING }, { $set: { assetId: asset._id } }, { session });
      });
    },
    async issueUploadRecovery({ recoveryId, providerGuid, uploadUrl, resourceExpiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl) || !Number.isSafeInteger(resourceExpiresAt) ||
          resourceExpiresAt <= Math.floor(now() / 1000)) throw conflict();
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.RESERVING,
          abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row?.assetId || resourceExpiresAt > Math.floor(row.abandonAt.getTime() / 1000)) throw conflict();
        const asset = await assets.findOneAndUpdate({ _id: row.assetId, libraryId, providerGuid,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row.videoId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
          deletionRequestedAt: { $exists: false } }, { $set: { tusUploadUrl: uploadUrl,
            tusResourceExpiresAt: resourceExpiresAt } }, { session, new: true });
        if (!asset) throw conflict();
        const placement = await placements.findOneAndUpdate(binding(row), {
          $set: row.replacementId ? { pendingAssetId: asset._id } : { activeAssetId: asset._id },
          $unset: { uploadRecoveryId: "" },
        }, { session, new: true });
        if (!placement) throw conflict();
        if (row.replacementId) {
          const changed = await replacements.updateOne({ _id: row.replacementId, status: productVideoReplacementStatusEnum.ISSUED,
            assetId: row.previousAssetId }, { $set: { assetId: asset._id } }, { session });
          if (changed.modifiedCount !== 1) throw conflict();
        }
        await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.RESERVING },
          { $set: { status: videoUploadRecoveryStatusEnum.ISSUED, finishedAt: new Date(now()) } }, { session });
        return { id: String(row._id), status: videoUploadRecoveryStatusEnum.ISSUED, position: placement.position,
          providerGuid, uploadUrl, resourceExpiresAt, abandonAt: row.abandonAt };
      });
    },
    failUploadRecovery: fail,
    async getUploadRecoveryOrphanContext({ videoId, recoveryId }) {
      const row = await recoveries.findOne({ _id: recoveryId, videoId, status: videoUploadRecoveryStatusEnum.FAILED,
        assetId: { $exists: false } }).lean();
      if (!row) return null;
      return { libraryId, providerTitle: `petyard-product-recovery:${String(row._id)}`,
        createdAt: row.createdAt, failedAt: row.finishedAt };
    },
    async commitUploadRecoveryOrphan({ videoId, recoveryId, providerGuid, expectedContext }) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, videoId, status: videoUploadRecoveryStatusEnum.FAILED,
          assetId: { $exists: false } }).session(session);
        if (!row || expectedContext?.libraryId !== libraryId ||
            expectedContext.providerTitle !== `petyard-product-recovery:${String(row._id)}` ||
            row.createdAt?.getTime() !== expectedContext.createdAt?.getTime() ||
            row.finishedAt?.getTime() !== expectedContext.failedAt?.getTime()) return false;
        if (await assets.findOne({ libraryId, providerGuid }).session(session)) return false;
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
        const changed = await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.FAILED, assetId: { $exists: false } },
          { $set: { assetId: asset._id } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        const operationId = await retire(asset, session, row._id);
        await placements.updateOne({ _id: videoId, uploadRecoveryId: row._id },
          { $unset: { uploadRecoveryId: "" } }, { session });
        return { operationId };
      });
    },
    async recoverStaleUploadRecoveries({ before, limit }) {
      const rows = await recoveries.find({ $or: [{ status: videoUploadRecoveryStatusEnum.RESERVING, updatedAt: { $lte: before } },
        { status: { $in: [videoUploadRecoveryStatusEnum.WAITING_CLEANUP, videoUploadRecoveryStatusEnum.RESERVING, videoUploadRecoveryStatusEnum.FAILED] },
          abandonAt: { $lte: new Date(now()) }, expiredAt: { $exists: false } }] })
        .sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const summary = { examined: rows.length, recovered: 0, failed: 0, operationIds: [] };
      for (const row of rows) {
        try {
          const result = await fail({ recoveryId: row._id, failureCode: "VIDEO_UPLOAD_SETUP_EXPIRED",
            expectedUpdatedAt: row.updatedAt });
          if (!result) continue;
          summary.operationIds.push(...result.operationIds);
          summary.recovered++;
        } catch { summary.failed++; }
      }
      return summary;
    },
  };
}
