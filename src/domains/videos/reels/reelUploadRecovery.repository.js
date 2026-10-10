// Worker-only recovery. Every provider deletion has a durable Mongo obligation;
// enqueueing happens after the transaction and may be retried by the sweep.
import { ApiError } from "../../../shared/utils/ApiError.js";
import {
  roles,
  editorialVideoKindEnum,
  editorialVideoStatusEnum,
  editorialReviewStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  reelUploadSessionStatusEnum,
  videoUploadRecoveryStatusEnum,
  reelUploadPurposeEnum,
  videoProviderOperationTypeEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
} from "../../../shared/constants/enums.js";
import { reelUploadBinding, isCurrentReelUpload } from "./reelUploadBinding.js";

export function createReelUploadRecoveryPersistence({
  libraryId, videos, sessions, recoveries, assets, attempts, withTransaction,
  recordOperation, now, coverReferences,
}) {
  async function failCurrent({ row, asset, failureCode, stage, session, finishedAt, outcome = videoUploadAttemptOutcomeEnum.FAILED,
    removeProposal = false, expectedRevision }) {
    const binding = reelUploadBinding(row);
    const detached = await videos.updateOne({ ...binding.filter,
      ...(expectedRevision === undefined ? {} : { revision: expectedRevision }) },
    removeProposal ? { $set: { pendingChange: null }, $inc: { revision: 1 } } : { $unset: binding.unset,
      ...(row.purpose === reelUploadPurposeEnum.REPLACEMENT ? { $set: { "pendingChange.status": editorialReviewStatusEnum.DRAFT,
        "pendingChange.submittedAt": null, "pendingChange.reviewReason": null } } : {}),
      $inc: { revision: 1 } }, { session });
    if (detached.modifiedCount !== 1) return null;

    let operationId = null;
    if (asset && !asset.deletionRequestedAt) {
      const changed = await assets.updateOne({ _id: asset._id, ownerType: videoAssetOwnerTypeEnum.REEL,
        ownerId: row.videoId, libraryId, providerGuid: asset.providerGuid,
        technicalState: asset.technicalState,
        deletionRequestedAt: { $exists: false } },
      { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: finishedAt,
        safeFailureCode: failureCode } }, { session });
      if (changed.modifiedCount !== 1) throw new Error("REEL_RECOVERY_ASSET_CHANGED");
      const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP,
        assetId: asset._id, libraryId, providerGuid: asset.providerGuid,
        dedupeKey: `reel-recovery:${row._id}:${asset._id}`, session });
      operationId = String(operation._id);
    }
    const failed = await sessions.updateOne({ _id: row._id, videoId: row.videoId,
      status: row.status, ...(row.assetId ? { assetId: row.assetId } : {}) },
    { $set: { status: reelUploadSessionStatusEnum.FAILED, failedAt: finishedAt, failureCode },
      $unset: { uploadRecoveryId: "" } }, { session });
    if (failed.modifiedCount !== 1) throw new Error("REEL_RECOVERY_SESSION_CHANGED");
    await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
      actorId: row.actorId, ...(asset ? { assetId: asset._id } : {}),
      safeFilename: row.safeFilename, stage, outcome,
      errorCode: failureCode, finishedAt }], { session });
    return { operationId };
  }

  async function cleanupPendingChange({ video, session, removeProposal, failureCode, finishedAt }) {
    const pending = video.pendingChange;
    const row = await sessions.findOne({ _id: pending.uploadSessionId, videoId: video._id,
      actorId: pending.authorId, purpose: reelUploadPurposeEnum.REPLACEMENT, previousAssetId: video.activeAssetId,
      status: { $in: [reelUploadSessionStatusEnum.RESERVING, reelUploadSessionStatusEnum.ISSUED] }, appliedAt: { $exists: false } }).session(session);
    if (!row || !isCurrentReelUpload(video, row)) {
      throw new ApiError("Reel replacement changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
    }
    const asset = row.assetId ? await assets.findOne({ _id: row.assetId, ownerType: videoAssetOwnerTypeEnum.REEL,
      ownerId: video._id, libraryId, $or: [
        { technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.PROCESSING, videoAssetTechnicalStateEnum.READY, videoAssetTechnicalStateEnum.FAILED] }, deletionRequestedAt: { $exists: false } },
        { technicalState: { $in: [videoAssetTechnicalStateEnum.DELETING, videoAssetTechnicalStateEnum.DELETED] }, deletionRequestedAt: { $exists: true } },
      ] }).session(session) : null;
    if (row.assetId && !asset) throw new ApiError("Reel replacement changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
    const result = await failCurrent({ row, asset, failureCode, stage: videoUploadAttemptStageEnum.CLEANUP, session,
      finishedAt, removeProposal, expectedRevision: video.revision,
      outcome: removeProposal ? videoUploadAttemptOutcomeEnum.CANCELLED : videoUploadAttemptOutcomeEnum.FAILED });
    if (!result) throw new ApiError("Video changed concurrently", 409, [{ code: "VIDEO_STATE_CONFLICT" }]);
    if (removeProposal && pending.content?.coverId) {
      const updated = await videos.findOne({ _id: video._id }).session(session);
      result.coverOperationIds = await coverReferences.sync({ before: video, after: updated,
        session, now: finishedAt });
    }
    if (asset && await videos.findOne({ kind: editorialVideoKindEnum.REEL, $or: [{ activeAssetId: asset._id },
      { "pendingChange.assetId": asset._id }] }).session(session)) {
      throw new ApiError("Reel asset remains referenced", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
    }
    return result;
  }

  return {
    async cancelPendingChange({ videoId, expectedRevision, sessionId, assetId, actor }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw new ApiError("Not allowed to cancel this change", 403, [{ code: "VIDEO_FORBIDDEN" }]);
      }
      const result = await withTransaction(async (session) => {
        const video = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL, revision: expectedRevision,
          status: { $in: [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED] },
          "pendingChange.uploadSessionId": sessionId,
          "pendingChange.assetId": assetId || { $exists: false },
          "pendingChange.status": { $in: Object.values(editorialReviewStatusEnum) } }).session(session);
        if (!video) return null;
        if (actor.role === roles.ADMIN && String(actor.id) !== String(video.pendingChange.authorId)) {
          throw new ApiError("Not allowed to cancel this change", 403, [{ code: "VIDEO_FORBIDDEN" }]);
        }
        const cleaned = await cleanupPendingChange({ video, session, removeProposal: true,
          failureCode: "VIDEO_UPLOAD_CANCELLED", finishedAt: new Date(now()) });
        return { ...cleaned, video: await videos.findOne({ _id: videoId }).session(session) };
      });
      return result;
    },
    async recoverRejectedChanges({ before, limit }) {
      if (!(before instanceof Date) || !Number.isFinite(before.getTime()) ||
          !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Invalid rejected Reel recovery bounds");
      const due = { kind: editorialVideoKindEnum.REEL, status: { $in: [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED] },
        "pendingChange.status": { $in: [editorialReviewStatusEnum.DRAFT, editorialReviewStatusEnum.REJECTED] },
        "pendingChange.assetId": { $exists: true }, "pendingChange.uploadSessionId": { $exists: true },
        $or: [{ "pendingChange.rejectedAssetExpiresAt": { $lte: before } },
          { "pendingChange.rejectedAssetExpiresAt": { $exists: false },
            "pendingChange.reviewedAt": { $lte: new Date(before.getTime() - 7 * 24 * 60 * 60_000) } }] };
      const candidates = await videos.find(due).sort({ "pendingChange.rejectedAssetExpiresAt": 1, _id: 1 }).limit(limit).lean();
      const summary = { examined: candidates.length, recovered: 0, failed: 0, operationIds: [] };
      for (const candidate of candidates) {
        try {
          const result = await withTransaction(async (session) => {
            const video = await videos.findOne({ ...due, _id: candidate._id, revision: candidate.revision,
              activeAssetId: candidate.activeAssetId,
              "pendingChange.assetId": candidate.pendingChange.assetId,
              "pendingChange.uploadSessionId": candidate.pendingChange.uploadSessionId }).session(session);
            if (!video) return null;
            return cleanupPendingChange({ video, session, removeProposal: false,
              failureCode: "VIDEO_REJECTED_ASSET_EXPIRED", finishedAt: before });
          });
          if (!result) continue;
          summary.recovered += 1;
          summary.operationIds.push(result.operationId, ...(result.coverOperationIds ?? []));
        } catch { summary.failed += 1; }
      }
      return summary;
    },
    async cancelUpload({ videoId, sessionId, actor, purpose = reelUploadPurposeEnum.INITIAL }) {
      const result = await withTransaction(async (session) => {
        const video = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL,
          ...(purpose === reelUploadPurposeEnum.INITIAL && actor.role === roles.ADMIN ? { authorId: actor.id } : {}) }).session(session);
        if (!video) throw new ApiError("Reel upload not found", 404,
          [{ code: "VIDEO_UPLOAD_NOT_FOUND" }]);
        const row = await sessions.findOne({ _id: sessionId, videoId }).session(session);
        if (row && ((row.purpose || reelUploadPurposeEnum.INITIAL) !== purpose ||
            (purpose === reelUploadPurposeEnum.REPLACEMENT && actor.role === roles.ADMIN && String(row.actorId) !== String(actor.id)))) {
          throw new ApiError("Reel upload changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
        }
        if (row?.status === reelUploadSessionStatusEnum.FAILED && row.failureCode === "VIDEO_UPLOAD_CANCELLED") return {};
        if (!row || ![reelUploadSessionStatusEnum.RESERVING, reelUploadSessionStatusEnum.ISSUED].includes(row.status) ||
            (purpose === reelUploadPurposeEnum.INITIAL && video.status !== editorialVideoStatusEnum.DRAFT) || !isCurrentReelUpload(video, row)) {
          throw new ApiError("Reel upload changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
        }
        const asset = row.assetId ? await assets.findOne({ _id: row.assetId,
          ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId, libraryId,
          $or: [{ technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.PROCESSING, videoAssetTechnicalStateEnum.FAILED, ...(purpose === reelUploadPurposeEnum.REPLACEMENT ? [videoAssetTechnicalStateEnum.READY] : [])] },
            deletionRequestedAt: { $exists: false } },
          { technicalState: { $in: [videoAssetTechnicalStateEnum.DELETING, videoAssetTechnicalStateEnum.DELETED] }, deletionRequestedAt: { $exists: true } }] }).session(session) : null;
        if (row.assetId && !asset) {
          throw new ApiError("Reel upload changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
        }
        const changed = await failCurrent({ row, asset, failureCode: "VIDEO_UPLOAD_CANCELLED",
          stage: row.status === reelUploadSessionStatusEnum.RESERVING ? videoUploadAttemptStageEnum.SESSION : videoUploadAttemptStageEnum.UPLOAD, outcome: videoUploadAttemptOutcomeEnum.CANCELLED,
          session, finishedAt: new Date(now()) });
        if (!changed) throw new ApiError("Reel upload changed", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
        return changed;
      });
      return result;
    },
    async getOrphanSearchContext(sessionId) {
      const row = await sessions.findOne({ _id: sessionId, status: reelUploadSessionStatusEnum.FAILED,
        assetId: { $exists: false }, providerTitle: { $exists: true } }).lean();
      return row ? { id: String(row._id), videoId: String(row.videoId),
        providerTitle: row.providerTitle, createdAt: row.createdAt,
        failedAt: row.failedAt } : null;
    },
    async listOrphanRecoveryCandidates({ before, limit }) {
      const due = { updatedAt: { $lte: before } };
      const query = modelQuery => modelQuery.sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const [initial, recovery] = await Promise.all([
        query(sessions.find({ status: reelUploadSessionStatusEnum.FAILED,
          assetId: { $exists: false }, issuedAt: { $exists: false },
          providerTitle: { $exists: true }, ...due })),
        query(recoveries.find({ status: videoUploadRecoveryStatusEnum.FAILED,
          assetId: { $exists: false }, ...due })),
      ]);
      return [
        ...initial.map(row => ({ target: { sessionId: String(row._id) }, updatedAt: row.updatedAt })),
        ...recovery.map(row => ({ target: { sessionId: String(row.sessionId), recoveryId: String(row._id) }, updatedAt: row.updatedAt })),
      ].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit);
    },
    async claimOrphanRecoveryCandidate({ target, updatedAt, claimedAt }) {
      const model = target.recoveryId ? recoveries : sessions;
      const filter = target.recoveryId ? { _id: target.recoveryId, sessionId: target.sessionId,
        status: videoUploadRecoveryStatusEnum.FAILED, assetId: { $exists: false } } : {
        _id: target.sessionId, status: reelUploadSessionStatusEnum.FAILED,
        assetId: { $exists: false }, issuedAt: { $exists: false }, providerTitle: { $exists: true },
      };
      const result = await model.updateOne({ ...filter, updatedAt },
        { $set: { updatedAt: claimedAt } }, { timestamps: false });
      return result.modifiedCount === 1;
    },
    async isGuidTracked(providerGuid) {
      return Boolean(await assets.exists({ libraryId, providerGuid }));
    },
    async commitOrphanCleanup({ sessionId, providerGuid }) {
      if (typeof sessionId !== "string" || !/^[a-f\d]{24}$/i.test(sessionId) ||
          typeof providerGuid !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(providerGuid)) {
        throw new TypeError("Invalid Reel orphan cleanup identity");
      }
      const operationId = await withTransaction(async (session) => {
        const row = await sessions.findOne({ _id: sessionId, status: reelUploadSessionStatusEnum.FAILED,
          assetId: { $exists: false },
          providerTitle: `petyard-reel-session:${sessionId.toLowerCase()}` }).session(session);
        if (!row) return null;
        // The unique library/GUID index is the final race guard if another
        // transaction attaches this Bunny object after the read.
        if (await assets.findOne({ libraryId, providerGuid }).session(session)) return null;
        const requestedAt = new Date(now());
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETING,
          deletionRequestedAt: requestedAt,
          safeFailureCode: "VIDEO_UPLOAD_SETUP_EXPIRED" }], { session });
        const attached = await sessions.updateOne({ _id: row._id, status: reelUploadSessionStatusEnum.FAILED,
          assetId: { $exists: false }, providerTitle: row.providerTitle },
        { $set: { assetId: asset._id } }, { session });
        if (attached.modifiedCount !== 1) throw new Error("REEL_ORPHAN_SESSION_CHANGED");
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP,
          assetId: asset._id, libraryId, providerGuid,
          dedupeKey: `reel-orphan:${row._id}:${providerGuid}`, session });
        return String(operation._id);
      });
      return operationId ? { operationId } : false;
    },
    async recoverStaleSetups({ before, limit }) {
      const candidates = await sessions.find({ status: reelUploadSessionStatusEnum.RESERVING, updatedAt: { $lte: before } })
        .sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const summary = { examined: candidates.length, recovered: 0, failed: 0, operationIds: [] };
      for (const candidate of candidates) {
        try {
          const result = await withTransaction(async (session) => {
            const row = await sessions.findOne({ _id: candidate._id, status: reelUploadSessionStatusEnum.RESERVING,
              updatedAt: { $lte: before } }).session(session);
            if (!row) return null;
            const asset = row.assetId ? await assets.findOne({ _id: row.assetId,
              ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: row.videoId, libraryId,
              technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.FAILED] },
              deletionRequestedAt: { $exists: false } }).session(session) : null;
            if (row.assetId && !asset) throw new Error("REEL_RECOVERY_ASSET_MISSING");
            return failCurrent({ row, asset, failureCode: "VIDEO_UPLOAD_SETUP_EXPIRED",
              stage: videoUploadAttemptStageEnum.SESSION, session, finishedAt: new Date(now()) });
          });
          if (!result) continue;
          summary.recovered += 1;
          summary.operationIds.push(result.operationId, ...(result.coverOperationIds ?? []));
        } catch { summary.failed += 1; }
      }
      return summary;
    },
    async commitTerminalFailure({ assetId, videoId, failureCode }) {
      const result = await withTransaction(async (session) => {
        const row = await sessions.findOne({ videoId, assetId, status: reelUploadSessionStatusEnum.ISSUED }).session(session);
        if (!row) return null;
        const asset = await assets.findOne({ _id: assetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
          libraryId, technicalState: videoAssetTechnicalStateEnum.FAILED, deletionRequestedAt: { $exists: false } }).session(session);
        if (!asset) return null;
        return failCurrent({ row, asset, failureCode, stage: videoUploadAttemptStageEnum.PROCESSING,
          session, finishedAt: new Date(now()) });
      });
      return result || false;
    },
    async commitMissingUpload({ assetId, videoId, providerGuid, requireStatusZero = false }) {
      const result = await withTransaction(async (session) => {
        const finishedAt = new Date(now());
        const row = await sessions.findOne({ videoId, assetId, status: reelUploadSessionStatusEnum.ISSUED,
          abandonAt: { $lte: finishedAt } }).session(session);
        if (!row) return null;
        const asset = await assets.findOne({ _id: assetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
          ...(providerGuid ? { providerGuid } : {}), ...(requireStatusZero ? { providerStatus: 0 } : {}),
          libraryId, technicalState: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
          deletionRequestedAt: { $exists: false } }).session(session);
        if (!asset) return null;
        return failCurrent({ row, asset, failureCode: "VIDEO_UPLOAD_ABANDONED",
          stage: videoUploadAttemptStageEnum.UPLOAD, session, finishedAt });
      });
      return result || false;
    },
  };
}
