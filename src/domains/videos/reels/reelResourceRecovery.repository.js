import {
  editorialVideoStatusEnum,
  editorialReviewStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  reelUploadSessionStatusEnum,
  videoUploadRecoveryStatusEnum,
  reelUploadPurposeEnum,
  videoProviderOperationTypeEnum,
  videoProviderOperationStatusEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
} from "../../../shared/constants/enums.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";
import { reelUploadBinding } from "./reelUploadBinding.js";

const conflict = () => new ApiError("Reel recovery changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
const fingerprint = input => createHash("sha256").update(JSON.stringify({
  actorId: String(input.actor.id), purpose: input.purpose, filename: input.file.filename,
  mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes,
})).digest("hex");

export function createReelResourceRecoveryPersistence({ libraryId, videos, sessions, assets, recoveries,
  operations, attempts, withTransaction, recordOperation, now, loadSessionContext }) {
  async function target(input, session) {
    const context = await loadSessionContext(input, session);
    const { video, row, asset, isCurrent } = context;
    if (!isCurrent || row?.status !== reelUploadSessionStatusEnum.ISSUED ||
        (input.purpose === reelUploadPurposeEnum.INITIAL && video.status !== editorialVideoStatusEnum.DRAFT) ||
        !(row.abandonAt instanceof Date) || row.abandonAt.getTime() <= now() ||
        ![videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.DELETING, videoAssetTechnicalStateEnum.DELETED].includes(asset?.technicalState) ||
        !isBunnyTusUploadUrl(asset?.tusUploadUrl)) throw conflict();
    return context;
  }
  async function current(row, session) {
    const upload = await sessions.findOne({ _id: row.sessionId, videoId: row.videoId,
      status: reelUploadSessionStatusEnum.ISSUED, assetId: row.previousAssetId, uploadRecoveryId: row._id,
      abandonAt: row.abandonAt }).session(session);
    if (!upload || !await videos.findOne(reelUploadBinding(upload).filter).session(session)) return null;
    return upload;
  }
  async function retire(asset, session, recoveryId) {
    if (!asset.deletionRequestedAt) await assets.updateOne({ _id: asset._id, libraryId,
      providerGuid: asset.providerGuid, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: asset.ownerId },
    { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) } }, { session });
    const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
      libraryId, providerGuid: asset.providerGuid, dedupeKey: `reel-resource-new:${recoveryId}:${asset._id}`, session });
    return String(operation._id);
  }
  async function fail({ recoveryId, providerGuid, uploadUrl, resourceExpiresAt,
    failureCode = "VIDEO_PROVIDER_UNAVAILABLE", expectedUpdatedAt }) {
    return withTransaction(async session => {
      const row = await recoveries.findOne({ _id: recoveryId }).session(session);
      if (!row || row.status === videoUploadRecoveryStatusEnum.ISSUED ||
          (expectedUpdatedAt && row.updatedAt?.getTime() !== expectedUpdatedAt.getTime())) return null;
      let asset = row.assetId ? await assets.findOne({ _id: row.assetId, libraryId,
        ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId }).session(session) : null;
      if (row.assetId && !asset) throw conflict();
      if (providerGuid) {
        const existing = await assets.findOne({ libraryId, providerGuid }).session(session);
        if ((existing && (!asset || String(existing._id) !== String(asset._id))) ||
            (asset && asset.providerGuid !== providerGuid)) throw conflict();
        if (!asset) [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
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
      await recoveries.updateOne({ _id: row._id },
        { $set: { status: videoUploadRecoveryStatusEnum.FAILED, failureCode, finishedAt, ...(asset ? { assetId: asset._id } : {}) } }, { session });
      if (row.abandonAt <= finishedAt) {
        const upload = await current(row, session);
        if (upload) {
          const binding = reelUploadBinding(upload);
          const detached = await videos.updateOne(binding.filter, { $unset: binding.unset,
            ...(upload.purpose === reelUploadPurposeEnum.REPLACEMENT ? { $set: { "pendingChange.status": editorialReviewStatusEnum.DRAFT,
              "pendingChange.submittedAt": null, "pendingChange.reviewReason": null } } : {}),
            $inc: { revision: 1 } }, { session });
          if (detached.modifiedCount !== 1) throw conflict();
          await sessions.updateOne({ _id: upload._id, uploadRecoveryId: row._id, status: reelUploadSessionStatusEnum.ISSUED },
            { $set: { status: reelUploadSessionStatusEnum.FAILED, failureCode: "VIDEO_UPLOAD_ABANDONED", failedAt: finishedAt },
              $unset: { uploadRecoveryId: "" } }, { session });
          await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId, actorId: row.actorId,
            safeFilename: upload.safeFilename, stage: videoUploadAttemptStageEnum.UPLOAD, outcome: videoUploadAttemptOutcomeEnum.FAILED,
            errorCode: "VIDEO_UPLOAD_ABANDONED", finishedAt }], { session });
        }
        await recoveries.updateOne({ _id: row._id }, { $set: { expiredAt: finishedAt } }, { session });
      } else if (asset || row.status === videoUploadRecoveryStatusEnum.WAITING_CLEANUP) {
        // Unknown creates retain the marker so a new key cannot allocate blindly.
        await sessions.updateOne({ _id: row.sessionId, uploadRecoveryId: row._id },
          { $unset: { uploadRecoveryId: "" } }, { session });
      }
      return { operationIds };
    });
  }
  return {
    failResourceRecovery: fail,
    async getResourceRecoveryOrphanContext({ sessionId, recoveryId }) {
      const row = await recoveries.findOne({ _id: recoveryId, sessionId, status: videoUploadRecoveryStatusEnum.FAILED,
        assetId: { $exists: false } }).lean();
      return row ? { id: String(row._id), providerTitle: `petyard-reel-recovery:${row._id}`,
        createdAt: row.createdAt, failedAt: row.finishedAt } : null;
    },
    async commitResourceRecoveryOrphan({ sessionId, recoveryId, providerGuid, expectedContext }) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, sessionId, status: videoUploadRecoveryStatusEnum.FAILED,
          assetId: { $exists: false } }).session(session);
        if (!row || expectedContext?.providerTitle !== `petyard-reel-recovery:${row._id}` ||
            row.createdAt?.getTime() !== expectedContext.createdAt?.getTime() ||
            row.finishedAt?.getTime() !== expectedContext.failedAt?.getTime() ||
            await assets.findOne({ libraryId, providerGuid }).session(session)) return false;
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
        const changed = await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.FAILED, assetId: { $exists: false } },
          { $set: { assetId: asset._id } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        const operationId = await retire(asset, session, row._id);
        await sessions.updateOne({ _id: row.sessionId, uploadRecoveryId: row._id },
          { $unset: { uploadRecoveryId: "" } }, { session });
        return { operationId };
      });
    },
    async recoverStaleResourceRecoveries({ before, limit }) {
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
    async getResourceRecoveryTarget(input) {
      return withTransaction(async session => {
        const context = await target(input, session);
        if (context.row.uploadRecoveryId || context.row.safeFilename !== input.file.filename ||
            context.row.mimeType !== input.file.mimeType || context.row.sizeBytes !== input.file.sizeBytes) throw conflict();
        return context;
      });
    },
    async getResourceRecoveryReplay(input) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ sessionId: input.sessionId, idempotencyKey: input.idempotencyKey }).session(session);
        if (!row) return null;
        if (String(row.videoId) !== String(input.videoId) || row.requestFingerprint !== fingerprint(input) ||
            row.status === videoUploadRecoveryStatusEnum.FAILED || row.abandonAt <= new Date(now())) throw conflict();
        const context = await target(input, session);
        if (row.status === videoUploadRecoveryStatusEnum.ISSUED) {
          if (String(context.asset._id) !== String(row.assetId) || context.asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD ||
              context.asset.deletionRequestedAt) throw conflict();
          return { id: String(row._id), status: videoUploadRecoveryStatusEnum.ISSUED, providerGuid: context.asset.providerGuid,
            uploadUrl: context.asset.tusUploadUrl, resourceExpiresAt: context.asset.tusResourceExpiresAt,
            abandonAt: row.abandonAt };
        }
        if (!await current(row, session)) throw conflict();
        return { ...(row.toObject?.() ?? row), id: String(row._id) };
      });
    },
    async reserveResourceRecovery({ expectedAsset, ...input }) {
      return withTransaction(async session => {
        const { row, asset, video } = await target(input, session);
        if (row.uploadRecoveryId || String(asset._id) !== String(expectedAsset._id) ||
            asset.providerGuid !== expectedAsset.providerGuid || asset.tusUploadUrl !== expectedAsset.tusUploadUrl ||
            asset.technicalState !== expectedAsset.technicalState || row.safeFilename !== input.file.filename ||
            row.mimeType !== input.file.mimeType || row.sizeBytes !== input.file.sizeBytes) throw conflict();
        const id = new mongoose.Types.ObjectId();
        const changed = await videos.updateOne({ ...reelUploadBinding(row).filter, revision: video.revision },
          { $inc: { revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        const marked = await sessions.updateOne({ _id: row._id, status: reelUploadSessionStatusEnum.ISSUED, assetId: asset._id,
          uploadRecoveryId: { $exists: false } }, { $set: { uploadRecoveryId: id } }, { session });
        if (marked.modifiedCount !== 1) throw conflict();
        if (!asset.deletionRequestedAt) await assets.updateOne({ _id: asset._id, technicalState: asset.technicalState },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: new Date(now()) } }, { session });
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
          libraryId, providerGuid: asset.providerGuid, dedupeKey: `reel-resource-old:${id}`, session });
        await recoveries.create([{ _id: id, videoId: input.videoId, sessionId: row._id, actorId: input.actor.id,
          purpose: input.purpose, previousAssetId: asset._id, idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint(input), abandonAt: row.abandonAt,
          cleanupOperationId: operation._id, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP }], { session });
        return { id: String(id), status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP, operationId: String(operation._id) };
      });
    },
    async beginResourceRecovery(recoveryId) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP,
          abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row) return null;
        const cleanup = await operations.findOne({ _id: row.cleanupOperationId, status: videoProviderOperationStatusEnum.COMPLETED,
          assetId: row.previousAssetId, libraryId }).session(session);
        if (!cleanup) return null;
        if (!await assets.findOne({ _id: row.previousAssetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
          libraryId, providerGuid: cleanup.providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETED,
          deletionRequestedAt: { $exists: true }, deleteAcceptedAt: { $exists: true } }).session(session) ||
            !await current(row, session)) throw conflict();
        return recoveries.findOneAndUpdate({ _id: row._id, status: videoUploadRecoveryStatusEnum.WAITING_CLEANUP },
          { $set: { status: videoUploadRecoveryStatusEnum.RESERVING } }, { session, new: true });
      });
    },
    async attachResourceRecoveryVideo({ recoveryId, providerGuid }) {
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.RESERVING,
          assetId: { $exists: false }, abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row || !await current(row, session) || await assets.findOne({ libraryId, providerGuid }).session(session)) throw conflict();
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
        await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.RESERVING }, { $set: { assetId: asset._id } }, { session });
      });
    },
    async issueResourceRecovery({ recoveryId, providerGuid, uploadUrl, resourceExpiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl) || !Number.isSafeInteger(resourceExpiresAt) ||
          resourceExpiresAt <= Math.floor(now() / 1000)) throw conflict();
      return withTransaction(async session => {
        const row = await recoveries.findOne({ _id: recoveryId, status: videoUploadRecoveryStatusEnum.RESERVING,
          abandonAt: { $gt: new Date(now()) } }).session(session);
        if (!row?.assetId || resourceExpiresAt > Math.floor(row.abandonAt.getTime() / 1000)) throw conflict();
        const upload = await current(row, session);
        if (!upload) throw conflict();
        const asset = await assets.findOneAndUpdate({ _id: row.assetId, libraryId, providerGuid,
          ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD, deletionRequestedAt: { $exists: false } },
        { $set: { tusUploadUrl: uploadUrl, tusResourceExpiresAt: resourceExpiresAt } }, { session, new: true });
        if (!asset) throw conflict();
        const binding = reelUploadBinding(upload);
        const changed = await videos.updateOne(binding.filter,
          { $set: { [binding.assetPath]: asset._id }, $inc: { revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        const issued = await sessions.updateOne({ _id: upload._id, status: reelUploadSessionStatusEnum.ISSUED, assetId: row.previousAssetId,
          uploadRecoveryId: row._id }, { $set: { assetId: asset._id }, $unset: { uploadRecoveryId: "" } }, { session });
        if (issued.modifiedCount !== 1) throw conflict();
        await recoveries.updateOne({ _id: row._id, status: videoUploadRecoveryStatusEnum.RESERVING },
          { $set: { status: videoUploadRecoveryStatusEnum.ISSUED, finishedAt: new Date(now()) } }, { session });
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId, actorId: row.actorId,
          assetId: asset._id, safeFilename: upload.safeFilename, stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED,
          finishedAt: new Date(now()) }], { session });
        return { id: String(row._id), status: videoUploadRecoveryStatusEnum.ISSUED, providerGuid, uploadUrl, resourceExpiresAt, abandonAt: row.abandonAt };
      });
    },
  };
}
