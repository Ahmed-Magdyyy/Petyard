import {
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
  videoPreviewSelectionEnum,
} from "../../../shared/constants/enums.js";
import { EditorialVideoModel } from "../editorial/editorialVideo.model.js";
import { ReelUploadSessionModel } from "./reelUploadSession.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { VideoUploadAttemptModel } from "../provider/videoUploadAttempt.model.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";
import { createEditorialCoverReferencePersistence } from "../editorial/editorialCover.repository.js";

import { isVerifiedReelAssetReady } from "./reelAsset.policy.js";

const conflict = () => new ApiError("Reel replacement changed", 409, [{ code: "VIDEO_STATE_CONFLICT" }]);
const replacementStates = [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED];

export function createReelLifecycleRepository({ videos = EditorialVideoModel,
  sessions = ReelUploadSessionModel, assets = VideoAssetModel, libraryId,
  connection = mongoose, attempts = VideoUploadAttemptModel,
  recordOperation = recordVideoProviderOperation,
  coverReferences = createEditorialCoverReferencePersistence({ videos, recordOperation }) } = {}) {
  if (libraryId !== undefined && (typeof libraryId !== "string" || !/^\d+$/.test(libraryId))) {
    throw new TypeError("libraryId must be numeric");
  }
  return Object.freeze({
    async applyReplacement({ videoId, expectedRevision, sessionId, assetId, reviewerId,
      automatic = false, now }) {
      if (!libraryId || !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
          (!automatic && !reviewerId)) throw new TypeError("Replacement cutover requires library, time and authority");
      const transaction = await connection.startSession();
      let result;
      try {
        await transaction.withTransaction(async () => {
          const video = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL, revision: expectedRevision,
            status: { $in: replacementStates }, "pendingChange.assetId": assetId,
            "pendingChange.uploadSessionId": sessionId,
            "pendingChange.status": automatic ? editorialReviewStatusEnum.DRAFT : editorialReviewStatusEnum.IN_REVIEW,
            ...(automatic ? { "pendingChange.autoApplyWhenReady": true } : {}) }).session(transaction);
          if (!video) { result = null; return; }
          const row = await sessions.findOne({ _id: sessionId, videoId, assetId, purpose: reelUploadPurposeEnum.REPLACEMENT,
            actorId: video.pendingChange.authorId, previousAssetId: video.activeAssetId,
            status: reelUploadSessionStatusEnum.ISSUED, appliedAt: { $exists: false },
            ...(automatic ? { autoApplyWhenReady: true } : {}) }).session(transaction);
          if (!row || String(assetId) === String(video.activeAssetId)) throw conflict();
          const asset = await assets.findOne({ _id: assetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
            libraryId, technicalState: videoAssetTechnicalStateEnum.READY, deletionRequestedAt: { $exists: false } }).session(transaction);
          if (!isVerifiedReelAssetReady(asset)) throw conflict();
          const old = await assets.findOne({ _id: video.activeAssetId, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
            libraryId, deletionRequestedAt: { $exists: false } }).session(transaction);
          if (!old) throw conflict();
          const content = video.pendingChange.content.toObject?.() ?? video.pendingChange.content;
          const switched = await videos.findOneAndUpdate({ _id: videoId, kind: editorialVideoKindEnum.REEL, revision: expectedRevision,
            status: video.status, activeAssetId: old._id, "pendingChange.assetId": assetId,
            "pendingChange.uploadSessionId": sessionId, "pendingChange.authorId": row.actorId,
            "pendingChange.status": automatic ? editorialReviewStatusEnum.DRAFT : editorialReviewStatusEnum.IN_REVIEW },
          { $set: { title_en: content.title_en, title_ar: content.title_ar,
            description_en: content.description_en, description_ar: content.description_ar,
            activeAssetId: asset._id, activeUploadSessionId: row._id, pendingChange: null,
            ...(Object.hasOwn(content, "coverId") ? { activeCoverId: content.coverId } : {}),
            reviewerId: automatic ? row.actorId : reviewerId, reviewedAt: now },
            $inc: { revision: 1 } }, { session: transaction, new: true, runValidators: true });
          if (!switched) throw conflict();
          const coverOperations = await coverReferences.sync({ before: video, after: switched,
            session: transaction, now });
          if (await videos.findOne({ kind: editorialVideoKindEnum.REEL, $or: [{ activeAssetId: old._id },
            { "pendingChange.assetId": old._id }] }).session(transaction)) throw conflict();
          const retired = await assets.updateOne({ _id: old._id, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId,
            libraryId, providerGuid: old.providerGuid, deletionRequestedAt: { $exists: false } },
          { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: now } }, { session: transaction });
          if (retired.modifiedCount !== 1) throw conflict();
          const applied = await sessions.updateOne({ _id: row._id, status: reelUploadSessionStatusEnum.ISSUED,
            assetId, appliedAt: { $exists: false } }, { $set: { appliedAt: now } }, { session: transaction });
          if (applied.modifiedCount !== 1) throw conflict();
          const operation = await recordOperation({ type: videoProviderOperationTypeEnum.DELETE, assetId: old._id, libraryId,
            providerGuid: old.providerGuid, dedupeKey: `reel-replacement-old:${row._id}:${old._id}`,
            now, session: transaction });
          await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: videoId, actorId: row.actorId,
            assetId, safeFilename: row.safeFilename, stage: videoUploadAttemptStageEnum.PROCESSING, outcome: videoUploadAttemptOutcomeEnum.SUCCEEDED,
            finishedAt: now }], { session: transaction });
          result = { video: switched, operationIds: [String(operation._id), ...coverOperations] };
        });
      } finally { await transaction.endSession(); }
      if (!result) return null;
      return result;
    },
    async findCurrentForVideoId(videoId, selection = videoPreviewSelectionEnum.ACTIVE) {
      if (!mongoose.isValidObjectId(videoId)) return null;
      const video = await videos.findOne({ _id: videoId, kind: editorialVideoKindEnum.REEL });
      const assetId = selection === videoPreviewSelectionEnum.PENDING ? video?.pendingChange?.assetId : video?.activeAssetId;
      const sessionId = selection === videoPreviewSelectionEnum.PENDING ? video?.pendingChange?.uploadSessionId : video?.activeUploadSessionId;
      if (!assetId || !sessionId || (selection === videoPreviewSelectionEnum.PENDING &&
          !Object.values(editorialReviewStatusEnum).includes(video.pendingChange.status))) return null;
      const asset = await assets.findOne({ _id: assetId,
        ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: video._id, technicalState: videoAssetTechnicalStateEnum.READY,
        ...(libraryId ? { libraryId } : {}),
        deletionRequestedAt: { $exists: false } });
      if (!asset) return null;
      const session = await sessions.findOne({ _id: sessionId,
        videoId: video._id, assetId: asset._id, status: reelUploadSessionStatusEnum.ISSUED,
        ...(selection === videoPreviewSelectionEnum.PENDING ? { purpose: reelUploadPurposeEnum.REPLACEMENT, actorId: video.pendingChange.authorId,
          previousAssetId: video.activeAssetId } : {}),
      });
      return session ? { video, asset, session } : null;
    },
    async findCurrentForAsset(asset) {
      const session = await sessions.findOne({ videoId: asset.ownerId, assetId: asset._id,
        status: reelUploadSessionStatusEnum.ISSUED });
      if (!session) return null;
      if (session.purpose === reelUploadPurposeEnum.REPLACEMENT && !session.appliedAt) {
        const video = await videos.findOne({ _id: asset.ownerId, kind: editorialVideoKindEnum.REEL,
          status: { $in: replacementStates }, activeAssetId: session.previousAssetId,
          "pendingChange.assetId": asset._id, "pendingChange.uploadSessionId": session._id,
          "pendingChange.authorId": session.actorId,
          "pendingChange.status": { $in: Object.values(editorialReviewStatusEnum) } });
        return video ? { video, session, replacement: true } : null;
      }
      const video = await videos.findOne({ _id: asset.ownerId, kind: editorialVideoKindEnum.REEL,
        activeAssetId: asset._id, activeUploadSessionId: session._id });
      return video ? { video, session } : null;
    },
    async publishIfCurrent({ asset, sessionId, now }) {
      return videos.findOneAndUpdate({ _id: asset.ownerId, kind: editorialVideoKindEnum.REEL,
        activeAssetId: asset._id, activeUploadSessionId: sessionId,
        status: editorialVideoStatusEnum.DRAFT, autoPublishWhenReady: true },
      { $set: { status: editorialVideoStatusEnum.PUBLISHED, publishedAt: now },
        $unset: { nextPreviewProbeAt: "" }, $inc: { revision: 1 } },
      { new: true });
    },
    async deferPreviewProbe({ asset, sessionId, nextProbeAt }) {
      await videos.updateOne({ _id: asset.ownerId, kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.DRAFT,
        autoPublishWhenReady: true, activeAssetId: asset._id,
        activeUploadSessionId: sessionId },
      { $set: { nextPreviewProbeAt: nextProbeAt } });
    },
    async deferReplacementProbe({ asset, sessionId, nextProbeAt }) {
      await videos.updateOne({ _id: asset.ownerId, kind: editorialVideoKindEnum.REEL, status: { $in: replacementStates },
        "pendingChange.assetId": asset._id, "pendingChange.uploadSessionId": sessionId,
        "pendingChange.status": editorialReviewStatusEnum.DRAFT, "pendingChange.autoApplyWhenReady": true },
      { $set: { "pendingChange.nextPreviewProbeAt": nextProbeAt } });
    },
    async listDueReplacementProbes({ before, limit }) {
      if (!(before instanceof Date) || !Number.isFinite(before.getTime()) ||
          !Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Invalid Reel preview sweep bounds");
      return videos.find({ kind: editorialVideoKindEnum.REEL, status: { $in: replacementStates },
        "pendingChange.status": editorialReviewStatusEnum.DRAFT, "pendingChange.autoApplyWhenReady": true,
        "pendingChange.assetId": { $exists: true }, "pendingChange.uploadSessionId": { $exists: true },
        $or: [{ "pendingChange.nextPreviewProbeAt": { $exists: false } },
          { "pendingChange.nextPreviewProbeAt": { $lte: before } }] })
        .sort({ "pendingChange.nextPreviewProbeAt": 1, _id: 1 }).limit(limit).lean();
    },
    async claimDueReplacementProbe({ candidate, claimedAt, nextProbeAt }) {
      const pending = candidate.pendingChange;
      const claimed = await videos.findOneAndUpdate({ _id: candidate._id, kind: editorialVideoKindEnum.REEL,
        status: { $in: replacementStates }, activeAssetId: candidate.activeAssetId,
        "pendingChange.assetId": pending.assetId, "pendingChange.uploadSessionId": pending.uploadSessionId,
        "pendingChange.status": editorialReviewStatusEnum.DRAFT, "pendingChange.autoApplyWhenReady": true,
        $or: [{ "pendingChange.nextPreviewProbeAt": { $exists: false } },
          { "pendingChange.nextPreviewProbeAt": { $lte: claimedAt } }] },
      { $set: { "pendingChange.nextPreviewProbeAt": nextProbeAt } }, { new: true });
      if (!claimed) return null;
      return assets.findOne({ _id: claimed.pendingChange.assetId, ownerType: videoAssetOwnerTypeEnum.REEL,
        ownerId: claimed._id, ...(libraryId ? { libraryId } : {}), technicalState: videoAssetTechnicalStateEnum.READY,
        deletionRequestedAt: { $exists: false } });
    },
    async listDuePreviewProbes({ before, limit }) {
      if (!(before instanceof Date) || !Number.isFinite(before.getTime()) ||
          !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("Invalid Reel preview sweep bounds");
      }
      return videos.find({ kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.DRAFT, autoPublishWhenReady: true,
        activeAssetId: { $exists: true }, activeUploadSessionId: { $exists: true },
        $or: [{ nextPreviewProbeAt: { $exists: false } },
          { nextPreviewProbeAt: { $lte: before } }] })
        .sort({ nextPreviewProbeAt: 1, _id: 1 }).limit(limit).lean();
    },
    async claimDuePreviewProbe({ candidate, claimedAt, nextProbeAt }) {
      const claimed = await videos.findOneAndUpdate({ _id: candidate._id, kind: editorialVideoKindEnum.REEL,
        status: editorialVideoStatusEnum.DRAFT, autoPublishWhenReady: true,
        activeAssetId: candidate.activeAssetId,
        activeUploadSessionId: candidate.activeUploadSessionId,
        $or: [{ nextPreviewProbeAt: { $exists: false } },
          { nextPreviewProbeAt: { $lte: claimedAt } }] },
      { $set: { nextPreviewProbeAt: nextProbeAt } }, { new: true });
      if (!claimed) return null;
      return assets.findOne({ _id: claimed.activeAssetId, ownerType: videoAssetOwnerTypeEnum.REEL,
        ownerId: claimed._id, technicalState: videoAssetTechnicalStateEnum.READY,
        deletionRequestedAt: { $exists: false } });
    },
  });
}
