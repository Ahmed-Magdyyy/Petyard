import { videoAssetOwnerTypeEnum } from "../shared/constants/enums.js";
import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { Worker } from "bullmq";

import { bullMqConfig, createBullMqConnection, isBullMqConfigured } from "../config/bullmq.js";
import { createBunnyStreamAdapter } from "../domains/videos/provider/bunnyStreamAdapter.js";
import { VideoAssetModel } from "../domains/videos/provider/videoAsset.model.js";
import { createVideoAssetObserver } from "../domains/videos/provider/videoAsset.service.js";
import {
  closeVideoProviderQueue,
  enqueueVideoProviderOperation,
  VIDEO_PROVIDER_JOB_NAME,
  VIDEO_PROVIDER_QUEUE_NAME,
} from "../domains/videos/provider/videoProvider.queue.js";
import { VideoProviderOperationModel } from "../domains/videos/provider/videoProviderOperation.model.js";
import {
  claimVideoProviderOperationById,
  completeVideoProviderOperation,
  failVideoProviderOperation,
  listDueVideoProviderOperationIds,
  recordVideoProviderEnqueueFailure,
  recordVideoProviderOperation,
} from "../domains/videos/provider/videoProviderOperation.service.js";
import { createVideoProviderRuntime } from "../domains/videos/provider/videoProviderRuntime.js";
import { getVideoProviderWorkerConfiguration } from "../domains/videos/provider/videoProviderWorkerConfig.js";
import { createVideoOrphanRecovery } from "../domains/videos/provider/videoOrphanRecovery.service.js";
import { createReelOrphanDiscovery } from "../domains/videos/reels/reelOrphanDiscovery.js";
import { getVideosStreamConfiguration } from "../domains/videos/provider/streamConfig.js";
import { VideoUploadAttemptModel } from "../domains/videos/provider/videoUploadAttempt.model.js";
import { ProductVideoModel } from "../domains/videos/productVideos/productVideo.model.js";
import { ProductVideoUploadBatchModel } from "../domains/videos/productVideos/productVideoUploadBatch.model.js";
import { ProductVideoReplacementModel } from "../domains/videos/productVideos/productVideoReplacement.model.js";
import { ProductVideoUploadRecoveryModel } from "../domains/videos/productVideos/productVideoUploadRecovery.model.js";
import { createProductVideoRepository } from "../domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../domains/videos/productVideos/productVideo.service.js";
import { EditorialVideoModel } from "../domains/videos/editorial/editorialVideo.model.js";
import { ReelUploadSessionModel } from "../domains/videos/reels/reelUploadSession.model.js";
import { ReelResourceRecoveryModel } from "../domains/videos/reels/reelResourceRecovery.model.js";
import { createReelUploadRepository } from "../domains/videos/reels/reelUpload.repository.js";
import { createReelUploadRecovery } from "../domains/videos/reels/reelUploadRecovery.service.js";
import { createReelLifecycle } from "../domains/videos/reels/reelLifecycle.service.js";
import { createReelLifecycleRepository } from "../domains/videos/reels/reelLifecycle.repository.js";
import { createVideoAssetAppliedHandler } from "../domains/videos/provider/videoAssetAppliedHandler.js";
import { createVideoPosterService } from "../domains/videos/provider/videoPoster.service.js";
import { createVideoPosterStore } from "../domains/videos/provider/videoPoster.store.js";
import { EditorialCoverModel } from "../domains/videos/editorial/editorialCover.model.js";
import { createEditorialCoverRepository } from "../domains/videos/editorial/editorialCover.repository.js";
import { createEditorialCoverService } from "../domains/videos/editorial/editorialCover.service.js";
import { createEditorialCoverStore } from "../domains/videos/editorial/editorialCover.store.js";

let worker;
let workerConnection;
let sweepTimer;
let sweepInFlight;
let stopping = false;

function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "VIDEO_PROVIDER_WORKER_ERROR";
}

