import {
  editorialVideoKindEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  editorialCoverStateEnum,
  reelUploadSessionStatusEnum,
  videoProviderOperationTypeEnum,
} from "../../../shared/constants/enums.js";
import mongoose from "mongoose";
import { createEditorialVideoAuthorityFence } from "./editorialVideoAuthority.repository.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { ReelUploadSessionModel } from "../reels/reelUploadSession.model.js";
import { EditorialCoverModel } from "./editorialCover.model.js";
import { VideoSaveModel } from "../public/videoSave.model.js";
import { ProductVideoModel } from "../productVideos/productVideo.model.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";

const conflict = () => new ApiError("Video or its media changed", 409, [{ code: "VIDEO_STATE_CONFLICT" }]);

// Retain assets, covers and failed sessions as independent cleanup obligations.
// Queue dispatch and provider calls belong to the service/worker, after commit.
export function createEditorialVideoDeletionRepository({ videos, connection = mongoose,
  assertAuthority = createEditorialVideoAuthorityFence(),
  assets = VideoAssetModel, sessions = ReelUploadSessionModel, covers = EditorialCoverModel,
  saves = VideoSaveModel, placements = ProductVideoModel, recordOperation = recordVideoProviderOperation } = {}) {
  return Object.freeze({
    async deletePermanently({ id, revision, actor, now }) {
      const session = await connection.startSession();
      let operationIds;
      try {
        await session.withTransaction(async () => {
          operationIds = [];
          if (actor) await assertAuthority(actor, session);
          const removed = await videos.findOneAndDelete({ _id: id, revision,
            kind: { $in: Object.values(editorialVideoKindEnum) } }, { session });
          if (!removed) {
            if (await videos.findOne({ _id: id }).session(session)) throw conflict();
            return;
          }
          await saves.deleteMany({ videoId: id }, { session });
          const ownedAssets = await assets.find({ ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: id }).session(session).lean();
          const ownedCovers = await covers.find({ videoId: id }).session(session).lean();
          for (const reference of [removed.activeAssetId, removed.pendingChange?.assetId].filter(Boolean)) {
            if (!ownedAssets.some((asset) => String(asset._id) === String(reference))) throw conflict();
          }
          for (const reference of [removed.activeCoverId, removed.pendingChange?.content?.coverId].filter(Boolean)) {
            if (!ownedCovers.some((cover) => String(cover._id) === String(reference))) throw conflict();
          }
          for (const asset of ownedAssets) {
            if (await videos.findOne({ $or: [{ activeAssetId: asset._id }, { "pendingChange.assetId": asset._id }] }).session(session) ||
                await placements.findOne({ $or: [{ activeAssetId: asset._id }, { pendingAssetId: asset._id }] }).session(session)) throw conflict();
            if (asset.technicalState === videoAssetTechnicalStateEnum.DELETED && !asset.poster) continue;
            const changed = await assets.updateOne({ _id: asset._id, ownerType: videoAssetOwnerTypeEnum.REEL, ownerId: id,
              technicalState: asset.technicalState }, { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING,
                deletionRequestedAt: asset.deletionRequestedAt || now } }, { session });
            if (changed.matchedCount !== 1) throw conflict();
            const operation = await recordOperation({ type: videoProviderOperationTypeEnum.DELETE, assetId: asset._id,
              libraryId: asset.libraryId, providerGuid: asset.providerGuid,
              dedupeKey: `editorial-delete:${id}:${asset._id}`, now, session });
            operationIds.push(String(operation._id));
          }
          for (const cover of ownedCovers) {
            if (await videos.findOne({ $or: [{ activeCoverId: cover._id },
              { "pendingChange.content.coverId": cover._id }] }).session(session)) throw conflict();
            if (cover.state === editorialCoverStateEnum.DELETED) continue;
            const changed = await covers.updateOne({ _id: cover._id, videoId: id, state: cover.state },
              { $set: { state: editorialCoverStateEnum.DELETING, deletionRequestedAt: cover.deletionRequestedAt || now },
                $inc: { referenceRevision: 1 } }, { session });
            if (changed.matchedCount !== 1) throw conflict();
            const operation = await recordOperation({ type: videoProviderOperationTypeEnum.COVER_CLEANUP, coverId: cover._id,
              dedupeKey: `cover-cleanup:${cover._id}`, now, session });
            operationIds.push(String(operation._id));
          }
          // Keep markers and generation IDs: a late Bunny create result still
          // uses failSetup to persist compensation after the owner is removed.
          await sessions.updateMany({ videoId: id, status: { $in: [reelUploadSessionStatusEnum.RESERVING, reelUploadSessionStatusEnum.ISSUED] } },
            { $set: { status: reelUploadSessionStatusEnum.FAILED, failedAt: now, failureCode: "VIDEO_DELETED" } }, { session });
        });
      } finally { await session.endSession(); }
      return { operationIds };
    },
  });
}
