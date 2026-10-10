import { editorialVideoKindEnum, editorialCoverStateEnum, videoProviderOperationTypeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";
import { EditorialCoverModel } from "./editorialCover.model.js";
import { EditorialVideoModel } from "./editorialVideo.model.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";
import { buildBunnyCdnUrl } from "../../../shared/utils/bunnyStorage.js";
import { ApiError } from "../../../shared/utils/ApiError.js";

function id(value) {
  if (!/^[a-f\d]{24}$/i.test(String(value))) throw new TypeError("Invalid cover identity");
  return String(value).toLowerCase();
}
function date(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid cover timestamp");
  return value;
}
const references = (coverId) => ({ $or: [{ activeCoverId: coverId }, { "pendingChange.content.coverId": coverId }] });

export function createEditorialCoverRepository({ covers = EditorialCoverModel, videos = EditorialVideoModel,
  connection = mongoose, recordOperation = recordVideoProviderOperation } = {}) {
  async function transaction(work) {
    const session = await connection.startSession();
    try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; }
    finally { await session.endSession(); }
  }
  async function requestCleanup({ coverId, now, uploadSettled = false, expiredOnly = false }) {
    const generation = id(coverId);
    date(now);
    if (typeof uploadSettled !== "boolean" || typeof expiredOnly !== "boolean") throw new TypeError("Invalid cover cleanup flags");
    const operation = await transaction(async (session) => {
      const cover = await covers.findOne({ _id: generation,
        ...(expiredOnly ? { state: { $in: [editorialCoverStateEnum.UPLOADING, editorialCoverStateEnum.UPLOADED] }, unattachedExpiresAt: { $lte: now } } : {}) }).session(session);
      if (!cover || cover.state === editorialCoverStateEnum.DELETED) return null;
      if (await videos.findOne(references(generation)).session(session)) return null;
      const changed = await covers.updateOne({ _id: generation, state: cover.state }, { $set: {
        state: editorialCoverStateEnum.DELETING, deletionRequestedAt: cover.deletionRequestedAt || now,
        ...(uploadSettled && !cover.uploadSettledAt ? { uploadSettledAt: now } : {}),
      } }, { session, runValidators: true });
      if (changed.matchedCount !== 1) throw new Error("VIDEO_COVER_STATE_CONFLICT");
      return recordOperation({ type: videoProviderOperationTypeEnum.COVER_CLEANUP, coverId: generation,
        dedupeKey: `cover-cleanup:${generation}`, now, session });
    });
    return operation ? { operationId: String(operation._id) } : null;
  }

  return Object.freeze({
    async getDescriptor({ coverId, videoId }) {
      if (!coverId) return null;
      const cover = await covers.findOne({ _id: id(coverId), videoId: id(videoId), state: editorialCoverStateEnum.ATTACHED,
        uploadSettledAt: { $exists: true }, deletionRequestedAt: { $exists: false } }).lean();
      return cover?.descriptor ?? null;
    },
    async reserve({ videoId, actorId, storage, now }) {
      const owner = id(videoId);
      const author = id(actorId);
      date(now);
      return transaction(async (session) => {
        // A read alone can commit a new cover after deletion's cover snapshot.
        // Share the owner write fence without invalidating editorial revisions.
        if (!await videos.findOneAndUpdate({ _id: owner, kind: { $in: Object.values(editorialVideoKindEnum) } },
          { $inc: { associationRevision: 1 } }, { session, new: true, timestamps: false })) {
          throw new Error("VIDEO_COVER_OWNER_NOT_FOUND");
        }
        // This is a request-processing deadline, not a published-cover lifetime.
        const [cover] = await covers.create([{ videoId: owner, actorId: author, storage,
          state: editorialCoverStateEnum.UPLOADING, unattachedExpiresAt: new Date(now.getTime() + 5 * 60_000) }], { session });
        return cover.toObject ? cover.toObject() : cover;
      });
    },
    async recordUploaded({ coverId, descriptor, now }) {
      const generation = id(coverId);
      date(now);
      const cover = await covers.findOne({ _id: generation }).lean();
      if (!cover) return null;
      if (descriptor?.public_id !== `petyard/video-covers/${generation}` || descriptor?.url !== buildBunnyCdnUrl({
        cdnBaseUrl: cover.storage.cdnBaseUrl, objectKey: `petyard/video-covers/${generation}.webp`,
      })) throw new Error("VIDEO_COVER_DESCRIPTOR_MISMATCH");
      return covers.findOneAndUpdate({ _id: generation, state: editorialCoverStateEnum.UPLOADING }, {
        $set: { descriptor, state: editorialCoverStateEnum.UPLOADED, uploadSettledAt: now },
      }, { new: true, runValidators: true }).lean();
    },
    requestCleanup,
    async authorizeCleanup({ coverId }) {
      const generation = id(coverId);
      return transaction(async (session) => {
        const cover = await covers.findOne({ _id: generation, state: { $in: [editorialCoverStateEnum.DELETING, editorialCoverStateEnum.DELETED] },
          deletionRequestedAt: { $exists: true } }).session(session);
        if (!cover || await videos.findOne(references(generation)).session(session)) return null;
        return cover.toObject ? cover.toObject() : cover;
      });
    },
    async confirmCleanup({ coverId, uploadSettledAt, now }) {
      const generation = id(coverId);
      date(now);
      if (!(uploadSettledAt instanceof Date)) return null;
      date(uploadSettledAt);
      return transaction(async (session) => {
        if (await videos.findOne(references(generation)).session(session)) return null;
        return covers.findOneAndUpdate({ _id: generation, state: { $in: [editorialCoverStateEnum.DELETING, editorialCoverStateEnum.DELETED] },
          deletionRequestedAt: { $exists: true }, uploadSettledAt }, {
          $set: { state: editorialCoverStateEnum.DELETED, deletedAt: now }, $unset: { descriptor: "" },
        }, { session, new: true, runValidators: true }).lean();
      });
    },
    async recoverUnattached({ now, limit = 100 }) {
      date(now);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid cover sweep limit");
      const candidates = await covers.find({ state: { $in: [editorialCoverStateEnum.UPLOADING, editorialCoverStateEnum.UPLOADED] },
        unattachedExpiresAt: { $lte: now } }).sort({ unattachedExpiresAt: 1, _id: 1 }).limit(limit).lean();
      const summary = { examined: candidates.length, scheduled: 0, failed: 0, operationIds: [] };
      for (const cover of candidates) {
        try {
          const result = await requestCleanup({ coverId: cover._id, now, expiredOnly: true });
          if (result) { summary.scheduled++; summary.operationIds.push(result.operationId); }
        }
        catch { summary.failed++; }
      }
      return summary;
    },
  });
}

