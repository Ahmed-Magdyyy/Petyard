import { editorialVideoKindEnum, editorialVideoStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

import { EditorialVideoModel } from "./editorialVideo.model.js";
import { createReelLifecycleRepository } from "../reels/reelLifecycle.repository.js";
import { createReelUploadRepository } from "../reels/reelUpload.repository.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { createEditorialCoverReferencePersistence } from "./editorialCover.repository.js";
import { createEditorialVideoDeletionRepository } from "./editorialVideoDeletion.repository.js";

function present(row) {
  if (!row) return null;
  const { _id, __v, associationRevision, ...rest } = row;
  return { ...rest, id: String(_id) };
}

export function createEditorialVideoRepository({ videos = EditorialVideoModel, libraryId,
  reelLifecycle = createReelLifecycleRepository({ videos, libraryId }), reelUploads,
  connection = mongoose, coverReferences = createEditorialCoverReferencePersistence({ videos }), deletion } = {}) {
  return Object.freeze({
    ...createEditorialVideoDeletionRepository({ ...deletion, videos, connection }),
    async list({ page, limit, kind, status }) {
      if (status === editorialVideoStatusEnum.DRAFT) {
        const [result] = await videos.aggregate([
          { $match: { kind, status } },
          { $facet: {
            count: [{ $count: "total" }],
            rows: [
              { $addFields: { draftSortRank: { $cond: [
                { $ne: [{ $ifNull: ["$draftPosition", null] }, null] }, 0, 1,
              ] } } },
              { $sort: { draftSortRank: 1, draftPosition: 1, createdAt: -1, _id: -1 } },
              { $skip: (page - 1) * limit }, { $limit: limit }, { $unset: "draftSortRank" },
            ],
          } },
        ]);
        return { totalResults: result?.count?.[0]?.total ?? 0, data: (result?.rows ?? []).map(present) };
      }
      const [totalResults, rows] = await Promise.all([
        videos.countDocuments({}),
        videos.find({}).sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).lean(),
      ]);
      return { totalResults, data: rows.map(present) };
    },
    async create(record) {
      const created = await videos.create(record);
      return present(created.toObject());
    },
    async get(id) {
      if (!mongoose.isValidObjectId(id)) return null;
      return present(await videos.findById(id).lean());
    },
    async replace(id, expectedRevision, next) {
      if (!mongoose.isValidObjectId(id)) return null;
      const fields = Object.fromEntries(Object.entries(next).filter(([key]) => ![
        "id", "_id", "__v", "revision", "associationRevision", "createdAt", "updatedAt", "kind", "authorId",
      ].includes(key)));
      return present(await videos.findOneAndUpdate(
        { _id: id, revision: expectedRevision },
        { $set: fields, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      ).lean());
    },
    async setDraftPosition(id, expectedRevision, draftPosition) {
      const row = await videos.findOneAndUpdate(
        { _id: id, kind: { $in: Object.values(editorialVideoKindEnum) }, status: editorialVideoStatusEnum.DRAFT, revision: expectedRevision },
        { $set: { draftPosition }, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      );
      return present(row?.toObject?.() ?? row);
    },
    async setPublicPositions({ kind, items }) {
      const session = await connection.startSession();
      let updated;
      try {
        await session.withTransaction(async () => {
          // Reset on driver retries. A stale or unavailable item aborts the
          // whole batch, including earlier successful conditional writes.
          updated = [];
          for (const item of items) {
            const row = await videos.findOneAndUpdate(
              { _id: item.videoId, kind, status: editorialVideoStatusEnum.PUBLISHED, revision: item.revision },
              { $set: { position: item.position }, $inc: { revision: 1 } },
              { session, new: true, runValidators: true },
            );
            if (!row) throw new ApiError("Video positions changed or are unavailable", 409,
              [{ code: "VIDEO_STATE_CONFLICT" }]);
            updated.push({ videoId: String(row._id), position: row.position, revision: row.revision });
          }
        });
      } finally { await session.endSession(); }
      return { kind, items: updated };
    },
    async replaceWithCovers(id, expectedRevision, next, { actorId, now = new Date() } = {}) {
      if (!mongoose.isValidObjectId(id)) return null;
      const session = await connection.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          result = null;
          const current = await videos.findOne({ _id: id, revision: expectedRevision }).session(session);
          if (!current) return;
          const fields = Object.fromEntries(Object.entries(next).filter(([key]) => ![
            "id", "_id", "__v", "revision", "associationRevision", "createdAt", "updatedAt", "kind", "authorId", "coverUrl",
          ].includes(key)));
          const updated = await videos.findOneAndUpdate({ _id: id, revision: expectedRevision },
            { $set: fields, $inc: { revision: 1 } }, { session, new: true, runValidators: true }).lean();
          if (!updated) return;
          const operations = await coverReferences.sync({ before: current, after: updated, actorId, session, now });
          result = { video: updated, operations };
        });
      } finally { await session.endSession(); }
      if (!result) return null;
      return { video: present(result.video), operationIds: result.operations };
    },
    async applyReelReplacement(input) {
      const updated = await reelLifecycle.applyReplacement(input);
      return updated ? { ...updated, video: present(updated.video?.toObject?.() ?? updated.video) } : null;
    },
    async cancelReelPendingChange(input) {
      if (!reelUploads && !libraryId) throw new ApiError("Reel cleanup is unavailable", 503,
        [{ code: "VIDEO_CLEANUP_UNAVAILABLE" }]);
      const updated = await (reelUploads ?? createReelUploadRepository({ videos, libraryId })).cancelPendingChange(input);
      return updated ? { ...updated, video: present(updated.video?.toObject?.() ?? updated.video) } : null;
    },
  });
}
