import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoUploadBatchStatusEnum,
  productVideoReplacementStatusEnum,
  videoProviderOperationTypeEnum,
  videoProviderOperationStatusEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
  videoUploadResponseStatusEnum,
} from "../../../shared/constants/enums.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";

import { ProductModel } from "../../product/product.model.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { VideoUploadAttemptModel } from "../provider/videoUploadAttempt.model.js";
import { ProductVideoModel } from "./productVideo.model.js";
import { ProductVideoUploadBatchModel } from "./productVideoUploadBatch.model.js";
import { VideoProviderOperationModel } from "../provider/videoProviderOperation.model.js";
import { ProductVideoReplacementModel } from "./productVideoReplacement.model.js";
import { createReplacementPersistence } from "./productVideoReplacement.repository.js";
import { createSetupRecoveryPersistence } from "./productVideoSetupRecovery.repository.js";
import { createProductVideoOrphanRecoveryPersistence } from "./productVideoOrphanRecovery.repository.js";
import { ProductVideoUploadRecoveryModel } from "./productVideoUploadRecovery.model.js";
import { createProductVideoUploadRecoveryPersistence } from "./productVideoUploadRecovery.repository.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function videoError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

function fingerprint(files, actorId) {
  return createHash("sha256")
    .update(JSON.stringify({ actorId: String(actorId), files }))
    .digest("hex");
}