const coverIds = (video) => [video?.activeCoverId, video?.pendingChange?.content?.coverId].map((value) => value ? String(value) : null);
export function coverReferencesChanged(before, after) {
  const previous = coverIds(before);
  return coverIds(after).some((value, index) => value !== previous[index]);
}

// The owning Video write must already be in this transaction. Incrementing the
// cover revision fences attachment against cleanup, even for an attached cover.
export function createEditorialCoverReferencePersistence({ covers = EditorialCoverModel,
  videos = EditorialVideoModel, recordOperation = recordVideoProviderOperation } = {}) {
  const conflict = () => new ApiError("Video cover changed", 409, [{ code: "VIDEO_COVER_CONFLICT" }]);
  return Object.freeze({
    async sync({ before, after, actorId, session, now }) {
      if (!coverReferencesChanged(before, after)) return [];
      date(now);
      if (!session) throw new TypeError("Cover attachment requires a transaction");
      const owner = id(after._id || after.id);
      const previous = new Set(coverIds(before).filter(Boolean));
      const next = new Set(coverIds(after).filter(Boolean));
      for (const generation of next) {
        if (!previous.has(generation) && !actorId) throw conflict();
        const attached = await covers.updateOne({ _id: id(generation), videoId: owner,
          state: { $in: [editorialCoverStateEnum.UPLOADED, editorialCoverStateEnum.ATTACHED] }, uploadSettledAt: { $exists: true },
          "descriptor.url": { $exists: true }, deletionRequestedAt: { $exists: false },
          ...(!previous.has(generation) ? { actorId: id(actorId), unattachedExpiresAt: { $gt: now } } : {}) },
        { $set: { state: editorialCoverStateEnum.ATTACHED }, $inc: { referenceRevision: 1 } }, { session, runValidators: true });
        if (attached.modifiedCount !== 1) throw conflict();
      }
      const operations = [];
      for (const generation of previous) {
        if (next.has(generation)) continue;
        if (await videos.findOne(references(generation)).session(session)) continue;
        const retired = await covers.updateOne({ _id: id(generation), videoId: owner, state: editorialCoverStateEnum.ATTACHED,
          uploadSettledAt: { $exists: true }, deletionRequestedAt: { $exists: false } },
        { $set: { state: editorialCoverStateEnum.DELETING, deletionRequestedAt: now }, $inc: { referenceRevision: 1 } }, { session });
        if (retired.modifiedCount !== 1) throw conflict();
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.COVER_CLEANUP, coverId: generation,
          dedupeKey: `cover-cleanup:${generation}`, now, session });
        operations.push(String(operation._id));
      }
      return operations;
    },
  });
}
