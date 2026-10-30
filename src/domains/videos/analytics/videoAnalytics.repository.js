import {
  editorialVideoStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  reelUploadSessionStatusEnum,
  videoContentKindEnum,
} from "../../../shared/constants/enums.js";
import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { VideoPlaybackSessionModel } from "./videoPlaybackSession.model.js";
import { VideoAnalyticsEventModel } from "./videoAnalyticsEvent.model.js";
import { EditorialVideoModel } from "../editorial/editorialVideo.model.js";
import { ProductVideoModel } from "../productVideos/productVideo.model.js";
import { ProductModel } from "../../product/product.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { ReelUploadSessionModel } from "../reels/reelUploadSession.model.js";
import { createPublicVideoRepository } from "../public/publicVideo.repository.js";
import { createPublicProductVideoRepository } from "../public/publicProductVideo.repository.js";
import { isVerifiedReelAssetReady } from "../reels/reelAsset.policy.js";
import { createVideoAnalyticsDailyRepository } from "./videoAnalyticsDaily.repository.js";
import { VideoAnalyticsDailyModel } from "./videoAnalyticsDaily.model.js";

export function createVideoAnalyticsRepository({
  playbackSessions = VideoPlaybackSessionModel, events = VideoAnalyticsEventModel,
  connection = mongoose, uploads = ReelUploadSessionModel,
  videos = EditorialVideoModel, placements = ProductVideoModel,
  products = ProductModel, assets = VideoAssetModel,
  daily = VideoAnalyticsDailyModel,
} = {}) {
  const totals = createVideoAnalyticsDailyRepository({ events, daily });
  const editorial = createPublicVideoRepository({ videos, placements, products, assets,
    sessions: uploads });
  const product = createPublicProductVideoRepository({ placements, products, assets });
  const unavailable = () => new ApiError("Playback session not available", 404,
    [{ code: "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE" }]);
  async function getCurrent({ kind, contentId }, transaction) {
    const row = kind === videoContentKindEnum.PRODUCT ? await product.getPlayable(contentId, { session: transaction })
      : await editorial.getPublished(contentId, { session: transaction });
    if (!row || row.kind !== kind) return null;
    if (kind === videoContentKindEnum.YOUTUBE) {
      return { kind, contentId, youtubeId: row.youtubeId, durationSeconds: null };
    }
    if (kind === videoContentKindEnum.REEL && !isVerifiedReelAssetReady(row.asset)) return null;
    return { kind, contentId, assetId: String(row.activeAssetId),
      ...(kind === videoContentKindEnum.REEL ? { uploadSessionId: String(row.activeUploadSessionId) } : {}),
      durationSeconds: row.asset.durationSeconds };
  }
  async function fenceMedia(media, transaction) {
    const options = { session: transaction, new: true, timestamps: false };
    // These writes serialize ingestion with deletion, replacement and visibility
    // changes. Snapshot reads alone would permit events for stale media.
    // ponytail: per-content write fence; revisit only if measured contention
    // requires a different visibility/version protocol.
    if (media.kind === videoContentKindEnum.PRODUCT) {
      const placement = await placements.findOneAndUpdate({ _id: media.contentId,
        activeSlot: true, lifecycleState: { $in: [productVideoLifecycleStateEnum.READY, productVideoLifecycleStateEnum.DELETING] },
        activeAssetId: media.assetId, removedAt: { $exists: false } },
      { $inc: { __v: 1 } }, options);
      if (!placement || !await products.findOneAndUpdate({ _id: placement.productId,
        isActive: true }, { $inc: { __v: 1 } }, options)) throw unavailable();
    } else if (!await videos.findOneAndUpdate({ _id: media.contentId,
      kind: media.kind, status: editorialVideoStatusEnum.PUBLISHED, ...(media.kind === videoContentKindEnum.YOUTUBE
        ? { youtubeId: media.youtubeId }
        : { activeAssetId: media.assetId, activeUploadSessionId: media.uploadSessionId }) },
    { $inc: { associationRevision: 1 } }, options)) throw unavailable();
    if (media.kind === videoContentKindEnum.YOUTUBE) return;
    if (!await assets.findOneAndUpdate({ _id: media.assetId,
      ownerId: media.contentId, ownerType: media.kind === videoContentKindEnum.PRODUCT ? videoAssetOwnerTypeEnum.PRODUCT_VIDEO : videoAssetOwnerTypeEnum.REEL,
      technicalState: videoAssetTechnicalStateEnum.READY, providerStatus: 4, durationSeconds: media.durationSeconds,
      ...(media.kind === videoContentKindEnum.PRODUCT ? { deleteAcceptedAt: { $exists: false } }
        : { deletionRequestedAt: { $exists: false } }) },
    { $inc: { __v: 1 } }, options)) throw unavailable();
    if (media.kind === videoContentKindEnum.REEL && !await uploads.findOneAndUpdate({ _id: media.uploadSessionId,
      videoId: media.contentId, assetId: media.assetId, status: reelUploadSessionStatusEnum.ISSUED },
    { $inc: { __v: 1 } }, options)) throw unavailable();
  }
  return Object.freeze({
    getCurrent,
    listDaily: totals.listDaily,
    async commitEvents({ batch, identity, processSession, checkSession }) {
      const groups = new Map();
      for (const event of batch) {
        if (!groups.has(event.playbackSessionId)) groups.set(event.playbackSessionId, []);
        groups.get(event.playbackSessionId).push(event);
      }
      const transaction = await connection.startSession();
      let result;
      try {
        await transaction.withTransaction(async () => {
          result = { accepted: 0, duplicates: 0 };
          const checked = [];
          for (const id of [...groups.keys()].sort()) {
            const session = await playbackSessions.findOneAndUpdate({ _id: id,
              identityType: identity.type, identityId: identity.id }, { $inc: { revision: 1 } },
            { session: transaction, new: true }).lean();
            if (!session) throw unavailable();
            const media = await getCurrent({ kind: session.kind,
              contentId: String(session.contentId) }, transaction);
            checkSession(session, media);
            await fenceMedia(media, transaction);
            const items = groups.get(id);
            const existing = await events.find({ playbackSessionId: id,
              eventId: { $in: items.map(event => event.eventId) } }).session(transaction).lean();
            const processed = processSession({ session, media, events: items, existing });
            await totals.recordEvents(processed.documents.map(document => document.qualifiedViewCounted
              ? { ...document, identityType: identity.type, identityId: identity.id, assetId: media.assetId }
              : document), transaction);
            await playbackSessions.updateOne({ _id: id }, { $set: processed.state }, { session: transaction });
            result.accepted += processed.documents.length;
            result.duplicates += processed.duplicates;
            checked.push({ session, media });
          }
          for (const { session, media } of checked) checkSession(session, media);
        });
        return result;
      } finally { await transaction.endSession(); }
    },
    async createSession(document) {
      await playbackSessions.create([document]);
    },
    async deleteSession(id) {
      await playbackSessions.deleteOne({ _id: id });
    },
    async findSession({ id, identity }) {
      return playbackSessions.findOne({ _id: id, identityType: identity.type,
        identityId: identity.id }).lean();
    },
  });
}
