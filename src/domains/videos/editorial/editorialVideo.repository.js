import { editorialVideoKindEnum, editorialVideoStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

import { EditorialVideoModel } from "./editorialVideo.model.js";
import { createReelLifecycleRepository } from "../reels/reelLifecycle.repository.js";
import { createReelUploadRepository } from "../reels/reelUpload.repository.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { createEditorialCoverReferencePersistence } from "./editorialCover.repository.js";
import { createEditorialVideoDeletionRepository } from "./editorialVideoDeletion.repository.js";
import { ProductModel } from "../../product/product.model.js";
import { assertVideoProductsEligible } from "./editorialProductLinks.repository.js";
import { createEditorialVideoAuthorityFence } from "./editorialVideoAuthority.repository.js";

function present(row) {
  if (!row) return null;
  const { _id, __v, associationRevision, ...rest } = row;
  return { ...rest, productIds: (row.productIds ?? []).map(String),
    ...(row.pendingChange ? { pendingChange: { ...row.pendingChange,
      content: { ...row.pendingChange.content, productIds: (row.pendingChange.content?.productIds ?? []).map(String) } } } : {}),
    id: String(_id) };
}

export function createEditorialVideoRepository({ videos = EditorialVideoModel, libraryId, products = ProductModel,
  users, assertAuthority = createEditorialVideoAuthorityFence({ users }), connection = mongoose,
  reelLifecycle = createReelLifecycleRepository({ videos, libraryId, products, connection, assertAuthority }), reelUploads,
  coverReferences = createEditorialCoverReferencePersistence({ videos }), deletion } = {}) {
  async function withAuthority(actor, work) {
    if (!actor) return work();
    const session = await connection.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        await assertAuthority(actor, session);
        result = await work(session);
      });
    } finally { await session.endSession(); }
    return result;
  }
  return Object.freeze({
    assertProductLinksEligible(productIds) { return assertVideoProductsEligible(productIds, { products }); },
    ...createEditorialVideoDeletionRepository({ ...deletion, videos, connection, assertAuthority }),
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
    async create(record, actor) {
      return withAuthority(actor, async (session) => {
        const [created] = await videos.create([record], { session });
        return present(created.toObject?.() ?? created);
      });
    },
    async get(id) {
      if (!mongoose.isValidObjectId(id)) return null;
      return present(await videos.findById(id).lean());
    },
    async replace(id, expectedRevision, next, actor) {
      if (!mongoose.isValidObjectId(id)) return null;
      const fields = Object.fromEntries(Object.entries(next).filter(([key]) => ![
        "id", "_id", "__v", "revision", "associationRevision", "createdAt", "updatedAt", "kind", "authorId",
      ].includes(key)));
      return withAuthority(actor, async (session) => present(await videos.findOneAndUpdate(
        { _id: id, revision: expectedRevision },
        { $set: fields, $inc: { revision: 1 } },
        { session, new: true, runValidators: true },
      ).lean()));
    },
    async setDraftPosition(id, expectedRevision, draftPosition, actor) {
      return withAuthority(actor, async (session) => {
        const row = await videos.findOneAndUpdate(
          { _id: id, kind: { $in: Object.values(editorialVideoKindEnum) }, status: editorialVideoStatusEnum.DRAFT, revision: expectedRevision },
          { $set: { draftPosition }, $inc: { revision: 1 } },
          { session, new: true, runValidators: true },
        );
        return present(row?.toObject?.() ?? row);
      });
    },
    async setPublicPositions({ kind, items }, actor) {
      const session = await connection.startSession();
      let updated;
      try {
        await session.withTransaction(async () => {
          if (actor) await assertAuthority(actor, session);
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
    async replaceWithCovers(id, expectedRevision, next, { actor, actorId, now = new Date() } = {}) {
      if (!mongoose.isValidObjectId(id)) return null;
      const session = await connection.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          result = null;
          if (actor) await assertAuthority(actor, session);
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
      const updated = await (reelUploads ?? createReelUploadRepository({ videos, libraryId, connection, assertAuthority })).cancelPendingChange(input);
      return updated ? { ...updated, video: present(updated.video?.toObject?.() ?? updated.video) } : null;
    },
  });
}
