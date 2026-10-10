import { createHash } from "node:crypto";
import mongoose from "mongoose";

import { ApiError } from "../../../shared/utils/ApiError.js";
import {
  roles,
  editorialVideoKindEnum,
  editorialVideoStatusEnum,
  editorialReviewStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  reelUploadSessionStatusEnum,
  reelUploadPurposeEnum,
  videoProviderOperationTypeEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
} from "../../../shared/constants/enums.js";
import { EditorialVideoModel } from "../editorial/editorialVideo.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { ReelUploadSessionModel } from "./reelUploadSession.model.js";
import { VideoUploadAttemptModel } from "../provider/videoUploadAttempt.model.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";
import { createReelUploadRecoveryPersistence } from "./reelUploadRecovery.repository.js";
import { reelUploadBinding, isCurrentReelUpload } from "./reelUploadBinding.js";
import { createEditorialCoverReferencePersistence } from "../editorial/editorialCover.repository.js";
import { ReelResourceRecoveryModel } from "./reelResourceRecovery.model.js";
import { VideoProviderOperationModel } from "../provider/videoProviderOperation.model.js";
import { createReelResourceRecoveryPersistence } from "./reelResourceRecovery.repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function conflict() {
  return new ApiError("Reel upload changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
}

function fingerprint(actorId, file) {
  return createHash("sha256").update(JSON.stringify({ actorId: String(actorId),
    filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes })).digest("hex");
}

