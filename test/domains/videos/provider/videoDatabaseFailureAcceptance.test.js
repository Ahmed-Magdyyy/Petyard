import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { VideoAssetModel } from "../../../../src/domains/videos/provider/videoAsset.model.js";
import { ReelUploadSessionModel } from "../../../../src/domains/videos/reels/reelUploadSession.model.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { ProductVideoModel } from "../../../../src/domains/videos/productVideos/productVideo.model.js";
import { VideoPlaybackSessionModel } from "../../../../src/domains/videos/analytics/videoPlaybackSession.model.js";
import { VideoAnalyticsEventModel } from "../../../../src/domains/videos/analytics/videoAnalyticsEvent.model.js";
import { VideoAnalyticsDailyModel } from "../../../../src/domains/videos/analytics/videoAnalyticsDaily.model.js";
import { createVideoAnalyticsRepository } from "../../../../src/domains/videos/analytics/videoAnalytics.repository.js";
import { createVideoAnalyticsService } from "../../../../src/domains/videos/analytics/videoAnalytics.service.js";

test("copied Mongo commit-response loss and disconnected playback-session issuance", {
  skip: process.env.VIDEOS_DATABASE_FAILURE_ACCEPTANCE_ENABLED !== "true", timeout: 90_000,
}, async t => {
  const uri = process.env.VIDEOS_ACCEPTANCE_MONGO_URI;
  assert.ok(uri, "Explicit approved copied Mongo URI required");
  const prefix = `videos_failure_acceptance_${randomBytes(12).toString("hex")}`;
  const connection = mongoose.createConnection(uri, { autoCreate: false, autoIndex: false,
    serverSelectionTimeoutMS: 10_000 });
  const owned = [], models = {};
  let namespaceVerified = false;
  try {
    try { await connection.asPromise(); }
    catch (error) { throw new Error(`Acceptance connection failed (${error?.name || "connection error"})`); }
    assert.equal((await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray()).length, 0);
    namespaceVerified = true;
    for (const [key, original] of Object.entries({ videos: EditorialVideoModel, assets: VideoAssetModel,
      uploads: ReelUploadSessionModel, products: ProductModel, placements: ProductVideoModel,
      playbackSessions: VideoPlaybackSessionModel, events: VideoAnalyticsEventModel, daily: VideoAnalyticsDailyModel })) {
      const name = `${prefix}_${original.collection.name}`;
      owned.push(name);
      await connection.db.createCollection(name, { validator: { $jsonSchema: { bsonType: "object", description: prefix } } });
      const schema = original.schema.clone(); schema.set("bufferCommands", false);
      models[key] = connection.model(original.modelName, schema, name);
      await models[key].createIndexes();
    }
    const contentId = new mongoose.Types.ObjectId();
    await models.videos.collection.insertOne({ _id: contentId, kind: "youtube", status: "published",
      youtubeId: "dQw4w9WgXcQ", publishedAt: new Date(), associationRevision: 0 });
    const repository = createVideoAnalyticsRepository({ ...models, connection });
    const service = createVideoAnalyticsService({ repository, isEnabled: () => true, isProductEnabled: () => true });
    const identity = { type: "guest", id: String(new mongoose.Types.ObjectId()) };
    const request = { body: { kind: "youtube", contentId: String(contentId) }, identity };

    await t.test("lost successful commit acknowledgment retries commit without duplicating event or totals", async () => {
      const issued = await service.issueSession(request);
      const event = { playbackSessionId: issued.playbackSessionId, eventId: randomUUID(),
        type: "share", occurredAt: new Date().toISOString() };
      const startSession = connection.startSession.bind(connection);
      let commitAttempts = 0, callbackAttempts = 0;
      connection.startSession = async (...args) => {
        const session = await startSession(...args);
        const commit = session.commitTransaction.bind(session);
        const transact = session.withTransaction.bind(session);
        session.withTransaction = (callback, options) => transact(async (...values) => {
          callbackAttempts++; return callback(...values);
        }, options);
        session.commitTransaction = async (...values) => {
          await commit(...values); commitAttempts++;
          if (commitAttempts === 1) {
            // Inject only the lost caller acknowledgment after a real successful server commit.
            const error = new mongoose.mongo.MongoNetworkError("Injected commit acknowledgment loss");
            error.addErrorLabel("UnknownTransactionCommitResult"); throw error;
          }
        };
        return session;
      };
      try {
        assert.deepEqual(await service.ingestEvents({ body: { events: [event] }, identity }), { accepted: 1, duplicates: 0 });
      } finally { connection.startSession = startSession; }
      assert.equal(commitAttempts, 2); assert.equal(callbackAttempts, 1);
      assert.equal(await models.events.countDocuments({ eventId: event.eventId }), 1);
      assert.equal((await models.playbackSessions.findById(issued.playbackSessionId)).eventCount, 1);
      assert.equal((await models.daily.findOne({ contentId })).shares, 1);
      assert.deepEqual(await service.ingestEvents({ body: { events: [event] }, identity }), { accepted: 0, duplicates: 1 });
      assert.equal((await models.daily.findOne({ contentId })).shares, 1);
    });

    await t.test("actual isolated Mongo client disconnect fails session issuance safely without creating a session", async () => {
      const before = await models.playbackSessions.countDocuments();
      await connection.close();
      await assert.rejects(service.issueSession(request), error => error.statusCode === 503 &&
        error.errors?.[0]?.code === "VIDEO_ANALYTICS_UNAVAILABLE" && error.message === "Video analytics temporarily unavailable");
      await connection.openUri(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10_000 });
      assert.equal(await models.playbackSessions.countDocuments(), before);
    });
  } finally {
    const failures = [];
    if (namespaceVerified) {
      if (connection.readyState !== 1) {
        try { await connection.openUri(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10_000 }); }
        catch { failures.push("cleanup-reconnect"); }
      }
      if (connection.readyState === 1) for (const name of owned) {
        try {
          assert.ok(name.startsWith(`${prefix}_`));
          const metadata = await connection.db.listCollections({ name }).toArray();
          if (!metadata.length) continue;
          assert.equal(metadata[0].options?.validator?.$jsonSchema?.description, prefix);
          await connection.dropCollection(name);
          assert.equal((await connection.db.listCollections({ name }).toArray()).length, 0);
        } catch { failures.push("owned-collection-cleanup"); }
      }
    }
    await connection.close();
    assert.deepEqual(failures, [], "Owned failure-acceptance collections must be absent");
  }
});
