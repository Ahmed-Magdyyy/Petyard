import {
  editorialVideoKindEnum,
  editorialVideoStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  editorialCoverStateEnum,
  reelUploadSessionStatusEnum,
} from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

import { EditorialVideoModel } from "../editorial/editorialVideo.model.js";
import { ProductModel } from "../../product/product.model.js";
import { ProductVideoModel } from "../productVideos/productVideo.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { ReelUploadSessionModel } from "../reels/reelUploadSession.model.js";
import { VideoSaveModel } from "./videoSave.model.js";
import { productEligibleStages } from "./publicProductVideo.repository.js";
import { EditorialCoverModel } from "../editorial/editorialCover.model.js";
import { UserModel } from "../../user/user.model.js";
import { NotificationOutboxModel } from "../../notification/notificationOutbox.model.js";
import { createPublicVideoErrorPersistence } from "./publicVideoError.repository.js";
import { VideoAnalyticsEventModel } from "../analytics/videoAnalyticsEvent.model.js";
import { VideoAnalyticsDailyModel } from "../analytics/videoAnalyticsDaily.model.js";
import { createVideoAnalyticsDailyRepository } from "../analytics/videoAnalyticsDaily.repository.js";

function present(row) {
  if (!row) return null;
  const { _id, __v, associationRevision, sortRank, _savedAt, _saveId, session, ...rest } = row;
  return { ...rest, id: String(_id) };
}

function pageResult(facets) {
  const [result = {}] = facets;
  return { totalResults: result.count?.[0]?.total ?? 0,
    data: (result.rows ?? []).map(present) };
}

const publishedFilter = { kind: editorialVideoKindEnum.YOUTUBE, status: editorialVideoStatusEnum.PUBLISHED };

function currentMediaStages({ assets, sessions, preserveEmpty = false }) {
  return [
    { $lookup: { from: assets.collection.name, localField: "activeAssetId",
      foreignField: "_id", as: "asset" } },
    { $unwind: { path: "$asset", preserveNullAndEmptyArrays: preserveEmpty } },
    { $lookup: { from: sessions.collection.name, localField: "activeUploadSessionId",
      foreignField: "_id", as: "session" } },
    { $unwind: { path: "$session", preserveNullAndEmptyArrays: preserveEmpty } },
  ];
}

const readyReelMatch = {
  kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.PUBLISHED,
  "asset.ownerType": videoAssetOwnerTypeEnum.REEL, "asset.technicalState": videoAssetTechnicalStateEnum.READY,
  "asset.providerStatus": 4, "asset.readyAt": { $type: "date" },
  "asset.deletionRequestedAt": { $exists: false },
  "asset.durationSeconds": { $gt: 0, $lte: 90 },
  "asset.width": { $gt: 0 }, "asset.height": { $gt: 0 },
  "asset.availableResolutions.0": { $exists: true },
  "session.status": reelUploadSessionStatusEnum.ISSUED,
  $expr: { $and: [
    { $eq: ["$asset.ownerId", "$_id"] },
    { $eq: ["$session.videoId", "$_id"] },
    { $eq: ["$session.assetId", "$asset._id"] },
  ] },
};

function positionedSortStages() {
  return [
    { $addFields: { sortRank: { $cond: [
      { $ne: [{ $ifNull: ["$position", null] }, null] }, 0, 1,
    ] } } },
    { $sort: { sortRank: 1, position: 1, publishedAt: -1, _id: -1 } },
  ];
}

