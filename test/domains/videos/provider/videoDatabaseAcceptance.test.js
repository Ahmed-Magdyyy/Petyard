import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { ProductVideoModel } from "../../../../src/domains/videos/productVideos/productVideo.model.js";
import { ProductVideoUploadBatchModel } from "../../../../src/domains/videos/productVideos/productVideoUploadBatch.model.js";
import { ProductVideoReplacementModel } from "../../../../src/domains/videos/productVideos/productVideoReplacement.model.js";
import { ProductVideoUploadRecoveryModel } from "../../../../src/domains/videos/productVideos/productVideoUploadRecovery.model.js";
import { VideoAssetModel } from "../../../../src/domains/videos/provider/videoAsset.model.js";
import { VideoProviderOperationModel } from "../../../../src/domains/videos/provider/videoProviderOperation.model.js";
import { VideoUploadAttemptModel } from "../../../../src/domains/videos/provider/videoUploadAttempt.model.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { EditorialCoverModel } from "../../../../src/domains/videos/editorial/editorialCover.model.js";
import { ReelUploadSessionModel } from "../../../../src/domains/videos/reels/reelUploadSession.model.js";
import { ReelResourceRecoveryModel } from "../../../../src/domains/videos/reels/reelResourceRecovery.model.js";
import { VideoSaveModel } from "../../../../src/domains/videos/public/videoSave.model.js";
import { VideoAnalyticsEventModel } from "../../../../src/domains/videos/analytics/videoAnalyticsEvent.model.js";
import { VideoPlaybackSessionModel } from "../../../../src/domains/videos/analytics/videoPlaybackSession.model.js";
import { VideoAnalyticsDailyModel } from "../../../../src/domains/videos/analytics/videoAnalyticsDaily.model.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { NotificationOutboxModel } from "../../../../src/domains/notification/notificationOutbox.model.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelOrphanDiscovery } from "../../../../src/domains/videos/reels/reelOrphanDiscovery.js";
import { createVideoOrphanRecovery } from "../../../../src/domains/videos/provider/videoOrphanRecovery.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { VIDEO_PROVIDER_QUEUE_NAME, VIDEO_PROVIDER_JOB_NAME } from "../../../../src/domains/videos/provider/videoProvider.queue.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation, listDueVideoProviderOperationIds } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { verifyVideoDatabaseFlows } from "./fixtures/videoDatabaseFlows.js";
import { verifyVideoDatabaseUploadRecovery } from "./fixtures/videoDatabaseUploadRecovery.js";
import { verifyVideoDatabaseAlertRaces } from "./fixtures/videoDatabaseAlertRaces.js";
import { verifyVideoReplacementRaces } from "./fixtures/videoReplacementRaces.js";
import { verifyVideoEditorialOrphanAcceptance } from "./fixtures/videoEditorialOrphanAcceptance.js";