export function createProductVideoRepository({
  libraryId,
  connection = mongoose,
  products = ProductModel,
  placements = ProductVideoModel,
  batches = ProductVideoUploadBatchModel,
  assets = VideoAssetModel,
  operations = VideoProviderOperationModel,
  attempts = VideoUploadAttemptModel,
  replacements = ProductVideoReplacementModel,
  recoveries = ProductVideoUploadRecoveryModel,
  recordOperation = recordVideoProviderOperation,
  now = Date.now,
} = {}) {
  if (typeof libraryId !== "string" || !/^\d+$/.test(libraryId)) {
    throw new TypeError("libraryId must be numeric");
  }

  async function withTransaction(work) {
    const session = await connection.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function loadBatch(batch, session = null) {
    const rows = await placements.find({ uploadBatchId: batch._id })
      .sort({ position: 1 })
      .session(session)
      .lean();
    if (!rows.length || rows.some((row) => !row.activeSlot || row.lifecycleState !== productVideoLifecycleStateEnum.AWAITING_UPLOAD)) {
      throw videoError("Upload batch cannot be replayed", 409, "VIDEO_UPLOAD_CONFLICT");
    }
    const ids = rows.map((row) => row.activeAssetId).filter(Boolean);
    const assetRows = ids.length
      ? await assets.find({ _id: { $in: ids } }).session(session).lean()
      : [];
    const assetById = new Map(assetRows.map((asset) => [String(asset._id), asset]));
    if (rows.some((row) => {
      const asset = assetById.get(String(row.activeAssetId));
      return !asset || asset.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO || String(asset.ownerId) !== String(row._id) ||
        asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD || asset.deletionRequestedAt ||
        !(row.abandonAt instanceof Date) || row.abandonAt.getTime() <= now();
    })) throw videoError("Upload batch cannot be replayed", 409, "VIDEO_UPLOAD_CONFLICT");
    return {
      status: batch.status,
      placements: rows.map((row) => ({
        id: String(row._id),
        clientId: row.clientId,
        position: row.position,
        providerGuid: assetById.get(String(row.activeAssetId))?.providerGuid || null,
        uploadUrl: assetById.get(String(row.activeAssetId))?.tusUploadUrl,
        resourceExpiresAt: assetById.get(String(row.activeAssetId))?.tusResourceExpiresAt,
        abandonAt: row.abandonAt,
      })),
    };
  }

  return Object.freeze({
    ...createProductVideoUploadRecoveryPersistence({ libraryId, placements, replacements, assets,
      recoveries, operations, withTransaction, recordOperation, now }),
    ...createProductVideoOrphanRecoveryPersistence({ libraryId, batches, replacements, placements, recoveries, assets,
      withTransaction, recordOperation, now }),
    ...createSetupRecoveryPersistence({ libraryId, batches, replacements, placements, assets, attempts,
      withTransaction, recordOperation, now }),
    ...createReplacementPersistence({ libraryId, placements, assets, replacements,
      attempts, withTransaction, recordOperation, now }),
    async commitMissingUpload({ placementId, assetId, providerGuid, requireStatusZero = false }) {
      const result = await withTransaction(async (session) => {
        const finishedAt = new Date(now());
        const asset = await assets.findOne({ _id: assetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId,
          libraryId, ...(providerGuid ? { providerGuid } : {}),
          ...(requireStatusZero ? { providerStatus: 0 } : {}),
          technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD, deletionRequestedAt: { $exists: false } }).session(session);
        if (!asset) return null;
        let row = await placements.findOneAndUpdate({ _id: placementId, activeAssetId: assetId,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD, abandonAt: { $lte: finishedAt },
          pendingAssetId: { $exists: false }, replacementId: { $exists: false } },
        { $set: { activeSlot: false, lifecycleState: productVideoLifecycleStateEnum.REMOVED, removedAt: finishedAt } }, { session, new: true });
        let actorId;
        let safeFilename;
        if (row) {
          const batch = await batches.findById(row.uploadBatchId).session(session);
          if (!batch) throw new Error("VIDEO_UPLOAD_BATCH_MISSING");
          actorId = batch.actorId;
          safeFilename = row.safeFilename;
        } else {
          const replacement = await replacements.findOne({ videoId: placementId, assetId,
            status: productVideoReplacementStatusEnum.ISSUED, abandonAt: { $lte: finishedAt } }).session(session);
          if (!replacement) return null;
          row = await placements.findOneAndUpdate({ _id: placementId, productId: replacement.productId,
            pendingAssetId: assetId, replacementId: replacement._id, activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.READY },
          { $unset: { pendingAssetId: "", replacementId: "" },
            $set: { replacementFailureCode: "VIDEO_UPLOAD_ABANDONED" } }, { session, new: true });
          if (!row) return null;
          await replacements.updateOne({ _id: replacement._id, status: productVideoReplacementStatusEnum.ISSUED },
            { $set: { status: productVideoReplacementStatusEnum.FAILED, failureCode: "VIDEO_UPLOAD_ABANDONED", finishedAt } }, { session });
          actorId = replacement.actorId;
          safeFilename = replacement.safeFilename;
        }
        await assets.updateOne({ _id: assetId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: finishedAt,
            safeFailureCode: "VIDEO_UPLOAD_ABANDONED" } }, { session });
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId,
          libraryId: asset.libraryId, providerGuid: asset.providerGuid,
          dedupeKey: `abandoned:${assetId}`, session });
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId,
          actorId, assetId, safeFilename,
          stage: videoUploadAttemptStageEnum.UPLOAD, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: "VIDEO_UPLOAD_ABANDONED", finishedAt }], { session });
        return { operationId: String(operation._id), productId: row.productId };
      });
      return result || false;
    },
    async setReelsVisibility({ productId, videoId, showInReelsFeed }) {
      const row = await placements.findOneAndUpdate(
        { _id: videoId, productId, activeSlot: true,
          lifecycleState: productVideoLifecycleStateEnum.READY, pendingAssetId: { $exists: false }, replacementId: { $exists: false } },
        { $set: { showInReelsFeed } },
        { new: true },
      );
      if (!row) throw videoError("Product Video cannot be edited now", 409, "VIDEO_UPLOAD_CONFLICT");
      return { id: String(row._id), showInReelsFeed: row.showInReelsFeed, productId: row.productId };
    },
    async cancelPendingUpload({ productId, videoId }) {
      const result = await withTransaction(async (session) => {
        const cancelledAt = new Date(now());
        const row = await placements.findOneAndUpdate(
          { _id: videoId, productId, activeSlot: true,
            lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD, pendingAssetId: { $exists: false } },
          { $set: { lifecycleState: productVideoLifecycleStateEnum.REMOVED, activeSlot: false, removedAt: cancelledAt },
            $unset: { uploadRecoveryId: "" } },
          { session, new: true },
        );
        if (!row) throw videoError("Product Video upload cannot be cancelled now", 409, "VIDEO_UPLOAD_CONFLICT");
        const asset = await assets.findOne({
          _id: row.activeAssetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO,
          ownerId: row._id, libraryId, technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.DELETING, videoAssetTechnicalStateEnum.DELETED] },
        }).session(session);
        if (!asset) throw videoError("Product Video upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        const batch = await batches.findById(row.uploadBatchId).session(session);
        if (!batch) throw videoError("Product Video upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        let operation;
        if (!asset.deletionRequestedAt) {
          if (asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD) throw videoError("Product Video upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
          await assets.updateOne(
            { _id: asset._id, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD },
            { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: cancelledAt } },
            { session },
          );
          operation = await recordOperation({
            type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
            libraryId: asset.libraryId, providerGuid: asset.providerGuid,
            dedupeKey: `cancel:${row._id}:${asset._id}`, session,
          });
        }
        await attempts.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id,
          actorId: batch.actorId, assetId: asset._id,
          safeFilename: row.safeFilename,
          stage: videoUploadAttemptStageEnum.UPLOAD, outcome: videoUploadAttemptOutcomeEnum.CANCELLED, finishedAt: cancelledAt,
        }], { session });
        return { id: String(row._id), status: videoUploadResponseStatusEnum.CANCELLED,
          operationId: operation ? String(operation._id) : null, productId: row.productId };
      });
      return result;
    },
    async requestDeletion({ productId, videoId }) {
      const result = await withTransaction(async (session) => {
        const requestedAt = new Date(now());
        const row = await placements.findOneAndUpdate(
          { _id: videoId, productId, activeSlot: true,
            lifecycleState: productVideoLifecycleStateEnum.READY, pendingAssetId: { $exists: false }, replacementId: { $exists: false } },
          { $set: { lifecycleState: productVideoLifecycleStateEnum.DELETING, deletionRequestedAt: requestedAt } },
          { session, new: true },
        );
        if (!row) throw videoError("Product Video cannot be deleted now", 409, "VIDEO_UPLOAD_CONFLICT");
        const asset = await assets.findOne({
          _id: row.activeAssetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO,
          ownerId: row._id, technicalState: videoAssetTechnicalStateEnum.READY,
        }).session(session);
        if (!asset) throw videoError("Product Video is unavailable", 409, "VIDEO_ASSET_NOT_READY");
        await assets.updateOne(
          { _id: asset._id, technicalState: videoAssetTechnicalStateEnum.READY },
          { $set: { deletionRequestedAt: requestedAt } },
          { session },
        );
        const operation = await recordOperation({
          type: videoProviderOperationTypeEnum.DELETE, assetId: asset._id,
          libraryId: asset.libraryId, providerGuid: asset.providerGuid,
          dedupeKey: `product-delete:${row._id}:${asset._id}`,
          session,
        });
        return { id: String(row._id), status: videoUploadResponseStatusEnum.DELETING,
          operationId: String(operation._id) };
      });
      return result;
    },
    async commitDeletionAccepted({ placementId, assetId }) {
      const row = await placements.findOneAndUpdate(
        { _id: placementId, activeAssetId: assetId,
          activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.DELETING },
        { $set: { activeSlot: false, lifecycleState: productVideoLifecycleStateEnum.REMOVED,
          removedAt: new Date(now()) } },
        { new: true },
      );
      return row ? { productId: row.productId } : false;
    },
    async findPlacementForAsset({ asset }) {
      const row = await placements.findOne({ _id: asset.ownerId }).lean();
      if (!row) return null;
      return {
        id: String(row._id), productId: String(row.productId),
        activeAssetId: row.activeAssetId ? String(row.activeAssetId) : null,
        pendingAssetId: row.pendingAssetId ? String(row.pendingAssetId) : null,
        lifecycleState: row.lifecycleState, activeSlot: row.activeSlot,
      };
    },
    async commitActiveReady({ placementId, assetId }) {
      const row = await placements.findOneAndUpdate(
        { _id: placementId, activeAssetId: assetId, activeSlot: true,
          lifecycleState: { $in: [productVideoLifecycleStateEnum.AWAITING_UPLOAD, productVideoLifecycleStateEnum.PROCESSING, productVideoLifecycleStateEnum.READY] } },
        { $set: { lifecycleState: productVideoLifecycleStateEnum.READY } },
        { new: true },
      );
      return row ? { productId: row.productId } : false;
    },
    async commitTerminalFailure({ placementId, assetId, failureCode }) {
      const result = await withTransaction(async (session) => {
        const asset = await assets.findOne({
          _id: assetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId,
          technicalState: videoAssetTechnicalStateEnum.FAILED,
        }).session(session);
        if (!asset) return null;
        const failedAt = new Date(now());
        const row = await placements.findOneAndUpdate(
          { _id: placementId, activeAssetId: assetId, activeSlot: true,
            lifecycleState: { $in: [productVideoLifecycleStateEnum.AWAITING_UPLOAD, productVideoLifecycleStateEnum.PROCESSING] } },
          { $set: { lifecycleState: productVideoLifecycleStateEnum.FAILED, activeSlot: false, removedAt: failedAt } },
          { session, new: true },
        );
        if (!row) return null;
        const batch = await batches.findById(row.uploadBatchId).session(session);
        await assets.updateOne(
          { _id: asset._id, technicalState: videoAssetTechnicalStateEnum.FAILED },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: failedAt } },
          { session },
        );
        const operation = await recordOperation({
          type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
          libraryId: asset.libraryId, providerGuid: asset.providerGuid,
          dedupeKey: `terminal:${asset._id}`, session,
        });
        await attempts.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id,
          actorId: batch.actorId, assetId: asset._id,
          safeFilename: row.safeFilename,
          stage: videoUploadAttemptStageEnum.PROCESSING, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: failureCode,
          finishedAt: failedAt,
        }], { session });
        return { operationId: String(operation._id), productId: row.productId };
      });
      return result || false;
    },
    async listForProduct({ productId }) {
      const rows = await placements.find({ productId, activeSlot: true })
        .sort({ position: 1 })
        .lean();
      const ids = rows.flatMap((row) => [row.activeAssetId, row.pendingAssetId]).filter(Boolean);
      const assetRows = ids.length
        ? await assets.find({ _id: { $in: ids } })
          .select({ _id: 1, safeFailureCode: 1, technicalState: 1 }).lean()
        : [];
      const assetById = new Map(assetRows.map((asset) => [String(asset._id), asset]));
      const recoveryIds = rows.map(row => row.uploadRecoveryId).filter(Boolean);
      const recoveryRows = recoveryIds.length ? await recoveries.find({ _id: { $in: recoveryIds } })
        .select({ _id: 1, status: 1, failureCode: 1 }).lean() : [];
      const recoveryById = new Map(recoveryRows.map(row => [String(row._id), row]));
      const deletingIds = rows
        .filter((row) => row.lifecycleState === productVideoLifecycleStateEnum.DELETING && row.activeAssetId)
        .map((row) => row.activeAssetId);
      const deletionOperations = deletingIds.length
        ? await operations.find({ assetId: { $in: deletingIds }, type: videoProviderOperationTypeEnum.DELETE,
          status: { $in: [videoProviderOperationStatusEnum.PENDING, videoProviderOperationStatusEnum.RUNNING, videoProviderOperationStatusEnum.NEEDS_ATTENTION] } })
          .sort({ updatedAt: -1 }).select({ assetId: 1, lastErrorCode: 1 }).lean()
        : [];
      const deletionErrorByAssetId = new Map();
      for (const operation of deletionOperations) {
        const key = String(operation.assetId);
        if (!deletionErrorByAssetId.has(key)) {
          deletionErrorByAssetId.set(key, operation.lastErrorCode || null);
        }
      }
      return rows.map((row) => ({
        id: String(row._id), position: row.position,
        lifecycleState: row.lifecycleState,
        showInReelsFeed: row.showInReelsFeed,
        ...(recoveryById.has(String(row.uploadRecoveryId)) ? { recovery: {
          id: String(row.uploadRecoveryId), status: recoveryById.get(String(row.uploadRecoveryId)).status,
          failureCode: recoveryById.get(String(row.uploadRecoveryId)).failureCode || null,
        } } : {}),
        ...(row.replacementId ? { replacement: {
          id: String(row.replacementId),
          status: assetById.get(String(row.pendingAssetId))?.technicalState || videoUploadResponseStatusEnum.RESERVING,
          failureCode: assetById.get(String(row.pendingAssetId))?.safeFailureCode || null,
        } } : {}),
        safeFailureCode: assetById.get(String(row.activeAssetId))?.safeFailureCode ||
          deletionErrorByAssetId.get(String(row.activeAssetId)) || row.replacementFailureCode || null,
      }));
    },
    async getRefreshableUpload({ productId, videoId }) {
      const placement = await placements.findOne({
        _id: videoId, productId, activeSlot: true,
        lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD,
      }).lean();
      if (!placement?.activeAssetId) return null;
      const asset = await assets.findOne({
        _id: placement.activeAssetId,
        ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placement._id,
        technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
        deletionRequestedAt: { $exists: false },
      }).lean();
      if (!asset) return null;
      return {
        productVideoId: String(placement._id), position: placement.position,
        status: placement.lifecycleState, providerGuid: asset.providerGuid,
        uploadUrl: asset.tusUploadUrl, resourceExpiresAt: asset.tusResourceExpiresAt,
        abandonAt: placement.abandonAt,
      };
    },
    async reserveBatch({ productId, actorId, idempotencyKey, files }) {
      const requestFingerprint = fingerprint(files, actorId);
      return withTransaction(async (session) => {
        const existing = await batches.findOne({ productId, idempotencyKey })
          .session(session);
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw videoError("Idempotency key belongs to another request", 409, "VIDEO_UPLOAD_CONFLICT");
          }
          if (existing.status !== productVideoUploadBatchStatusEnum.ISSUED) {
            throw videoError("Upload batch is not available for replay", 409, "VIDEO_UPLOAD_CONFLICT");
          }
          return loadBatch(existing, session);
        }

        // This write is the per-product serialization point. Concurrent
        // transactions reserving slots on the same product conflict here.
        const product = await products.findOneAndUpdate(
          { _id: productId },
          { $inc: { videoNextPosition: files.length } },
          { new: true, session, projection: { videoNextPosition: 1 } },
        );
        if (!product) throw videoError("Product not found", 404, "VIDEO_NOT_AVAILABLE");
        const occupied = await placements.countDocuments({
          productId, activeSlot: true,
        }).session(session);
        if (occupied + files.length > 3) {
          throw videoError("Product Video limit reached", 409, "PRODUCT_VIDEO_LIMIT_REACHED");
        }

        const batchId = new mongoose.Types.ObjectId();
        const firstPosition = product.videoNextPosition - files.length;
        await batches.create([{
          _id: batchId, productId, actorId, idempotencyKey,
          requestFingerprint, status: productVideoUploadBatchStatusEnum.RESERVING,
        }], { session });
        const rows = await placements.insertMany(files.map((file, index) => ({
          productId,
          position: firstPosition + index,
          uploadBatchId: batchId,
          clientId: file.clientId,
          safeFilename: file.filename,
          showInReelsFeed: file.showInReelsFeed ?? true,
          lifecycleState: productVideoLifecycleStateEnum.RESERVING,
        })), { session });
        return {
          status: productVideoUploadBatchStatusEnum.RESERVING,
          placements: rows.map((row) => ({
            id: String(row._id), clientId: row.clientId,
            position: row.position, providerGuid: null,
          })),
        };
      });
    },

    async attachProviderVideo({ placementId, providerGuid }) {
      return withTransaction(async (session) => {
        const placement = await placements.findOne({
          _id: placementId, lifecycleState: productVideoLifecycleStateEnum.RESERVING, removedAt: { $exists: false },
        }).session(session);
        if (!placement || placement.activeAssetId) {
          throw videoError("Product Video upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        const batch = await batches.findOne({
          _id: placement.uploadBatchId, status: productVideoUploadBatchStatusEnum.RESERVING,
        }).session(session);
        if (!batch) throw videoError("Upload batch changed", 409, "VIDEO_UPLOAD_CONFLICT");
        const [asset] = await assets.create([{
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placement._id,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
        }], { session });
        const updated = await placements.findOneAndUpdate(
          { _id: placement._id, activeAssetId: { $exists: false }, lifecycleState: productVideoLifecycleStateEnum.RESERVING },
          { $set: { activeAssetId: asset._id } },
          { session, new: true },
        );
        if (!updated) throw videoError("Product Video upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        return String(asset._id);
      });
    },

    async markBatchIssued({ productId, idempotencyKey }) {
      return withTransaction(async (session) => {
        const batch = await batches.findOne({ productId, idempotencyKey }).session(session);
        if (!batch || batch.status !== productVideoUploadBatchStatusEnum.RESERVING) {
          throw videoError("Upload batch changed", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        const rows = await placements.find({ uploadBatchId: batch._id })
          .session(session);
        if (!rows.length || rows.some((row) => !row.activeAssetId || row.removedAt)) {
          throw videoError("Upload batch is incomplete", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        for (const row of rows) {
          const asset = await assets.findOne({ _id: row.activeAssetId, ownerId: row._id,
            ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
            deletionRequestedAt: { $exists: false } }).session(session);
          if (!asset || !isBunnyTusUploadUrl(asset.tusUploadUrl) ||
              !Number.isSafeInteger(asset.tusResourceExpiresAt) || asset.tusResourceExpiresAt <= Math.floor(now() / 1000)) {
            throw videoError("Upload resource is not ready", 409, "VIDEO_UPLOAD_CONFLICT");
          }
        }
        const issuedAt = new Date(now());
        await placements.updateMany(
          { uploadBatchId: batch._id, lifecycleState: productVideoLifecycleStateEnum.RESERVING },
          { $set: {
            lifecycleState: productVideoLifecycleStateEnum.AWAITING_UPLOAD, uploadSessionIssuedAt: issuedAt,
            abandonAt: new Date(issuedAt.getTime() + DAY_MS),
          } },
          { session },
        );
        await attempts.insertMany(rows.map((row) => ({
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id,
          actorId: batch.actorId, assetId: row.activeAssetId,
          safeFilename: row.safeFilename, stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED,
          finishedAt: issuedAt,
        })), { session });
        await batches.updateOne(
          { _id: batch._id, status: productVideoUploadBatchStatusEnum.RESERVING },
          { $set: { status: productVideoUploadBatchStatusEnum.ISSUED, issuedAt } },
          { session },
        );
      });
    },

    async attachTusUpload({ placementId, providerGuid, uploadUrl, resourceExpiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl) || !Number.isSafeInteger(resourceExpiresAt) ||
          resourceExpiresAt <= Math.floor(now() / 1000)) throw videoError("Invalid upload resource", 409, "VIDEO_UPLOAD_CONFLICT");
      return withTransaction(async (session) => {
        const row = await placements.findOne({ _id: placementId, activeSlot: true,
          lifecycleState: productVideoLifecycleStateEnum.RESERVING, removedAt: { $exists: false } }).session(session);
        if (!row?.activeAssetId) throw videoError("Upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        const batch = await batches.findOne({ _id: row.uploadBatchId, status: productVideoUploadBatchStatusEnum.RESERVING }).session(session);
        if (!batch) throw videoError("Upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
        const changed = await assets.findOneAndUpdate({ _id: row.activeAssetId, libraryId, providerGuid,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
          deletionRequestedAt: { $exists: false }, tusUploadUrl: { $exists: false } },
        { $set: { tusUploadUrl: uploadUrl, tusResourceExpiresAt: resourceExpiresAt } }, { session, new: true });
        if (!changed) throw videoError("Upload changed", 409, "VIDEO_UPLOAD_CONFLICT");
      });
    },

    async failBatch({ productId, idempotencyKey, createdVideos }) {
      const operationIds = await withTransaction(async (session) => {
        const batch = await batches.findOne({ productId, idempotencyKey }).session(session);
        if (!batch || batch.status === productVideoUploadBatchStatusEnum.ISSUED) {
          throw videoError("Issued upload batch cannot be cancelled", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        const failedAt = new Date(now());
        const ids = [];
        const uniqueVideos = new Map(createdVideos.map((video) => [video.providerGuid, video]));
        for (const { placementId, providerGuid } of uniqueVideos.values()) {
          let asset = await assets.findOne({ libraryId, providerGuid }).session(session);
          if (!asset) {
            [asset] = await assets.create([{
              ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId,
              libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETING,
              deletionRequestedAt: failedAt,
            }], { session });
          } else {
            if (asset.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO || String(asset.ownerId) !== String(placementId)) {
              throw new Error("VIDEO_BATCH_UNEXPECTED_ASSET");
            }
            await assets.updateOne(
              { _id: asset._id, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placementId },
              { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: failedAt } },
              { session },
            );
          }
          const operation = await recordOperation({
            type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
            libraryId, providerGuid,
            dedupeKey: `batch-failed:${batch._id}:${providerGuid}`,
            session,
          });
          ids.push(String(operation._id));
        }
        await placements.updateMany(
          { uploadBatchId: batch._id, removedAt: { $exists: false } },
          { $set: { lifecycleState: productVideoLifecycleStateEnum.FAILED, activeSlot: false, removedAt: failedAt } },
          { session },
        );
        await batches.updateOne(
          { _id: batch._id },
          { $set: {
            status: productVideoUploadBatchStatusEnum.FAILED, failedAt, failureCode: "VIDEO_PROVIDER_UNAVAILABLE",
          } },
          { session },
        );
        return ids;
      });
      return { operationIds };
    },
  });
}