async function start() {
  const config = getVideoProviderWorkerConfiguration();
  const stream = getVideosStreamConfiguration().stream;
  if (!stream) throw new Error("BUNNY_STREAM_CONFIGURATION_REQUIRED");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  if (!isBullMqConfigured()) throw new Error("REDIS_URL_REQUIRED");

  await mongoose.connect(process.env.MONGO_URI);
  await Promise.all([
    VideoAssetModel.createIndexes(),
    VideoProviderOperationModel.createIndexes(),
    VideoUploadAttemptModel.createIndexes(),
    ProductVideoModel.createIndexes(),
    ProductVideoUploadBatchModel.createIndexes(),
    ProductVideoReplacementModel.createIndexes(),
    ProductVideoUploadRecoveryModel.createIndexes(),
    EditorialVideoModel.createIndexes(),
    ReelUploadSessionModel.createIndexes(),
    ReelResourceRecoveryModel.createIndexes(),
    EditorialCoverModel.createIndexes(),
  ]);

  const provider = createBunnyStreamAdapter(stream);
  const covers = createEditorialCoverService({ repository: createEditorialCoverRepository(),
    store: createEditorialCoverStore() });
  const productRepository = createProductVideoRepository({ libraryId: stream.libraryId });
  const reelRepository = createReelUploadRepository({ libraryId: stream.libraryId });
  const productVideos = createProductVideoService({
    repository: productRepository,
    provider,
    uploadAuthorizationTtlSeconds: stream.uploadAuthorizationTtlSeconds,
    allowOrphanCleanup: config.orphanRecoveryEnabled,
  });
  const reelVideos = createReelLifecycle({
    repository: createReelLifecycleRepository({ libraryId: stream.libraryId }),
    verifyPreviewReady: async (asset) => Boolean(await provider.probeSignedHls({
      videoId: asset.providerGuid,
      expiresAt: Math.floor(Date.now() / 1000) + stream.playbackTtlSeconds,
    })),
  });
  const reelUploadRecovery = createReelUploadRecovery({
    repository: reelRepository,
  });
  const orphanRecovery = config.orphanRecoveryEnabled ? createVideoOrphanRecovery({
    productRepository, reelRepository, productVideos,
    reelDiscovery: createReelOrphanDiscovery({ repository: reelRepository, provider,
      libraryId: stream.libraryId, allowCleanup: true }),
    retryAfterMs: config.leaseMs,
  }) : null;

  const runtime = createVideoProviderRuntime({
    provider,
    posters: createVideoPosterService({ provider, store: createVideoPosterStore() }),
    covers,
    operations: {
      record: recordVideoProviderOperation,
      claimById: claimVideoProviderOperationById,
      complete: completeVideoProviderOperation,
      fail: failVideoProviderOperation,
      listDueIds: listDueVideoProviderOperationIds,
      recordEnqueueFailure: recordVideoProviderEnqueueFailure,
    },
    assets: createVideoAssetObserver({
      onApplied: createVideoAssetAppliedHandler({ productVideos, reelVideos, reelUploadRecovery }),
      onMissing: (asset) => asset.ownerType === videoAssetOwnerTypeEnum.REEL
        ? reelUploadRecovery.handleMissingAsset(asset) : productVideos.handleMissingAsset(asset),
      onDeleted: (asset) => productVideos.handleDeletedAsset(asset),
    }),
    enqueue: enqueueVideoProviderOperation,
    sweepLimit: config.sweepBatchSize,
    leaseMs: config.leaseMs,
  });

  workerConnection = createBullMqConnection("video-provider-worker");
  worker = new Worker(
    VIDEO_PROVIDER_QUEUE_NAME,
    async (job) => {
      const id = String(job.id || "");
      if (
        job.name !== VIDEO_PROVIDER_JOB_NAME ||
        !/^[a-f\d]{24}$/i.test(id) ||
        job.data?.operationId !== id ||
        Object.keys(job.data).length !== 1
      ) {
        throw new Error("VIDEO_PROVIDER_JOB_INVALID");
      }
      return runtime.process(id);
    },
    {
      connection: workerConnection,
      prefix: bullMqConfig.prefix,
      concurrency: config.concurrency,
    },
  );
  worker.on("failed", (job, error) => {
    console.error("[Video Provider Worker] Job failed", {
      operationId: job?.id || null,
      code: safeCode(error),
    });
  });
  worker.on("error", (error) => {
    console.error("[Video Provider Worker] Worker error", safeCode(error));
  });

  async function sweep() {
    if (stopping || sweepInFlight) return;
    sweepInFlight = (async () => {
      const recovered = await runtime.sweep();
      const reconciled = await runtime.reconcileStuckAssets();
      const posters = await runtime.recoverPosters({ libraryId: stream.libraryId });
      const unattachedCovers = await covers.recoverUnattached({ limit: Math.min(config.sweepBatchSize, 100) });
      const setups = await productVideos.recoverUploadSetups({ limit: Math.min(config.sweepBatchSize, 100) });
      const reelSetups = await reelUploadRecovery.recoverStaleSetups({ limit: Math.min(config.sweepBatchSize, 100) });
      const reelRejectedChanges = await reelUploadRecovery.recoverRejectedChanges({ limit: Math.min(config.sweepBatchSize, 100) });
      const reelPreviews = await reelVideos.recoverPreviewPending({ limit: Math.min(config.sweepBatchSize, 100) });
      const orphans = orphanRecovery ? await orphanRecovery.sweep({ limit: Math.min(config.sweepBatchSize, 100) }) : null;
      return { recovered, reconciled, posters, unattachedCovers, setups, reelSetups, reelRejectedChanges, reelPreviews, orphans };
    })();
    try {
      const summary = await sweepInFlight;
      if (summary.recovered.attempted || summary.reconciled.found || summary.posters.found || summary.setups.examined ||
          summary.unattachedCovers.examined || summary.reelSetups.examined ||
          summary.reelRejectedChanges.examined ||
          summary.reelPreviews.attempted || summary.orphans?.examined || summary.orphans?.failed) {
        console.log("[Video Provider Worker] Sweep", summary);
      }
    } catch (error) {
      console.error("[Video Provider Worker] Sweep failed", safeCode(error));
    } finally {
      sweepInFlight = null;
    }
  }

  sweepTimer = setInterval(sweep, config.sweepIntervalMs);
  await sweep();
  console.log("[Video Provider Worker] Started");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (sweepTimer) clearInterval(sweepTimer);
  console.log("[Video Provider Worker] Stopping", signal);
  await Promise.allSettled([
    sweepInFlight,
    worker?.close(),
    closeVideoProviderQueue(),
    workerConnection?.quit(),
  ]);
  await mongoose.connection.close(false);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("[Video Provider Worker] Unhandled rejection", safeCode(error));
  shutdown("unhandledRejection");
});

start().catch((error) => {
  console.error("[Video Provider Worker] Failed to start", safeCode(error));
  process.exit(1);
});