const enabled = process.env.VIDEOS_ACCEPTANCE_ENABLED === "true";
const objectId = () => new mongoose.Types.ObjectId();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Explicit opt-in only. Never load dotenv or use the application's ambient MONGO_URI/Redis prefix.
test("isolated real MongoDB and Redis acceptance with mocked Bunny", { skip: !enabled, timeout: 240_000 }, async t => {
  const uri = process.env.VIDEOS_ACCEPTANCE_MONGO_URI;
  assert.ok(uri, "VIDEOS_ACCEPTANCE_MONGO_URI is required for this explicitly authorized run");
  const prefix = `videos_acceptance_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const connection = mongoose.createConnection(uri, { autoIndex: false, autoCreate: false,
    serverSelectionTimeoutMS: 15_000, maxPoolSize: 10 });
  const owned = [];
  let redis, queue, worker, running;
  const ownedRedisKeys = async () => {
    let cursor = "0";
    const keys = [];
    do {
      const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
      cursor = page[0];
      keys.push(...page[1]);
    } while (cursor !== "0");
    return keys;
  };
  try {
    try { await connection.asPromise(); }
    catch (error) { throw new Error(`MongoDB acceptance connection failed (${error?.name || "connection error"})`); }
    const existing = await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray();
    assert.equal(existing.length, 0, "Acceptance namespace must be unused before creating resources");
    const originals = { products: ProductModel, placements: ProductVideoModel, batches: ProductVideoUploadBatchModel,
      replacements: ProductVideoReplacementModel, recoveries: ProductVideoUploadRecoveryModel,
      assets: VideoAssetModel, operations: VideoProviderOperationModel, attempts: VideoUploadAttemptModel,
      videos: EditorialVideoModel, covers: EditorialCoverModel, sessions: ReelUploadSessionModel,
      reelRecoveries: ReelResourceRecoveryModel, saves: VideoSaveModel, events: VideoAnalyticsEventModel,
      playback: VideoPlaybackSessionModel, daily: VideoAnalyticsDailyModel,
      users: UserModel, outbox: NotificationOutboxModel };
    const models = {};
    for (const [key, original] of Object.entries(originals)) {
      const collectionName = `${prefix}_${original.collection.name}`;
      assert.ok(collectionName.startsWith(`${prefix}_`));
      const model = connection.model(original.modelName, original.schema.clone(), collectionName);
      owned.push(collectionName);
      await connection.db.createCollection(collectionName, {
        validator: { $jsonSchema: { bsonType: "object", description: prefix } },
      });
      await model.createIndexes();
      models[key] = model;
    }
    assert.ok(["VIDEOS_ACCEPTANCE_ALERT_RACES_ONLY", "VIDEOS_ACCEPTANCE_REPLACEMENT_RACES_ONLY", "VIDEOS_ACCEPTANCE_EDITORIAL_ORPHAN_ONLY"]
      .filter(key => process.env[key] === "true").length <= 1, "Select one focused acceptance mode");
    if (process.env.VIDEOS_ACCEPTANCE_EDITORIAL_ORPHAN_ONLY === "true") {
      const completed = await verifyVideoEditorialOrphanAcceptance(t, { models, connection, libraryId: "754739",
        recordOperation: input => recordVideoProviderOperation({ ...input, model: models.operations }),
        record: (check, data) => console.log(JSON.stringify({ check, ...data })) });
      assert.equal(completed, 3);
      return;
    }
    if (process.env.VIDEOS_ACCEPTANCE_ALERT_RACES_ONLY === "true") {
      assert.notEqual(process.env.VIDEOS_ACCEPTANCE_REPLACEMENT_RACES_ONLY, "true");
      await verifyVideoDatabaseAlertRaces(t, { models, connection });
      return;
    }
    if (process.env.VIDEOS_ACCEPTANCE_REPLACEMENT_RACES_ONLY === "true") {
      const completed = await verifyVideoReplacementRaces(t, { models, connection, libraryId: "754739",
        recordOperation: input => recordVideoProviderOperation({ ...input, model: models.operations }),
        record: (check, data) => console.log(JSON.stringify({ check, ...data })) });
      assert.equal(completed, 2);
      return;
    }
    const libraryId = "754739";
    const now = Date.now();
    const old = new Date(now - 600_000);
    const recordOperation = input => recordVideoProviderOperation({ ...input, model: models.operations });
    const productRepository = createProductVideoRepository({ ...models, connection, libraryId, recordOperation });
    const reelRepository = createReelUploadRepository({ ...models, recoveries: models.reelRecoveries,
      connection, libraryId, recordOperation });
    const ttlCanaries = [
      [models.playback, { _id: `ttl-${randomBytes(12).toString("hex")}`, expiresAt: new Date(0) }],
      [models.events, { _id: objectId(), eventId: randomBytes(12).toString("hex"),
        playbackSessionId: "ttl-canary", expiresAt: new Date(0) }],
      [models.daily, { _id: objectId(), kind: "youtube", contentId: objectId(), day: "2000-01-01", expiresAt: new Date(0) }],
      [models.attempts, { _id: objectId(), purgeAt: new Date(0) }],
    ];
    for (const [model, document] of ttlCanaries) await model.collection.insertOne(document);

    await t.test("all real model indexes exist, including unique fences and TTL retention", async () => {
      for (const [key, model] of Object.entries(models)) {
        const actual = await model.collection.indexes();
        for (const [fields, options] of originals[key].schema.indexes()) {
          assert.ok(actual.some(index => JSON.stringify(index.key) === JSON.stringify(fields) &&
            (!options.unique || index.unique === true) &&
            (options.expireAfterSeconds === undefined || index.expireAfterSeconds === options.expireAfterSeconds)), key);
        }
      }
    });

    await t.test("real transactions serialize Product slot reservation and roll back the losing batch", async () => {
      const productId = objectId();
      const actorId = objectId();
      await models.products.collection.insertOne({ _id: productId, slug: `acceptance-${productId}`, videoNextPosition: 0 });
      const request = key => ({ productId, actorId, idempotencyKey: key,
        files: [0, 1].map(i => ({ clientId: `${key}-${i}`, filename: "video.mp4" })) });
      const results = await Promise.allSettled([
        productRepository.reserveBatch(request("batch-one")), productRepository.reserveBatch(request("batch-two")),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(await models.placements.countDocuments({ productId, activeSlot: true }), 2);
      assert.equal(await models.batches.countDocuments({ productId }), 1);
      assert.equal((await models.products.findById(productId)).videoNextPosition, 2);
    });

    await t.test("orphan probe claims are exclusive across all five real reservation paths", async () => {
      const videoId = objectId();
      const batchId = objectId();
      const replacementId = objectId();
      const recoveryId = objectId();
      const sessionId = objectId();
      const reelRecoveryId = objectId();
      await models.placements.collection.insertOne({ _id: videoId, activeSlot: false,
        lifecycleState: "failed", uploadBatchId: batchId, updatedAt: old });
      await models.replacements.collection.insertOne({ _id: replacementId, videoId, status: "failed",
        failureCode: "VIDEO_PROVIDER_UNAVAILABLE", finishedAt: old, updatedAt: old });
      await models.recoveries.collection.insertOne({ _id: recoveryId, videoId, status: "failed", finishedAt: old, updatedAt: old });
      await models.sessions.collection.insertOne({ _id: sessionId, videoId, status: "failed",
        providerTitle: `petyard-reel-session:${sessionId}`, failedAt: old, updatedAt: old });
      await models.reelRecoveries.collection.insertOne({ _id: reelRecoveryId, sessionId, videoId,
        status: "failed", finishedAt: old, updatedAt: old });
      for (const [repository, expected] of [[productRepository, 3], [reelRepository, 2]]) {
        const candidates = await repository.listOrphanRecoveryCandidates({ before: new Date(now - 300_000), limit: 10 });
        assert.equal(candidates.length, expected);
        for (const candidate of candidates) {
          const outcomes = await Promise.all([0, 1].map(() => repository.claimOrphanRecoveryCandidate({ ...candidate, claimedAt: new Date(now) })));
          assert.deepEqual(outcomes.sort(), [false, true]);
        }
        assert.deepEqual(await repository.listOrphanRecoveryCandidates({ before: new Date(now - 300_000), limit: 10 }), []);
      }
      assert.equal((await models.sessions.findById(sessionId)).failedAt.getTime(), old.getTime());
      assert.equal((await models.reelRecoveries.findById(reelRecoveryId)).finishedAt.getTime(), old.getTime());
    });

    await t.test("real lease contention, expiry and stale-token rejection preserve one operation owner", async () => {
      const operation = await recordOperation({ type: "delete", assetId: objectId(), libraryId,
        providerGuid: "lease-test", dedupeKey: `${prefix}-lease` });
      const claims = await Promise.all([0, 1].map(() => claimVideoProviderOperationById({ operationId: operation._id, model: models.operations })));
      const claimed = claims.filter(Boolean);
      assert.equal(claimed.length, 1);
      await models.operations.updateOne({ _id: operation._id }, { $set: { leaseExpiresAt: new Date(Date.now() - 1) } });
      const next = await claimVideoProviderOperationById({ operationId: operation._id, model: models.operations });
      assert.ok(next);
      assert.equal(await completeVideoProviderOperation({ operationId: operation._id,
        leaseToken: claimed[0].leaseToken, model: models.operations }), null);
      assert.ok(await completeVideoProviderOperation({ operationId: operation._id, leaseToken: next.leaseToken, model: models.operations }));
    });

    const hosted = new Map();
    const provider = {
      async searchReelReservation({ providerTitle }) {
        const items = [...hosted.values()].filter(video => video.title === providerTitle);
        return { items, totalItems: items.length, currentPage: 1 };
      },
      async searchProductReservation(input) { return this.searchReelReservation(input); },
      async getVideo(guid) { if (!hosted.has(guid)) throw { status: 404 }; return hosted.get(guid); },
      async deleteVideo(guid) { hosted.delete(guid); },
    };
    const enqueueLost = async () => { throw new Error("Injected enqueue loss"); };
    const productVideos = createProductVideoService({ repository: productRepository, provider,
      allowOrphanCleanup: true, enqueue: enqueueLost, invalidateCaches: async () => assert.fail("Orphan adoption cannot alter current media") });
    const discovery = createReelOrphanDiscovery({ repository: reelRepository, provider, libraryId,
      allowCleanup: true, enqueue: enqueueLost });
    const orphanRecovery = createVideoOrphanRecovery({ productRepository, reelRepository, productVideos, reelDiscovery: discovery });

    await t.test("automatic discovery and real transactional adoption survive lost enqueue acknowledgments", async () => {
      const sessionId = objectId();
      const guid = `orphan-${sessionId}`;
      const marker = `petyard-reel-session:${sessionId}`;
      await models.sessions.collection.insertOne({ _id: sessionId, videoId: objectId(), status: "failed",
        providerTitle: marker, createdAt: old, failedAt: new Date(old.getTime() + 1_000), updatedAt: old });
      hosted.set(guid, { guid, title: marker, videoLibraryId: Number(libraryId), dateUploaded: old.toISOString(),
        status: 0, length: 0, storageSize: 0, encodeProgress: 0, availableResolutions: null });
      const summary = await orphanRecovery.sweep({ limit: 10 });
      assert.equal(summary.cleanupRecorded, 1);
      assert.equal(await models.assets.countDocuments({ libraryId, providerGuid: guid }), 1);
      assert.equal(await models.operations.countDocuments({ libraryId, providerGuid: guid, status: "pending" }), 1);
      assert.deepEqual(await orphanRecovery.sweep({ limit: 10 }), { found: 0, examined: 0, cleanupRecorded: 0, deferred: 0, failed: 0 });
    });

    await t.test("isolated Redis connection loss preserves Mongo obligations and a restarted BullMQ worker completes cleanup", async () => {
      redis = new IORedis(process.env.VIDEOS_ACCEPTANCE_REDIS_URL || "redis://127.0.0.1:6379", {
        lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null, connectTimeout: 5_000 });
      redis.on("error", () => {});
      await redis.connect();
      assert.equal(await redis.ping(), "PONG");
      assert.deepEqual(await ownedRedisKeys(), [], "Redis acceptance namespace must also be unused");
      queue = new Queue(VIDEO_PROVIDER_QUEUE_NAME, { connection: redis, prefix });
      const enqueue = id => queue.add(VIDEO_PROVIDER_JOB_NAME, { operationId: String(id) }, { jobId: String(id) });
      const runtime = createVideoProviderRuntime({ provider, enqueue, assets: createVideoAssetObserver({ model: models.assets }),
        operations: {
          claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations }),
          complete: input => completeVideoProviderOperation({ ...input, model: models.operations }),
          fail: input => failVideoProviderOperation({ ...input, model: models.operations }),
          listDueIds: input => listDueVideoProviderOperationIds({ ...input, model: models.operations }),
        } });
      worker = new Worker(VIDEO_PROVIDER_QUEUE_NAME, job => runtime.process(job.data.operationId), {
        connection: redis, prefix, autorun: false, concurrency: 2 });
      worker.on("error", () => {});
      running = worker.run();
      await worker.waitUntilReady();
      await worker.close();
      await running;
      worker = null;
      running = undefined;
      // Disconnect only this test's client. Other local queues and Redis stay running.
      redis.disconnect();
      assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
      assert.equal(await models.operations.countDocuments({ status: "pending" }), 1);
      await redis.connect();
      const summary = await runtime.sweep();
      assert.equal(summary.queued, 1);
      // Leave the job queued with no worker, then start a new worker instance.
      assert.equal(await queue.getWaitingCount(), 1);
      worker = new Worker(VIDEO_PROVIDER_QUEUE_NAME, job => runtime.process(job.data.operationId), {
        connection: redis, prefix, autorun: false, concurrency: 2 });
      worker.on("error", () => {});
      running = worker.run();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && await models.operations.countDocuments({ status: "pending" })) await delay(50);
      while (Date.now() < deadline && await models.operations.countDocuments({ status: "running" })) await delay(50);
      assert.equal(await models.operations.countDocuments({ status: "pending" }), 0);
      assert.equal(await models.operations.countDocuments({ status: "running" }), 0);
      assert.equal(hosted.size, 0);
      assert.equal(await models.assets.countDocuments({ technicalState: "deleted" }), 1);
    });
    await verifyVideoDatabaseFlows(t, { models, connection, libraryId, recordOperation });
    await verifyVideoDatabaseUploadRecovery(t, { models, connection, libraryId, recordOperation });
    await t.test("the real Mongo TTL monitor removes expired playback, event, daily and attempt canaries", async () => {
      const deadline = Date.now() + 75_000;
      const remaining = async () => (await Promise.all(ttlCanaries.map(([model, document]) =>
        model.countDocuments({ _id: document._id })))).reduce((sum, count) => sum + count, 0);
      while (await remaining() && Date.now() < deadline) await delay(500);
      assert.equal(await remaining(), 0, "All expired canaries must be removed by MongoDB, not application cleanup");
    });
  } finally {
    const cleanupErrors = [];
    const cleanup = async (name, action) => {
      try { await action(); }
      catch (error) { cleanupErrors.push(`${name}: ${error?.name || "cleanup error"}`); }
    };
    await cleanup("worker close", () => worker?.close());
    await cleanup("worker run", () => running);
    if (queue) {
      await cleanup("queue removal", async () => {
        assert.equal(queue.opts.prefix, prefix);
        await queue.obliterate({ force: true });
      });
      await cleanup("queue close", () => queue.close());
      if (redis?.status === "ready") await cleanup("queue removal verification", async () => {
        assert.deepEqual(await ownedRedisKeys(), [], "Temporary queue keys must be removed");
      });
    }
    await cleanup("Redis disconnect", () => redis?.disconnect());
    if (connection.readyState === 1) {
      for (const name of owned) {
        await cleanup(`collection ${name}`, async () => {
          assert.ok(name.startsWith(`${prefix}_`));
          const metadata = await connection.db.listCollections({ name }).toArray();
          if (!metadata.length) return;
          assert.equal(metadata[0].options?.validator?.$jsonSchema?.description, prefix,
            "Only collections carrying this run's marker may be dropped");
          try { await connection.dropCollection(name); }
          catch (error) { if (error?.code !== 26) throw error; }
        });
      }
      await cleanup("collection removal verification", async () => {
        const remaining = await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray();
        assert.equal(remaining.length, 0, "Temporary acceptance collections must be removed");
      });
    }
    await cleanup("MongoDB close", () => connection.close());
    assert.deepEqual(cleanupErrors, [], "All acceptance resources must be cleaned up");
  }
});