export function createReelUploadRepository({ libraryId, connection = mongoose,
  videos = EditorialVideoModel, assets = VideoAssetModel,
  sessions = ReelUploadSessionModel, attempts = VideoUploadAttemptModel,
  recoveries = ReelResourceRecoveryModel, operations = VideoProviderOperationModel,
  recordOperation = recordVideoProviderOperation,
  now = Date.now,
  coverReferences = createEditorialCoverReferencePersistence({ videos, recordOperation }) } = {}) {
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

  async function loadSessionContext({ videoId, sessionId, actor, purpose = reelUploadPurposeEnum.INITIAL }, session) {
    const video = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL,
      ...(purpose === reelUploadPurposeEnum.INITIAL && actor.role === roles.ADMIN ? { authorId: actor.id } : {}) }).session(session);
    if (!video) throw new ApiError("Reel upload not found", 404,
      [{ code: "VIDEO_UPLOAD_NOT_FOUND" }]);
    const selectedId = sessionId || (purpose === reelUploadPurposeEnum.REPLACEMENT
      ? video.pendingChange?.uploadSessionId : video.activeUploadSessionId);
    const row = selectedId
      ? await sessions.findOne({ _id: selectedId, videoId }).session(session)
      : await sessions.findOne({ videoId,
        purpose: purpose === reelUploadPurposeEnum.REPLACEMENT ? reelUploadPurposeEnum.REPLACEMENT : { $ne: reelUploadPurposeEnum.REPLACEMENT },
        ...(purpose === reelUploadPurposeEnum.REPLACEMENT && actor.role === roles.ADMIN ? { actorId: actor.id } : {}),
      }).sort({ createdAt: -1, _id: -1 }).session(session);
    if (selectedId && !row) throw conflict();
    if (row && ((row.purpose || reelUploadPurposeEnum.INITIAL) !== purpose ||
        (purpose === reelUploadPurposeEnum.REPLACEMENT && actor.role === roles.ADMIN && String(row.actorId) !== String(actor.id)))) {
      throw conflict();
    }
    const asset = row?.assetId ? await assets.findOne({ _id: row.assetId,
      ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId, libraryId }).session(session) : null;
    if (purpose === reelUploadPurposeEnum.INITIAL && row && String(video.activeUploadSessionId) === String(row._id) &&
        (row.assetId ? !asset || String(video.activeAssetId) !== String(row.assetId)
          : video.activeAssetId)) throw conflict();
    const isCurrent = Boolean(isCurrentReelUpload(video, row) && (!row.assetId || asset));
    const recovery = isCurrent && row.uploadRecoveryId ? await recoveries.findOne({ _id: row.uploadRecoveryId,
      sessionId: row._id }).select({ _id: 1, status: 1, failureCode: 1 }).session(session).lean() : null;
    return { video, row, asset, isCurrent, ...(recovery ? { recovery: {
      id: String(recovery._id), status: recovery.status, failureCode: recovery.failureCode || null,
    } } : {}) };
  }

  return Object.freeze({
    ...createReelUploadRecoveryPersistence({ libraryId, videos, sessions, recoveries, assets,
      attempts, withTransaction, recordOperation, now, coverReferences }),
    ...createReelResourceRecoveryPersistence({ libraryId, videos, sessions, assets, recoveries,
      operations, attempts, withTransaction, recordOperation, now, loadSessionContext }),
    async getSessionContext(input) {
      return withTransaction(session => loadSessionContext(input, session));
    },
    async reserve({ videoId, actor, idempotencyKey, file, purpose = reelUploadPurposeEnum.INITIAL }) {
      const requestFingerprint = fingerprint(actor.id, file);
      let retriedDuplicate = false;
      while (true) {
        try {
          return await withTransaction(async (session) => {
            const existing = await sessions.findOne({ videoId, idempotencyKey }).session(session);
            if (existing) {
              if (existing.requestFingerprint !== requestFingerprint ||
                  String(existing.actorId) !== String(actor.id) ||
                  (existing.purpose || reelUploadPurposeEnum.INITIAL) !== purpose) throw conflict();
              if (existing.status === reelUploadSessionStatusEnum.RESERVING) {
                return { id: String(existing._id), status: reelUploadSessionStatusEnum.RESERVING, newlyCreated: false };
              }
              if (existing.status !== reelUploadSessionStatusEnum.ISSUED || !existing.assetId ||
                  !(existing.abandonAt instanceof Date) || existing.abandonAt.getTime() <= now()) {
                throw conflict();
              }
              const video = await videos.findOne({ ...reelUploadBinding(existing).filter,
                ...(purpose === reelUploadPurposeEnum.INITIAL && actor.role === roles.ADMIN ? { authorId: actor.id } : {}) }).session(session);
              if (!video) throw conflict();
              const asset = await assets.findOne({ _id: existing.assetId, ownerType: videoAssetOwnerTypeEnum.REEL,
                ownerId: videoId, libraryId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
                deletionRequestedAt: { $exists: false } }).session(session);
              if (!asset || !isBunnyTusUploadUrl(asset.tusUploadUrl)) throw conflict();
              return { id: String(existing._id), status: reelUploadSessionStatusEnum.ISSUED,
                providerGuid: asset.providerGuid, uploadUrl: asset.tusUploadUrl,
                resourceExpiresAt: asset.tusResourceExpiresAt, abandonAt: existing.abandonAt };
            }

            const reservationId = new mongoose.Types.ObjectId();
            const providerTitle = `petyard-reel-session:${reservationId}`;
            if (purpose === reelUploadPurposeEnum.REPLACEMENT) {
              const current = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL,
                status: { $in: [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED] }, activeAssetId: { $exists: true } }).session(session);
              if (!current || (current.pendingChange &&
                  (String(current.pendingChange.authorId) !== String(actor.id) ||
                    ![editorialReviewStatusEnum.DRAFT, editorialReviewStatusEnum.REJECTED].includes(current.pendingChange.status) ||
                    current.pendingChange.uploadSessionId || current.pendingChange.assetId))) throw conflict();
              const previousAsset = await assets.findOne({ _id: current.activeAssetId, ownerType: videoAssetOwnerTypeEnum.REEL,
                ownerId: videoId, libraryId, technicalState: videoAssetTechnicalStateEnum.READY, providerStatus: 4,
                deletionRequestedAt: { $exists: false } }).session(session);
              if (!previousAsset) throw conflict();
              const pending = current.pendingChange?.toObject?.() ?? current.pendingChange;
              const content = pending?.content ?? { kind: editorialVideoKindEnum.REEL, title_en: current.title_en,
                title_ar: current.title_ar, description_en: current.description_en, description_ar: current.description_ar,
                ...(current.activeCoverId !== undefined ? { coverId: current.activeCoverId } : {}) };
              const updated = await videos.findOneAndUpdate({ _id: videoId, revision: current.revision,
                activeAssetId: current.activeAssetId }, { $set: { pendingChange: {
                  ...pending, authorId: actor.id, status: editorialReviewStatusEnum.DRAFT, content,
                  uploadSessionId: reservationId, autoApplyWhenReady: actor.role === roles.SUPER_ADMIN,
                  createdAt: pending?.createdAt ?? new Date(now()), updatedAt: new Date(now()),
                  reviewReason: null, reviewedAt: null, submittedAt: null,
                } }, $inc: { revision: 1 } }, { session, new: true, runValidators: true });
              if (!updated) throw conflict();
              await sessions.create([{ _id: reservationId, videoId, actorId: actor.id, purpose,
                previousAssetId: current.activeAssetId, autoApplyWhenReady: actor.role === roles.SUPER_ADMIN,
                idempotencyKey, requestFingerprint, safeFilename: file.filename,
                mimeType: file.mimeType, sizeBytes: file.sizeBytes, status: reelUploadSessionStatusEnum.RESERVING, providerTitle }], { session });
              return { id: String(reservationId), status: reelUploadSessionStatusEnum.RESERVING, newlyCreated: true, providerTitle };
            }
            const ownerFilter = actor.role === roles.ADMIN ? { authorId: actor.id } : {};
            const updated = await videos.findOneAndUpdate({ _id: videoId, kind: editorialVideoKindEnum.REEL,
              status: editorialVideoStatusEnum.DRAFT, activeAssetId: { $exists: false },
              activeUploadSessionId: { $exists: false }, ...ownerFilter },
            { $set: { activeUploadSessionId: reservationId }, $inc: { revision: 1 } },
            { session, new: true });
            if (!updated) throw conflict();
            await sessions.create([{ _id: reservationId, videoId, actorId: actor.id,
              idempotencyKey, requestFingerprint, safeFilename: file.filename,
              mimeType: file.mimeType, sizeBytes: file.sizeBytes, status: reelUploadSessionStatusEnum.RESERVING,
              providerTitle }], { session });
            return { id: String(reservationId), status: reelUploadSessionStatusEnum.RESERVING, newlyCreated: true,
              providerTitle };
          });
        } catch (error) {
          // A same-key concurrent insert can win while this transaction is
          // committing. Retry once to observe its issued/reserving state.
          if (error?.code === 11000 && !retriedDuplicate) {
            retriedDuplicate = true;
            continue;
          }
          throw error;
        }
      }
    },

    async attachProviderVideo({ sessionId, videoId, providerGuid }) {
      return withTransaction(async (session) => {
        const row = await sessions.findOne({ _id: sessionId, videoId, status: reelUploadSessionStatusEnum.RESERVING,
          assetId: { $exists: false } }).session(session);
        if (!row) throw conflict();
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD }], { session });
        const binding = reelUploadBinding(row);
        const attached = await videos.findOneAndUpdate(binding.filter,
        { $set: { [binding.assetPath]: asset._id }, $inc: { revision: 1 } }, { session, new: true });
        if (!attached) throw conflict();
        const recorded = await sessions.updateOne({ _id: sessionId, status: reelUploadSessionStatusEnum.RESERVING,
          assetId: { $exists: false } }, { $set: { assetId: asset._id } }, { session });
        if (recorded.modifiedCount !== 1) throw conflict();
        return String(asset._id);
      });
    },

    async issue({ sessionId, videoId, providerGuid, uploadUrl, resourceExpiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl) || !Number.isSafeInteger(resourceExpiresAt) ||
          resourceExpiresAt <= Math.floor(now() / 1000)) throw conflict();
      return withTransaction(async (session) => {
        const row = await sessions.findOne({ _id: sessionId, videoId, status: reelUploadSessionStatusEnum.RESERVING,
          assetId: { $exists: true } }).session(session);
        if (!row) throw conflict();
        const video = await videos.findOne(reelUploadBinding(row).filter).session(session);
        if (!video) throw conflict();
        const asset = await assets.findOneAndUpdate({ _id: row.assetId,
          ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId, libraryId, providerGuid,
          technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD, deletionRequestedAt: { $exists: false },
          tusUploadUrl: { $exists: false } },
        { $set: { tusUploadUrl: uploadUrl, tusResourceExpiresAt: resourceExpiresAt } },
        { session, new: true });
        if (!asset) throw conflict();
        const issuedAt = new Date(now());
        const abandonAt = new Date(issuedAt.getTime() + DAY_MS);
        const changed = await sessions.updateOne({ _id: sessionId, status: reelUploadSessionStatusEnum.RESERVING },
          { $set: { status: reelUploadSessionStatusEnum.ISSUED, issuedAt, abandonAt } }, { session });
        if (changed.modifiedCount !== 1) throw conflict();
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
          actorId: row.actorId, assetId: row.assetId, safeFilename: row.safeFilename,
          stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED, finishedAt: issuedAt }], { session });
        return { providerGuid, uploadUrl, resourceExpiresAt, abandonAt };
      });
    },

    async failSetup({ sessionId, videoId, providerGuid }) {
      const operationId = await withTransaction(async (session) => {
        const row = await sessions.findOne({ _id: sessionId, videoId }).session(session);
        if (!row || row.status === reelUploadSessionStatusEnum.ISSUED) throw conflict();
        // A stale-setup sweep may have failed the reservation while Bunny's
        // create request was still in flight. Its late GUID still needs a
        // durable deletion obligation, without touching a newer upload.
        if (row.status === reelUploadSessionStatusEnum.FAILED && !providerGuid) return null;
        const failedAt = new Date(now());
        let operation = null;
        if (providerGuid) {
          let asset = row.assetId
            ? await assets.findOne({ _id: row.assetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
              libraryId, providerGuid }).session(session)
            : await assets.findOne({ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
              libraryId, providerGuid }).session(session);
          if (row.assetId && !asset) throw conflict();
          // A returned GUID is not proof that an existing asset belongs to this
          // unbound reservation. Never compensate by deleting referenced media.
          if (asset && !row.assetId && !asset.deletionRequestedAt &&
              await videos.findOne({ kind: editorialVideoKindEnum.REEL, $or: [{ activeAssetId: asset._id },
                { "pendingChange.assetId": asset._id }] }).session(session)) throw conflict();
          const needsOperation = !asset?.deletionRequestedAt;
          if (!asset) {
            [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
              libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETING,
              deletionRequestedAt: failedAt }], { session });
          } else if (!asset.deletionRequestedAt) {
            await assets.updateOne({ _id: asset._id },
              { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: failedAt } }, { session });
          }
          if (needsOperation) {
            operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP,
              assetId: asset._id, libraryId, providerGuid,
              dedupeKey: `reel-setup-failed:${sessionId}:${providerGuid}`, session });
          }
        }
        if (row.status === reelUploadSessionStatusEnum.FAILED) return operation ? String(operation._id) : null;
        const binding = reelUploadBinding(row);
        const detached = await videos.updateOne(binding.filter,
        { $unset: binding.unset,
          $inc: { revision: 1 } }, { session });
        if (detached.modifiedCount !== 1) throw conflict();
        const failed = await sessions.updateOne({ _id: sessionId, status: reelUploadSessionStatusEnum.RESERVING },
          { $set: { status: reelUploadSessionStatusEnum.FAILED, failedAt, failureCode: "VIDEO_PROVIDER_UNAVAILABLE" } }, { session });
        if (failed.modifiedCount !== 1) throw conflict();
        return operation ? String(operation._id) : null;
      });
      return { operationId };
    },
  });
}
