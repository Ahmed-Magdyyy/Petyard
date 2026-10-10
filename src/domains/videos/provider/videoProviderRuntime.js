import { videoProviderOperationTypeEnum, videoProviderExecutionStatusEnum } from "../../../shared/constants/enums.js";
function safeProviderErrorCode(error) {
  if (error?.status === 429) return "BUNNY_STREAM_RATE_LIMITED";
  if ([400, 401, 403].includes(error?.status)) return "BUNNY_STREAM_REJECTED";
  if (Number.isInteger(error?.status) && error.status >= 500) {
    return "BUNNY_STREAM_UNAVAILABLE";
  }
  return error?.code === "BUNNY_STREAM_TIMEOUT"
    ? "BUNNY_STREAM_TIMEOUT"
    : "BUNNY_STREAM_PROVIDER_ERROR";
}

export function createVideoProviderRuntime({
  provider,
  operations,
  assets,
  posters,
  covers,
  enqueue,
  now = Date.now,
  sweepLimit = 100,
  leaseMs = 300_000,
}) {
  if (!provider || !operations || !assets) {
    throw new TypeError("provider, operations, and assets are required");
  }

  async function recoverStalePoster(operation, runtime) {
    if (typeof operations.record !== "function") return;
    // An expired worker may finish a PUT after another worker already closed
    // its original obligation. Its late result needs a fresh durable check;
    // updating/completing the old lease would be a no-op.
    await runtime.schedule({ type: videoProviderOperationTypeEnum.COPY_POSTER, assetId: operation.assetId,
      libraryId: operation.libraryId, providerGuid: operation.providerGuid,
      dedupeKey: `poster-late:${operation._id}:${operation.leaseToken}` });
  }

  async function providerIsAbsent(providerGuid) {
    try {
      await provider.getVideo(providerGuid);
      return false;
    } catch (error) {
      if (error?.status === 404) return true;
      throw error;
    }
  }

  return Object.freeze({
    async recoverPosters({ libraryId }) {
      if (!posters) return { found: 0, queued: 0 };
      const candidates = await assets.listNeedingPoster({ libraryId, limit: sweepLimit });
      let queued = 0;
      for (const asset of candidates) {
        const result = await this.schedule({ type: videoProviderOperationTypeEnum.COPY_POSTER, assetId: asset._id,
          libraryId: asset.libraryId, providerGuid: asset.providerGuid,
          dedupeKey: `poster:${asset._id}` });
        // Record before marking: a crash cannot leave a requested poster with
        // no durable obligation. Lost enqueueing remains the regular sweeper's job.
        await assets.markPosterRequested({ asset });
        if (result.queued) queued += 1;
      }
      return { found: candidates.length, queued };
    },
    async schedule(specification) {
      const operation = await operations.record(specification);
      const operationId = String(operation._id);
      try {
        await enqueue(operationId);
        return { operationId, queued: true };
      } catch {
        try {
          await operations.recordEnqueueFailure?.({
            operationId,
            errorCode: "VIDEO_PROVIDER_QUEUE_UNAVAILABLE",
            now: new Date(now()),
          });
        } catch {
          // The durable operation remains due even if this diagnostic write fails.
        }
        return { operationId, queued: false };
      }
    },
    async sweep() {
      const dueIds = await operations.listDueIds({
        now: new Date(now()),
        limit: sweepLimit,
      });
      const summary = { attempted: dueIds.length, queued: 0, failed: 0 };
      for (const operationId of dueIds) {
        try {
          await enqueue(operationId);
          summary.queued += 1;
        } catch {
          summary.failed += 1;
          try {
            await operations.recordEnqueueFailure?.({
              operationId,
              errorCode: "VIDEO_PROVIDER_QUEUE_UNAVAILABLE",
              now: new Date(now()),
            });
          } catch {
            // The next sweep will find the same due operation.
          }
        }
      }
      return summary;
    },
    async reconcileStuckAssets() {
      const observedAt = now();
      const stuck = await assets.listStuck({
        before: new Date(observedAt - 5 * 60_000),
        limit: sweepLimit,
      });
      let queued = 0;
      for (const asset of stuck) {
        const scheduled = await this.schedule({
          type: videoProviderOperationTypeEnum.RECONCILE,
          assetId: asset._id,
          libraryId: asset.libraryId,
          providerGuid: asset.providerGuid,
          dedupeKey: `stuck:${asset._id}:${Math.floor(observedAt / (5 * 60_000))}`,
        });
        if (scheduled.queued) queued += 1;
      }
      return { found: stuck.length, queued };
    },
    async process(operationId) {
      const operation = await operations.claimById({
        operationId,
        now: new Date(now()),
        leaseMs,
      });
      if (!operation) return { status: videoProviderExecutionStatusEnum.SKIPPED };

      if (operation.type === videoProviderOperationTypeEnum.COVER_CLEANUP) {
        try {
          if (!covers) throw new Error("VIDEO_COVER_PIPELINE_UNAVAILABLE");
          await covers.cleanup({ operation });
        } catch (error) {
          const code = ["VIDEO_COVER_DELETE_NOT_AUTHORIZED", "VIDEO_COVER_UPLOAD_UNSETTLED"]
            .includes(error?.message) ? error.message : "VIDEO_COVER_CLEANUP_FAILED";
          await operations.fail({ operationId, leaseToken: operation.leaseToken, errorCode: code });
          return { status: videoProviderExecutionStatusEnum.RETRYABLE };
        }
        const completed = await operations.complete({ operationId, leaseToken: operation.leaseToken });
        return { status: completed ? videoProviderExecutionStatusEnum.COMPLETED : videoProviderExecutionStatusEnum.STALE };
      }

      if (operation.type === videoProviderOperationTypeEnum.COPY_POSTER) {
        try {
          if (!posters) throw new Error("VIDEO_POSTER_PIPELINE_UNAVAILABLE");
          await posters.copy({ operation });
        } catch {
          const failed = await operations.fail({ operationId, leaseToken: operation.leaseToken,
            errorCode: "VIDEO_POSTER_COPY_FAILED" });
          if (!failed) await recoverStalePoster(operation, this);
          return { status: videoProviderExecutionStatusEnum.RETRYABLE };
        }
        const completed = await operations.complete({ operationId, leaseToken: operation.leaseToken });
        if (!completed) await recoverStalePoster(operation, this);
        return { status: completed ? videoProviderExecutionStatusEnum.COMPLETED : videoProviderExecutionStatusEnum.STALE };
      }

      if (operation.type === videoProviderOperationTypeEnum.RECONCILE) {
        try {
          let snapshot;
          let recoveredMissing = false;
          try {
            snapshot = await provider.getVideo(operation.providerGuid);
          } catch (error) {
            // Only an authoritative GET 404 reaches missing-resource recovery;
            // failures from applying a snapshot are never evidence of absence.
            if (error?.status !== 404 || !(await assets.observeMissing?.({ operation }))) throw error;
            recoveredMissing = true;
          }
          if (!recoveredMissing) {
            if (snapshot?.guid !== operation.providerGuid) throw { code: "VIDEO_PROVIDER_ID_MISMATCH" };
            await assets.applySnapshot({ operation, snapshot });
          }
        } catch (error) {
          await operations.fail({
            operationId,
            leaseToken: operation.leaseToken,
            errorCode: safeProviderErrorCode(error),
          });
          return { status: videoProviderExecutionStatusEnum.RETRYABLE };
        }
        const completed = await operations.complete({
          operationId,
          leaseToken: operation.leaseToken,
        });
        return { status: completed ? videoProviderExecutionStatusEnum.COMPLETED : videoProviderExecutionStatusEnum.STALE };
      }

      if (![videoProviderOperationTypeEnum.DELETE, videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, videoProviderOperationTypeEnum.VERIFY_DELETION].includes(operation.type)) {
        throw new TypeError(`Unsupported Video Provider Operation: ${operation.type}`);
      }

      const target = await assets.getDeletionTarget?.({ operation });
      if (!target) {
        await operations.fail({
          operationId,
          leaseToken: operation.leaseToken,
          errorCode: "VIDEO_DELETE_NOT_AUTHORIZED",
        });
        return { status: videoProviderExecutionStatusEnum.RETRYABLE };
      }

      let deleteAccepted = Boolean(target.deleteAcceptedAt);
      let confirmedAbsent = false;
      if (operation.type !== videoProviderOperationTypeEnum.VERIFY_DELETION && !deleteAccepted) {
        let terminationEstablished = !target.tusUploadUrl;
        try {
          if (target.tusUploadUrl) {
            await provider.terminateTusUpload({ videoId: operation.providerGuid, uploadUrl: target.tusUploadUrl });
            terminationEstablished = true;
          }
          await provider.deleteVideo(operation.providerGuid);
          deleteAccepted = true;
        } catch (error) {
          // A transient GET 404 cannot settle an upload whose termination is uncertain.
          if (terminationEstablished && (error?.status === 404 || error?.code === "BUNNY_STREAM_TIMEOUT" || error?.status == null)) {
            try {
              confirmedAbsent = await providerIsAbsent(operation.providerGuid);
            } catch { /* Observation failure cannot authorize local removal. */ }
          }
          if (!confirmedAbsent) {
            await operations.fail({
              operationId,
              leaseToken: operation.leaseToken,
              errorCode: safeProviderErrorCode(error),
            });
            return { status: videoProviderExecutionStatusEnum.RETRYABLE };
          }
        }
      }

      // Q93/Q96 local removal follows acceptance; provider cleanup remains due until GET 404.
      if (deleteAccepted) await assets.markDeleteAccepted({ operation });
      if (!confirmedAbsent) {
        try {
          confirmedAbsent = await providerIsAbsent(operation.providerGuid);
        } catch (error) {
          await operations.fail({ operationId, leaseToken: operation.leaseToken,
            errorCode: safeProviderErrorCode(error) });
          return { status: videoProviderExecutionStatusEnum.RETRYABLE };
        }
      }
      if (!confirmedAbsent) {
        await operations.fail({ operationId, leaseToken: operation.leaseToken,
          errorCode: "VIDEO_PROVIDER_STILL_PRESENT" });
        return { status: videoProviderExecutionStatusEnum.RETRYABLE };
      }
      if (!deleteAccepted) await assets.markDeleteAccepted({ operation });
      try {
        await posters?.remove({ operation });
      } catch {
        // Stream acceptance already removes the video from public projections.
        // The same durable operation must remain due until image storage is clean.
        await operations.fail({ operationId, leaseToken: operation.leaseToken,
          errorCode: "VIDEO_POSTER_CLEANUP_FAILED" });
        return { status: videoProviderExecutionStatusEnum.RETRYABLE };
      }
      const completed = await operations.complete({
        operationId,
        leaseToken: operation.leaseToken,
      });
      return { status: completed ? videoProviderExecutionStatusEnum.COMPLETED : videoProviderExecutionStatusEnum.STALE };
    },
  });
}