export function createPublicVideoRepository({ videos = EditorialVideoModel,
  saves = VideoSaveModel, assets = VideoAssetModel,
  sessions = ReelUploadSessionModel, products = ProductModel,
  placements = ProductVideoModel, covers = EditorialCoverModel, connection = mongoose,
  users = UserModel, outbox = NotificationOutboxModel,
  analyticsEvents = VideoAnalyticsEventModel, daily = VideoAnalyticsDailyModel } = {}) {
  const totals = createVideoAnalyticsDailyRepository({ events: analyticsEvents, daily });
  async function hydrateCovers(rows, transaction) {
    const ids = [...new Set(rows.filter((row) => Object.values(editorialVideoKindEnum).includes(row.kind) && row.activeCoverId)
      .map((row) => String(row.activeCoverId)))];
    if (!ids.length) return rows;
    const query = covers.find({ _id: { $in: ids }, state: editorialCoverStateEnum.ATTACHED,
      uploadSettledAt: { $exists: true }, deletionRequestedAt: { $exists: false } })
      .select("_id videoId descriptor");
    if (transaction) query.session(transaction);
    const attached = await query.lean();
    const byId = new Map(attached.map((cover) => [String(cover._id), cover]));
    return rows.map((row) => {
      const cover = byId.get(String(row.activeCoverId));
      return { ...row, cover: Object.values(editorialVideoKindEnum).includes(row.kind) && cover &&
        String(cover.videoId) === String(row.id) ? cover.descriptor : null };
    });
  }
  async function withCovers(facets) {
    const result = pageResult(facets);
    return { ...result, data: await hydrateCovers(result.data) };
  }
  return Object.freeze({
    ...createPublicVideoErrorPersistence({ videos, users, outbox, connection }),
    async listYouTube({ page, limit }) {
      const facets = await videos.aggregate([
        { $match: publishedFilter },
        { $addFields: { sortRank: { $cond: [
          { $ne: [{ $ifNull: ["$position", null] }, null] }, 0, 1,
        ] } } },
        { $facet: {
          count: [{ $count: "total" }],
          rows: [{ $sort: { sortRank: 1, position: 1, publishedAt: -1, _id: -1 } },
            { $skip: (page - 1) * limit }, { $limit: limit }],
        } },
      ]);
      return withCovers(facets);
    },
    async listReels({ page, limit }) {
      const facets = await videos.aggregate([
        { $match: { kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.PUBLISHED } },
        ...currentMediaStages({ assets, sessions }),
        { $match: readyReelMatch },
        { $facet: { count: [{ $count: "total" }],
          rows: [...positionedSortStages(), { $skip: (page - 1) * limit },
            { $limit: limit }] } },
      ]);
      return withCovers(facets);
    },
    async listProducts({ page, limit }) {
      const facets = await placements.aggregate([
        ...productEligibleStages({ products, assets, feedOnly: true }),
        { $facet: { count: [{ $count: "total" }],
          rows: [{ $sort: { feedAt: -1, _id: -1 } },
            { $skip: (page - 1) * limit }, { $limit: limit }] } },
      ]);
      return pageResult(facets);
    },
    async listMixed({ page, limit, includeReels = true, includeProducts = true }) {
      const reelStages = includeReels ? [
        { $match: { kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.PUBLISHED } },
        ...currentMediaStages({ assets, sessions }),
        { $match: readyReelMatch },
        { $addFields: { feedAt: "$publishedAt" } },
      ] : [{ $match: { _id: { $exists: false } } }];
      const stages = [...reelStages];
      if (includeProducts) stages.push({ $unionWith: {
        coll: placements.collection.name,
        pipeline: productEligibleStages({ products, assets, feedOnly: true }),
      } });
      stages.push({ $facet: { count: [{ $count: "total" }],
        rows: [{ $sort: { feedAt: -1, kind: 1, _id: -1 } },
          { $skip: (page - 1) * limit }, { $limit: limit }] } });
      return withCovers(await videos.aggregate(stages));
    },
    async getPublished(id, { session } = {}) {
      if (!mongoose.isValidObjectId(id)) return null;
      const query = videos.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(id), status: editorialVideoStatusEnum.PUBLISHED,
          kind: { $in: Object.values(editorialVideoKindEnum) } } },
        ...currentMediaStages({ assets, sessions, preserveEmpty: true }),
        { $match: { $or: [{ kind: editorialVideoKindEnum.YOUTUBE }, readyReelMatch] } },
        { $limit: 1 },
      ]);
      if (session) query.session(session);
      const rows = await query;
      const video = present(rows[0]);
      return video ? (await hydrateCovers([video], session))[0] : null;
    },
    async savedIds({ identity, videoIds }) {
      if (!identity || !videoIds.length) return new Set();
      const rows = await saves.find({ identityType: identity.type, identityId: identity.id,
        videoId: { $in: videoIds } }).select("videoId").lean();
      return new Set(rows.map((row) => String(row.videoId)));
    },
    async listSaved({ identity, kind = "all", page, limit }) {
      const kinds = kind === "all" ? Object.values(editorialVideoKindEnum) : [kind];
      const facets = await saves.aggregate([
        { $match: { identityType: identity.type, identityId: identity.id } },
        { $lookup: { from: videos.collection.name, localField: "videoId",
          foreignField: "_id", as: "video" } },
        { $unwind: "$video" },
        { $match: { "video.kind": { $in: kinds }, "video.status": editorialVideoStatusEnum.PUBLISHED } },
        { $set: { "video._savedAt": "$savedAt", "video._saveId": "$_id" } },
        { $replaceRoot: { newRoot: "$video" } },
        ...currentMediaStages({ assets, sessions, preserveEmpty: true }),
        { $match: { $or: [{ kind: editorialVideoKindEnum.YOUTUBE }, readyReelMatch] } },
        { $facet: {
          count: [{ $count: "total" }],
          rows: [{ $sort: { _savedAt: -1, _saveId: -1 } },
            { $skip: (page - 1) * limit }, { $limit: limit }],
        } },
      ]);
      return withCovers(facets);
    },
    async save({ identity, videoId, event }) {
      if (!mongoose.isValidObjectId(videoId)) return false;
      const filter = { identityType: identity.type, identityId: identity.id, videoId };
      // Both save and deletion write the owner in their transactions. Mongo
      // retries the loser instead of allowing an orphan save after removal.
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await connection.startSession();
        let saved = false;
        try {
          await session.withTransaction(async () => {
            saved = false;
            const owner = await videos.findOneAndUpdate({ _id: videoId, status: editorialVideoStatusEnum.PUBLISHED,
              kind: { $in: Object.values(editorialVideoKindEnum) } }, { $inc: { associationRevision: 1 } },
            { session, new: true, timestamps: false });
            if (!owner) return;
            if (!await saves.findOne(filter).session(session)) {
              await saves.updateOne(filter, { $setOnInsert: { ...filter, savedAt: event?.occurredAt ?? new Date() } },
                { session, upsert: true });
              if (event) await totals.recordEvents([{ ...event, kind: owner.kind }], session);
            }
            saved = true;
          });
          return saved;
        } catch (error) {
          // Never read within an aborted transaction. Retry a unique-index
          // race once, rechecking both the owner and the identical association.
          if (error?.code !== 11000 || attempt === 1) throw error;
        } finally { await session.endSession(); }
      }
    },
    async unsave({ identity, videoId, event }) {
      if (!mongoose.isValidObjectId(videoId)) return;
      const session = await connection.startSession();
      try {
        await session.withTransaction(async () => {
          // Hidden saves can still be removed. Serialize customer removal with
          // permanent deletion so cleanup cannot be counted as a user action.
          const owner = await videos.findOneAndUpdate({ _id: videoId,
            kind: { $in: Object.values(editorialVideoKindEnum) } }, { $inc: { associationRevision: 1 } },
          { session, new: true, timestamps: false });
          if (!owner) return;
          const removed = await saves.deleteOne({ identityType: identity.type,
            identityId: identity.id, videoId }, { session });
          if (removed.deletedCount && event) {
            await totals.recordEvents([{ ...event, kind: owner.kind }], session);
          }
        });
      } finally { await session.endSession(); }
    },
  });
}
