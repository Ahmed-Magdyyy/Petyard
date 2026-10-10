import { videoProviderOperationTypeEnum } from "../../../shared/constants/enums.js";
import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { ApiError } from "../../../shared/utils/ApiError.js";

function coverError(message, status, code) { return new ApiError(message, status, [{ code }]); }

export function createEditorialCoverService({ repository, store, enqueue = enqueueVideoProviderOperation, now = () => new Date() }) {
  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result;
  }

  return Object.freeze({
    discardUnused: async ({ coverId }) => Boolean(await finishCommit(repository.requestCleanup({ coverId, now: now() }))),
    async describe(video) {
      const [active, pending] = await Promise.all([
        repository.getDescriptor({ coverId: video.activeCoverId, videoId: video.id }),
        repository.getDescriptor({ coverId: video.pendingChange?.content?.coverId, videoId: video.id }),
      ]);
      return { ...video, coverUrl: active?.url || null,
        ...(video.pendingChange ? { pendingChange: { ...video.pendingChange, coverUrl: pending?.url || null } } : {}) };
    },
    // Internal staging only. The future editorial edit path must authorize the
    // Video and atomically attach this generation before returning HTTP success.
    async stageUpload({ videoId, actor, buffer }) {
      if (!actor || !["admin", "superAdmin"].includes(actor.role) || !/^[a-f\d]{24}$/i.test(String(actor.id))) {
        throw coverError("Cover upload requires an administrator", 403, "VIDEO_EDITOR_REQUIRED");
      }
      await store.validate({ buffer });
      const cover = await repository.reserve({ videoId, actorId: actor.id, storage: store.identity(), now: now() });
      let descriptor;
      try { descriptor = await store.upload({ coverId: cover._id, buffer, storage: cover.storage }); }
      catch (error) {
        const noPut = ["VIDEO_INVALID_COVER", "VIDEO_COVER_STORAGE_CHANGED", "VIDEO_COVER_STORAGE_UNAVAILABLE"]
          .includes(error?.errors?.[0]?.code);
        try { await finishCommit(repository.requestCleanup({ coverId: cover._id, now: now(), uploadSettled: noPut })); }
        catch { /* The expired reservation remains discoverable if compensation persistence fails. */ }
        throw coverError("Cover upload failed", error?.statusCode === 422 ? 422 : 502, "VIDEO_COVER_UPLOAD_FAILED");
      }
      try {
        const uploaded = await repository.recordUploaded({ coverId: cover._id, descriptor, now: now() });
        if (!uploaded) throw new Error("VIDEO_COVER_STATE_CONFLICT");
        return uploaded;
      } catch {
        try { await finishCommit(repository.requestCleanup({ coverId: cover._id, now: now(), uploadSettled: true })); }
        catch { /* Do not issue an untracked DELETE or assume the failed write was not applied. */ }
        throw coverError("Cover upload could not be recorded", 503, "VIDEO_COVER_PERSISTENCE_FAILED");
      }
    },
    async cleanup({ operation }) {
      if (operation?.type !== videoProviderOperationTypeEnum.COVER_CLEANUP || operation.assetId || operation.libraryId || operation.providerGuid) {
        throw new Error("VIDEO_COVER_CLEANUP_TARGET_INVALID");
      }
      const cover = await repository.authorizeCleanup({ coverId: operation.coverId });
      if (!cover) throw new Error("VIDEO_COVER_DELETE_NOT_AUTHORIZED");
      await store.remove({ coverId: cover._id, storage: cover.storage });
      // Capture settlement BEFORE DELETE. A producer settling during DELETE may
      // have written after it; only another cleanup attempt can safely finish.
      if (!cover.uploadSettledAt || !await repository.confirmCleanup({ coverId: cover._id,
        uploadSettledAt: cover.uploadSettledAt, now: now() })) throw new Error("VIDEO_COVER_UPLOAD_UNSETTLED");
    },
    async recoverUnattached({ limit = 100 } = {}) {
      const { operationIds, ...summary } = await finishCommit(repository.recoverUnattached({ now: now(), limit }));
      return summary;
    },
  });
}
