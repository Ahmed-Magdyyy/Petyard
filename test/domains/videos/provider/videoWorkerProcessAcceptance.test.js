import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { Queue } from "bullmq";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test("standalone provider process restarts with durable isolated obligations", {
  skip: process.env.VIDEOS_ACCEPTANCE_ENABLED !== "true", timeout: 180_000,
}, async () => {
  const uri = process.env.VIDEOS_ACCEPTANCE_MONGO_URI;
  assert.ok(uri, "Explicitly approved Mongo copy is required");
  const prefix = `videos_worker_acceptance_${randomBytes(12).toString("hex")}`;
  const connection = mongoose.createConnection(uri, { autoCreate: false, autoIndex: false,
    serverSelectionTimeoutMS: 15_000 });
  let child, queue, redis, syntheticAssetId = "";
  let namespaceVerified = false;
  const events = [];
  const waitFor = async (predicate, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate() && Date.now() < deadline) await delay(100);
    assert.ok(await predicate(), label);
  };
  const start = async (httpMode = "blocked") => {
    const processEvents = [];
    child = fork(new URL("./fixtures/videoWorkerProcessBootstrap.mjs", import.meta.url), [], {
      silent: true, execArgv: [], env: { ...process.env, MONGO_URI: uri,
        REDIS_URL: process.env.VIDEOS_ACCEPTANCE_REDIS_URL || "redis://127.0.0.1:6379",
        VIDEOS_WORKER_ACCEPTANCE_PREFIX: prefix, BULLMQ_QUEUE_PREFIX: prefix,
        VIDEOS_WORKER_ACCEPTANCE_HTTP_MODE: httpMode,
        VIDEOS_WORKER_ACCEPTANCE_ASSET_ID: syntheticAssetId,
        PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny", PRIVATE_MEDIA_STORAGE_PROVIDER: "cloudinary",
        BUNNY_PUBLIC_STORAGE_ZONE: "test-worker-acceptance", BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "test-only",
        BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com", BUNNY_PUBLIC_CDN_BASE_URL: "https://example.invalid",
        BUNNY_STREAM_LIBRARY_ID: "754739", BUNNY_STREAM_API_KEY: "test-only",
        BUNNY_STREAM_READ_ONLY_API_KEY: "test-only", BUNNY_STREAM_CDN_HOSTNAME: "example.invalid",
        BUNNY_STREAM_TOKEN_KEY: "test-only", VIDEOS_PUBLIC_ENABLED: "false", REEL_UPLOADS_ENABLED: "false",
        PRODUCT_VIDEO_UPLOADS_ENABLED: "false", PRODUCT_VIDEOS_PUBLIC_ENABLED: "false",
        VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED: "false", VIDEO_PROVIDER_SWEEP_INTERVAL_MS: "1000" },
    });
    child.on("message", message => { events.push(message); processEvents.push(message); });
    // Retain only fixed startup markers; never relay raw child diagnostics.
    child.stdout.on("data", data => {
      if (data.toString().includes("[Video Provider Worker] Started")) processEvents.push({ type: "started" });
    });
    child.stderr.resume();
    await waitFor(() => processEvents.some(event => event.type === "started"), "Actual worker must start");
    assert.ok(processEvents.some(event => event.type === "collections"));
  };
  try {
    try { await connection.asPromise(); }
    catch (error) { throw new Error(`Worker acceptance connection failed (${error?.name || "connection error"})`); }
    const existing = await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray();
    assert.equal(existing.length, 0); namespaceVerified = true;
    redis = new IORedis(process.env.VIDEOS_ACCEPTANCE_REDIS_URL || "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: null, connectTimeout: 5000 });
    redis.on("error", () => {});
    assert.equal(await redis.ping(), "PONG");
    assert.equal((await redis.keys(`${prefix}:*`)).length, 0);
    queue = new Queue("video-provider", { connection: redis, prefix });
    await start();
    const operations = connection.db.collection(`${prefix}_videoprovideroperations`);
    const id = new mongoose.Types.ObjectId();
    // Missing owner must leave a durable failure and must never reach Bunny.
    await operations.insertOne({ _id: id, type: "delete", assetId: new mongoose.Types.ObjectId(),
      libraryId: "754739", providerGuid: "synthetic-no-provider-resource", dedupeKey: `${prefix}-delete`,
      status: "pending", nextAttemptAt: new Date(), failedAttempts: 0 });
    await waitFor(async () => (await operations.findOne({ _id: id }))?.failedAttempts === 1,
      "Standalone sweeper must redispatch the unqueued obligation");
    assert.equal((await operations.findOne({ _id: id })).lastErrorCode, "VIDEO_DELETE_NOT_AUTHORIZED");
    const crash = once(child, "exit"); child.kill("SIGKILL"); await crash; child = null;
    await operations.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date() } });
    await start();
    await waitFor(async () => (await operations.findOne({ _id: id }))?.failedAttempts === 2,
      "Restart must recover durable due work without a provider side effect");
    assert.equal((await operations.findOne({ _id: id })).lastErrorCode, "VIDEO_DELETE_NOT_AUTHORIZED");
    const stopped = once(child, "exit"); child.send({ type: "shutdown" });
    const result = await stopped; assert.equal(result[0], 0); child = null;
    assert.equal(events.filter(event => event.type === "unexpected-http").length, 0);
    assert.ok(events.filter(event => event.type === "collections").length === 2);

    const assets = connection.db.collection(`${prefix}_videoassets`);
    const assetId = new mongoose.Types.ObjectId(), interruptedId = new mongoose.Types.ObjectId();
    syntheticAssetId = String(assetId);
    const guid = "00000000-0000-4000-8000-000000000001";
    await assets.insertOne({ _id: assetId, ownerType: "reel", ownerId: new mongoose.Types.ObjectId(),
      libraryId: "754739", providerGuid: guid, technicalState: "deleting", deletionRequestedAt: new Date() });
    await operations.insertOne({ _id: interruptedId, type: "delete", assetId,
      libraryId: "754739", providerGuid: guid, dedupeKey: `${prefix}-inflight-delete`,
      status: "pending", nextAttemptAt: new Date(), failedAttempts: 0 });
    await start("hold");
    await waitFor(() => events.some(event => event.type === "provider-delete-held"), "Worker must reach the held provider call");
    const interrupted = await operations.findOne({ _id: interruptedId });
    assert.equal(interrupted.status, "running"); assert.ok(interrupted.leaseToken);
    const killed = once(child, "exit"); child.kill("SIGKILL"); await killed; child = null;
    assert.equal((await operations.findOne({ _id: interruptedId })).status, "running");
    assert.equal((await assets.findOne({ _id: assetId })).technicalState, "deleting");
    // Advance only this owned lease; keep the real BullMQ stalled job for restart recovery.
    await operations.updateOne({ _id: interruptedId, leaseToken: interrupted.leaseToken },
      { $set: { leaseExpiresAt: new Date(0) } });
    await start("replay");
    try {
      // A retained active job can require two 30-second stalled checks after lock expiry.
      await waitFor(async () => (await operations.findOne({ _id: interruptedId }))?.status === "completed",
        "Restart must reclaim the interrupted job and complete durable cleanup", 90_000);
    } catch (error) {
      const operation = await operations.findOne({ _id: interruptedId });
      const job = await queue.getJob(String(interruptedId));
      console.log(JSON.stringify({ check: "worker-inflight-diagnostic", status: operation?.status,
        lastErrorCode: operation?.lastErrorCode, failedAttempts: operation?.failedAttempts,
        jobState: job ? await job.getState() : "absent",
        held: events.filter(event => event.type === "provider-delete-held").length,
        accepted: events.filter(event => event.type === "provider-delete-accepted").length,
        absent: events.filter(event => event.type === "provider-absence").length }));
      throw error;
    }
    assert.equal((await assets.findOne({ _id: assetId })).technicalState, "deleted");
    assert.equal(events.filter(event => event.type === "provider-delete-accepted").length, 1);
    assert.equal(events.filter(event => event.type === "poster-delete-accepted").length, 1);
    assert.equal(events.filter(event => event.type === "unexpected-http").length, 0);
    const finished = once(child, "exit"); child.send({ type: "shutdown" });
    assert.equal((await finished)[0], 0); child = null;
    console.log(JSON.stringify({ check: "worker-inflight-crash-restart", providerMocked: true,
      realEntryPoint: true, interruptedLeaseRecovered: true, bullMqJobRetained: true, cleanupCompleted: true }));
  } finally {
    const errors = [];
    const cleanup = async action => { try { await action(); } catch (error) { errors.push(error?.name || "cleanup error"); } };
    await cleanup(async () => { if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    } });
    await cleanup(() => queue?.obliterate({ force: true }));
    await cleanup(() => queue?.close());
    await cleanup(async () => { if (redis) assert.equal((await redis.keys(`${prefix}:*`)).length, 0); });
    redis?.disconnect();
    if (namespaceVerified && connection.readyState === 1) {
      const collections = await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray();
      for (const { name } of collections) await cleanup(() => connection.dropCollection(name));
      await cleanup(async () => assert.equal((await connection.db.listCollections({ name: { $regex: `^${prefix}_` } }).toArray()).length, 0));
    }
    await cleanup(() => connection.close());
    assert.deepEqual(errors, [], "Temporary worker resources must be removed");
  }
});
