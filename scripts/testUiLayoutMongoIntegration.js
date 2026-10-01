// Opt-in integration check. Requires explicit test URI/target environment variables.
// Copy mode is restricted to the approved copied database and removes only UI Builder collections
// that were confirmed absent before the test. Temporary mode creates and drops a unique database.
import "@dotenvx/dotenvx/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { QueueEvents, Worker } from "bullmq";
import express from "express";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import sharp from "sharp";
import { deleteImage } from "../src/shared/utils/imageUpload.js";
import { getMediaConfiguration } from "../src/shared/utils/mediaConfig.js";
import { downloadBunnyObject, getBunnyObjectKeyFromUrl } from "../src/shared/utils/bunnyStorage.js";
import cloudinary from "../src/shared/utils/cloudinary.js";
import { createUiLayoutService } from "../src/domains/uiLayout/uiLayout.service.js";
import { UserModel } from "../src/domains/user/user.model.js";
import { HomeLayoutModel } from "../src/domains/homeLayout/homeLayout.model.js";
import homeLayoutRoutes from "../src/domains/homeLayout/homeLayout.routes.js";
import { globalError } from "../src/shared/middlewares/errorMiddleware.js";
import {
  adminUiBuilderRouter, adminUiLayoutRouter, publicUiLayoutRouter,
  publicUiLayoutPreviewRouter,
} from "../src/domains/uiLayout/uiLayout.routes.js";
import { bullMqConfig, createBullMqConnection } from "../src/config/bullmq.js";
import { createUiLayoutJobProcessor } from "../src/domains/uiLayout/uiLayout.jobs.js";
import {
  UI_LAYOUT_QUEUE_NAME, startUiLayoutReconciliation, closeUiLayoutQueue, enqueueUiLayoutSchedule,
} from "../src/domains/uiLayout/uiLayout.queue.js";
import {
  UiLayoutModel, UiLayoutDraftModel, UiLayoutPublicationModel, UiLayoutActiveModel,
  UiLayoutPreviewModel, UiLayoutAuditModel, UiLayoutOperationModel, UiLayoutAssetModel,
} from "../src/domains/uiLayout/uiLayout.model.js";

const databaseName = `petyard_ui_builder_it_${randomUUID().replaceAll("-", "")}`;
const databaseNamePattern = /^petyard_ui_builder_it_[0-9a-f]{32}$/;
const copyHost = "magdy.pbupj.mongodb.net";
const copyDatabase = "petyard";
const uiCollectionNames = [
  UiLayoutModel, UiLayoutDraftModel, UiLayoutPublicationModel, UiLayoutActiveModel,
  UiLayoutPreviewModel, UiLayoutAuditModel, UiLayoutOperationModel, UiLayoutAssetModel,
].map((model) => model.collection.collectionName);
const actorId = "507f1f77bcf86cd799439011";
let cleanupMode = null;
let cleanupConfirmed = false;
let stage = "connect";

function assertTestDatabase() {
  if (cleanupMode === "copy") {
    assert.equal(mongoose.connection.name, copyDatabase,
      "Refusing to clean up outside the approved copied database");
  } else {
    assert.match(databaseName, databaseNamePattern);
    assert.equal(mongoose.connection.name, databaseName,
      "Refusing to use a connection outside the temporary integration database");
  }
}

function layoutContent(sectionName) {
  return {
    sections: [{
      id: randomUUID(), section_type: "banners", name: sectionName, position: 0, data: {},
    }],
    navigation: { items: [{
      key: "home", label_key: "home", icon_key: "home",
      destination: "home", order: 0, enabled: true,
    }] },
    floating_action_button: { enabled: true, key: "chatbot", icon_key: "chatbot",
      action: { type: "route", destination: "chatbot" } },
  };
}

async function runHttpFlow({ superAdminId, ordinaryUserId, firstVersionId, legacyLayoutExists }) {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPublishFlag = process.env.UI_BUILDER_PUBLISH_ENABLED;
  const originalCutoverFlag = process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED;
  process.env.REDIS_URL = "";
  process.env.UI_BUILDER_PUBLISH_ENABLED = "false";
  process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = "false";

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => { req.requestId = randomUUID(); next(); });
  app.use("/api/v1/home-layout", homeLayoutRoutes);
  app.use("/api/v1/home-layout/preview", publicUiLayoutPreviewRouter);
  app.use("/api/v1/ui-layouts", publicUiLayoutRouter);
  app.use("/api/v1/admin/ui-builder", adminUiBuilderRouter);
  app.use("/api/v1/admin/home-layouts", adminUiLayoutRouter);
  app.use(globalError);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const superToken = jwt.sign({ userId: String(superAdminId) }, process.env.JWT_ACCESS_SECRET);
  const ordinaryToken = jwt.sign({ userId: String(ordinaryUserId) }, process.env.JWT_ACCESS_SECRET);
  const request = (path, { method = "GET", token, body, headers = {} } = {}) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let uploadedAsset;
  let uploadedDescriptor;
  try {
    const catalogPath = "/api/v1/admin/ui-builder/catalog";
    const unauthenticated = await request(catalogPath);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "UNAUTHORIZED");
    const forbidden = await request(catalogPath, { token: ordinaryToken });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
    const catalog = await request(catalogPath, { token: superToken });
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json();
    assert.equal(catalogBody.data.schema_version, 1);
    assert.equal(catalogBody.data.capabilities.publish_now, false);
    assert.ok(catalogBody.meta.request_id);

    const assetPath = "/api/v1/admin/ui-builder/assets";
    const imageBuffer = await sharp({ create: { width: 2, height: 2, channels: 3,
      background: "#ffffff" } }).png().toBuffer();
    const spoofedImage = new FormData();
    spoofedImage.set("usage", "promo");
    spoofedImage.set("image", new Blob([imageBuffer], { type: "image/svg+xml" }), "spoofed.svg");
    const rejectedImage = await fetch(`${baseUrl}${assetPath}`, { method: "POST",
      headers: { Authorization: `Bearer ${superToken}` }, body: spoofedImage });
    assert.equal(rejectedImage.status, 400);
    assert.equal((await rejectedImage.json()).error.code, "UI_ASSET_INVALID_FILE");
    const assetList = await request(assetPath, { token: superToken });
    assert.equal(assetList.status, 200);
    assert.deepEqual((await assetList.json()).data.items, []);

    if (process.env.UI_LAYOUT_TEST_MEDIA === "true") {
      const image = new FormData();
      image.set("usage", "promo");
      image.set("image", new Blob([imageBuffer], { type: "image/png" }), "ui-builder-canary.png");
      const uploaded = await fetch(`${baseUrl}${assetPath}`, { method: "POST",
        headers: { Authorization: `Bearer ${superToken}` }, body: image });
      const uploadBody = await uploaded.json();
      assert.equal(uploaded.status, 201,
        `Real media upload must succeed (code: ${uploadBody.error?.code ?? "unknown"})`);
      uploadedAsset = uploadBody.data;
      const stored = await UiLayoutAssetModel.findOne({ id: uploadedAsset.id });
      assert.ok(stored);
      uploadedDescriptor = { public_id: stored.publicId, url: stored.url };
      assert.match(stored.publicId, /^petyard\/ui-builder\/[0-9a-f-]{36}$/);
      assert.equal(uploadedAsset.status, "ready");
      assert.equal(uploadedAsset.width, 2);
      assert.equal(uploadedAsset.height, 2);
      const publicImage = await fetch(uploadedAsset.url, { signal: AbortSignal.timeout(30000) });
      assert.equal(publicImage.status, 200, "Uploaded image must be publicly accessible");
      const metadata = await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, 2);
      assert.equal(metadata.height, 2);
      const library = await request(assetPath, { token: superToken });
      assert.equal((await library.json()).data.items[0].id, uploadedAsset.id);
      console.log("PASS: real multipart image upload, ready asset library, and public WebP URL");
    }

    const draftsPath = "/api/v1/admin/home-layouts/drafts";
    const invalidCreate = await request(draftsPath, { method: "POST", token: superToken,
      body: { layout_key: "other", name: "HTTP test", source: { type: "blank" } } });
    assert.equal(invalidCreate.status, 400);
    assert.equal((await invalidCreate.json()).error.code, "UI_LAYOUT_UNSUPPORTED_KEY");
    const createdResponse = await request(draftsPath, { method: "POST", token: superToken,
      body: { layout_key: "customer_home", name: "HTTP integration home",
        source: { type: "blank" } } });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).data;
    assert.equal(created.revision, 1);

    const draftPath = `${draftsPath}/${created.id}`;
    const patchBody = { name: created.name, targeting: created.targeting,
      content: layoutContent("HTTP banners") };
    if (uploadedAsset) {
      patchBody.content.sections[0].section_type = "admin_promo";
      patchBody.content.sections[0].data = { enabled: true, visibility: "all",
        layout: "full_banner", title: "Media canary", image_url: uploadedAsset.url };
    }
    const missingIfMatch = await request(draftPath, { method: "PATCH", token: superToken,
      body: patchBody });
    assert.equal(missingIfMatch.status, 400);
    assert.equal((await missingIfMatch.json()).error.code, "UI_DRAFT_IF_MATCH_REQUIRED");
    const mutationId = randomUUID();
    const patchHeaders = { "If-Match": '"1"', "X-Client-Mutation-Id": mutationId };
    const [savedResponse, concurrentSaveRetry] = await Promise.all([0, 1].map(() =>
      request(draftPath, { method: "PATCH", token: superToken,
        headers: patchHeaders, body: patchBody })));
    assert.equal(savedResponse.status, 200);
    assert.equal(concurrentSaveRetry.status, 200, "Concurrent autosave retry must return the same result");
    const saved = (await savedResponse.json()).data;
    assert.equal(saved.revision, 2);
    assert.deepEqual((await concurrentSaveRetry.json()).data, saved);
    const retryResponse = await request(draftPath, { method: "PATCH", token: superToken,
      headers: patchHeaders, body: patchBody });
    assert.equal(retryResponse.status, 200);
    assert.deepEqual((await retryResponse.json()).data, saved);
    const fetchedDraft = await request(draftPath, { token: superToken });
    assert.equal(fetchedDraft.status, 200);
    assert.deepEqual((await fetchedDraft.json()).data.content.sections[0].data,
      patchBody.content.sections[0].data);

    const validated = await request(`${draftPath}/validate`, {
      method: "POST", token: superToken, body: {},
    });
    assert.equal(validated.status, 200);
    assert.equal((await validated.json()).data.valid, true);
    const previewResponse = await request(`${draftPath}/preview`, {
      method: "POST", token: superToken, body: { revision: 2, platform: "android" },
    });
    assert.equal(previewResponse.status, 201);
    const preview = (await previewResponse.json()).data;
    const previewRead = await request(`/api/v1/home-layout/preview?token=${encodeURIComponent(preview.token)}`);
    assert.equal(previewRead.status, 200);
    const previewBody = await previewRead.json();
    assert.equal(previewBody.data.sections[0].name, "HTTP banners");
    if (uploadedAsset) assert.equal(previewBody.data.sections[0].data.image_url, uploadedAsset.url);
    const revoked = await request(`/api/v1/admin/home-layouts/previews/${preview.preview_id}`, {
      method: "DELETE", token: superToken,
    });
    assert.equal(revoked.status, 204);
    const expired = await request(`/api/v1/home-layout/preview?token=${encodeURIComponent(preview.token)}`);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, "UI_PREVIEW_EXPIRED");

    const publishPath = `${draftPath}/publish`;
    const publishBody = { revision: 2, mode: "now", change_note: "HTTP integration publish" };
    const publishHeaders = { "Idempotency-Key": randomUUID() };
    const disabled = await request(publishPath, { method: "POST", token: superToken,
      body: publishBody, headers: publishHeaders });
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).error.code, "UI_LAYOUT_RELEASE_DISABLED");
    process.env.UI_BUILDER_PUBLISH_ENABLED = "true";
    const [publishedResponse, concurrentPublishRetry] = await Promise.all([0, 1].map(() =>
      request(publishPath, { method: "POST", token: superToken,
        body: publishBody, headers: publishHeaders })));
    assert.equal(publishedResponse.status, 201);
    assert.equal(concurrentPublishRetry.status, 201, "Concurrent publish retry must return the same result");
    const published = (await publishedResponse.json()).data;
    assert.deepEqual((await concurrentPublishRetry.json()).data, published);
    assert.equal(published.version_number, 4);
    const publishRetry = await request(publishPath, { method: "POST", token: superToken,
      body: publishBody, headers: publishHeaders });
    assert.equal(publishRetry.status, 201);
    assert.deepEqual((await publishRetry.json()).data, published);

    const publicPath = "/api/v1/ui-layouts/customer_home";
    const publicResponse = await request(publicPath, { headers: { "X-App-Platform": "android" } });
    assert.equal(publicResponse.status, 200);
    const etag = publicResponse.headers.get("etag");
    assert.ok(etag);
    const publicBody = await publicResponse.json();
    assert.equal(publicBody.data.version_id, published.version_id);
    assert.equal(publicBody.data.sections[0].name, "HTTP banners");
    assert.deepEqual(publicBody.data.sections[0].data, patchBody.content.sections[0].data);
    assert.equal(publicBody.data.floating_action_button, undefined);
    const notModified = await request(publicPath, { headers: { "If-None-Match": etag } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");

    const historyResponse = await request("/api/v1/admin/home-layouts/history", { token: superToken });
    assert.equal(historyResponse.status, 200);
    assert.equal((await historyResponse.json()).data.items[0].version_id, published.version_id);
    const rollbackHeaders = { "Idempotency-Key": randomUUID() };
    const [rollbackResponse, concurrentRollbackRetry] = await Promise.all([0, 1].map(() => request(
      `/api/v1/admin/home-layouts/versions/${firstVersionId}/rollback`, {
        method: "POST", token: superToken, body: { change_note: "HTTP integration rollback" },
        headers: rollbackHeaders,
      })));
    assert.equal(rollbackResponse.status, 201);
    assert.equal(concurrentRollbackRetry.status, 201);
    const rollbackBody = (await rollbackResponse.json()).data;
    assert.equal(rollbackBody.version_number, 5);
    assert.deepEqual((await concurrentRollbackRetry.json()).data, rollbackBody);
    const rolledBackPublic = await request(publicPath);
    assert.equal((await rolledBackPublic.json()).data.sections[0].name, "First banners");

    if (legacyLayoutExists) {
      const legacy = await request("/api/v1/home-layout");
      assert.equal(legacy.status, 200);
      const legacyBody = await legacy.json();
      assert.ok(Array.isArray(legacyBody.data.sections));
      assert.equal(legacyBody.data.navigation, undefined);
      process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = "true";
      const cutover = await request("/api/v1/home-layout");
      assert.equal(cutover.status, 200);
      assert.equal((await cutover.json()).data.version_number, 5);
      process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = "false";
    }
    console.log("PASS: HTTP auth, rejected image upload, validation, draft save/retry, preview/revoke, " +
      "concurrent autosave/publish/rollback retries, publish gate, public ETag, history, rollback" +
      (legacyLayoutExists ? ", and legacy/cutover routing" : " (legacy read skipped: no copied layout)"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalPublishFlag === undefined) delete process.env.UI_BUILDER_PUBLISH_ENABLED;
    else process.env.UI_BUILDER_PUBLISH_ENABLED = originalPublishFlag;
    if (originalCutoverFlag === undefined) delete process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED;
    else process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = originalCutoverFlag;
    if (uploadedDescriptor) {
      await deleteImage(uploadedDescriptor);
      const config = getMediaConfiguration();
      if (config.publicProvider === "bunny") {
        const objectKey = getBunnyObjectKeyFromUrl({ url: uploadedDescriptor.url,
          cdnBaseUrl: config.public.cdnBaseUrl, allowedRoot: "petyard" });
        assert.ok(objectKey);
        await assert.rejects(downloadBunnyObject({ ...config.public, objectKey,
          timeoutMs: config.storageTimeoutMs }), (error) => error.statusCode === 404,
        "Media cleanup must be verified at storage; the CDN may still cache the image");
      } else {
        await assert.rejects(cloudinary.api.resource(uploadedDescriptor.public_id),
          (error) => error.error?.http_code === 404 || error.http_code === 404);
      }
      console.log("Temporary media object removed; provider absence confirmed (CDN cache may remain).");
    }
  }
}

async function listRedisPrefixKeys(redis, prefix) {
  let cursor = "0";
  const keys = [];
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function runRedisWorkerFlow({ service, expectedVersion, scheduledDraft }) {
  const standalone = process.env.UI_LAYOUT_TEST_STANDALONE_WORKER === "true";
  const prefix = process.env.UI_LAYOUT_TEST_REDIS_PREFIX;
  assert.match(prefix ?? "", /^ui-layout-it-[0-9a-f]{32}$/,
    "An isolated Redis test prefix is required");
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.equal(redisUrl.protocol, "redis:");
  assert.ok(["127.0.0.1", "localhost"].includes(redisUrl.hostname),
    "Refusing to write to a non-local Redis server");
  assert.equal(bullMqConfig.prefix, prefix, "BullMQ must use the isolated test prefix");
  assert.equal(bullMqConfig.redisUrl, process.env.REDIS_URL,
    "BullMQ must use the checked local Redis URL");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true,
    connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  let events;
  let eventConnection;
  let worker;
  let workerConnection;
  let workerProcess;
  let workerStarted = false;
  let workerExited;
  let ownsPrefix = false;
  try {
    await redis.connect();
    assert.equal(await redis.ping(), "PONG");
    assert.deepEqual(await listRedisPrefixKeys(redis, prefix), [],
      "Redis test prefix is not empty; refusing to write or delete it");
    ownsPrefix = true;
    eventConnection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    events = new QueueEvents(UI_LAYOUT_QUEUE_NAME, { connection: eventConnection, prefix });
    await events.waitUntilReady();
    if (!standalone) {
      workerConnection = createBullMqConnection("ui-layout-test-worker");
      const processor = createUiLayoutJobProcessor();
      worker = new Worker(UI_LAYOUT_QUEUE_NAME, processor.process,
        { connection: workerConnection, prefix, concurrency: 1 });
      let workerError;
      worker.on("error", (error) => { workerError = error; });
      worker.on("failed", async (job) => { await processor.handleFailed(job); });
      await worker.waitUntilReady();
      if (workerError) throw workerError;
    }
    if (standalone) {
      assert.equal((await service.getPublic({ audience: "guest" })).version_number,
        expectedVersion - 1, "The old version must remain live while the job is delayed");
      await enqueueUiLayoutSchedule(scheduledDraft);
    }
    const published = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(new Error("Timed out waiting for BullMQ publish")),
        standalone ? 180000 : 90000);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      }
      events.on("completed", async () => {
        try {
          const current = await service.getPublic({ audience: "guest" });
          if (current.version_number === expectedVersion) finish(null, current);
        } catch (error) { finish(error); }
      });
      events.on("failed", (event) => finish(new Error(`BullMQ job failed: ${event.failedReason}`)));
      worker?.on("error", (error) => finish(error));
      if (standalone) {
        workerProcess = spawn(process.execPath, ["src/workers/uiLayoutPublish.worker.js"], {
          cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, MONGO_URI: process.env.UI_LAYOUT_TEST_MONGO_URI,
            UI_BUILDER_PUBLISH_ENABLED: "true", UI_BUILDER_PUBLIC_CUTOVER_ENABLED: "false" },
        });
        workerExited = new Promise((done) => workerProcess.once("close", done));
        let startupOutput = "";
        workerProcess.stdout.on("data", (chunk) => {
          startupOutput = (startupOutput + chunk.toString()).slice(-4096);
          if (startupOutput.includes("[UI Layout Publish Worker] Started")) workerStarted = true;
        });
        workerProcess.stderr.resume();
        workerProcess.on("error", (error) => finish(error));
        workerProcess.on("exit", (code) => finish(new Error(`Standalone worker exited early: ${code}`)));
      } else startUiLayoutReconciliation().catch((error) => finish(error));
    });
    assert.equal(published.sections[0].name, "Redis banners");
    if (standalone) {
      assert.ok(workerStarted, "The separate worker must finish startup");
      assert.ok(Date.now() >= new Date(scheduledDraft.scheduled_for).getTime(),
        "The real delayed job must not publish before its UTC scheduled time");
    }
    console.log(standalone
      ? "PASS: standalone worker startup and real delayed UTC publication through local Redis/BullMQ"
      : "PASS: real local Redis/BullMQ reconciliation and scheduled publish processor");
  } finally {
    let cleanupFailure;
    if (workerProcess && workerProcess.exitCode === null && workerProcess.signalCode === null) {
      workerProcess.kill("SIGTERM");
      await workerExited;
    }
    try { await worker?.close(); } catch (error) { cleanupFailure = error; }
    try { await closeUiLayoutQueue(); } catch (error) { cleanupFailure ??= error; }
    try { await workerConnection?.quit(); } catch (error) { cleanupFailure ??= error; }
    try { await events?.close(); } catch (error) { cleanupFailure ??= error; }
    eventConnection?.disconnect();
    try {
      if (ownsPrefix) {
        const keys = await listRedisPrefixKeys(redis, prefix);
        for (const key of keys) await redis.unlink(key);
        assert.deepEqual(await listRedisPrefixKeys(redis, prefix), [],
          "Redis test keys remain after cleanup");
        console.log("Isolated Redis test keys removed and cleanup confirmed.");
      }
    } catch (error) { cleanupFailure ??= error; }
    redis.disconnect();
    if (cleanupFailure) throw cleanupFailure;
  }
}

async function run() {
  const suppliedUri = process.env.UI_LAYOUT_TEST_MONGO_URI;
  const expectedHost = process.env.UI_LAYOUT_TEST_EXPECTED_HOST;
  const expectedSourceDatabase = process.env.UI_LAYOUT_TEST_SOURCE_DB;
  const mode = process.env.UI_LAYOUT_TEST_MODE ?? "temporary";
  assert.ok(suppliedUri && expectedHost && expectedSourceDatabase,
    "Explicit test URI, expected host, and source database are required");
  assert.ok(["temporary", "copy"].includes(mode), "Test mode must be temporary or copy");
  if (process.env.UI_LAYOUT_TEST_MEDIA === "true") {
    assert.equal(mode, "copy", "Real media integration requires copied-database HTTP checks");
  }
  if (process.env.UI_LAYOUT_TEST_STANDALONE_WORKER === "true") {
    assert.equal(mode, "copy", "Standalone worker integration requires the approved copied database");
    assert.equal(process.env.UI_LAYOUT_TEST_REDIS, "true", "Standalone worker integration requires local Redis checks");
  }
  const uri = new URL(suppliedUri);
  assert.equal(uri.hostname, expectedHost, "Refusing an unexpected MongoDB host");
  assert.equal(decodeURIComponent(uri.pathname.slice(1)), expectedSourceDatabase,
    "Refusing an unexpected source database");
  if (mode === "copy") {
    assert.equal(uri.hostname, copyHost, "Copy mode is restricted to the approved copy host");
    assert.equal(expectedSourceDatabase, copyDatabase,
      "Copy mode is restricted to the approved copied database");
  } else {
    const authSource = uri.searchParams.get("authSource") ??
      (uri.protocol === "mongodb+srv:" ? "admin" : decodeURIComponent(uri.pathname.slice(1)));
    assert.ok(authSource, "The MongoDB URI must identify its authentication database");
    uri.pathname = `/${databaseName}`;
    uri.searchParams.set("authSource", authSource);
  }
  await mongoose.connect(uri.toString(), {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 10000,
  });
  stage = "verify empty database";
  assert.equal(mongoose.connection.name, mode === "copy" ? copyDatabase : databaseName,
    "Refusing an unexpected selected database");
  const existingCollections = await mongoose.connection.db.listCollections().toArray();
  if (mode === "copy") {
    const existingUiCollections = existingCollections.filter((collection) =>
      uiCollectionNames.includes(collection.name));
    assert.deepEqual(existingUiCollections, [],
      "Copied database already has UI Builder collections; refusing to write or drop them");
    cleanupMode = "copy";
  } else {
    assert.equal(existingCollections.length, 0,
      "Temporary database is not empty; refusing to write or drop it");
    cleanupMode = "temporary";
  }
  stage = "exercise UI Builder service";
  let httpActors = null;
  if (mode === "copy") {
    assert.ok(process.env.JWT_ACCESS_SECRET, "JWT access secret is required for HTTP auth checks");
    const usableAccount = { active: true, phoneVerified: true, deletedAt: null,
      account_status: { $ne: "banned" } };
    const superAdmin = await UserModel.findOne({ ...usableAccount, role: "superAdmin" }).select("_id");
    const ordinaryUser = await UserModel.findOne({ ...usableAccount,
      role: { $ne: "superAdmin" } }).select("_id");
    assert.ok(superAdmin && ordinaryUser,
      "Copied database needs existing verified super-admin and non-super-admin accounts");
    httpActors = { superAdminId: superAdmin._id, ordinaryUserId: ordinaryUser._id,
      legacyLayoutExists: Boolean(await HomeLayoutModel.exists({})) };
  }

  let clock = new Date("2026-09-28T12:00:00.000Z");
  const service = createUiLayoutService({
    getOrSet: async (_key, _ttl, fetchFresh) => fetchFresh(),
    now: () => clock,
  });

  const first = await service.createDraft({
    name: "Integration home v1", source: { type: "blank" }, actorId,
  });
  assert.equal(first.revision, 1);
  const firstBody = {
    name: first.name, targeting: first.targeting, content: layoutContent("First banners"),
  };
  const firstMutationId = randomUUID();
  const saved = await service.saveDraft({
    id: first.id, revision: first.revision, body: firstBody,
    mutationId: firstMutationId, actorId,
  });
  assert.equal(saved.revision, 2);
  assert.deepEqual(await service.saveDraft({
    id: first.id, revision: first.revision, body: firstBody,
    mutationId: firstMutationId, actorId,
  }), saved);
  await assert.rejects(service.saveDraft({
    id: first.id, revision: first.revision, body: firstBody,
    mutationId: randomUUID(), actorId,
  }), (error) => error.code === "UI_DRAFT_REVISION_CONFLICT");
  assert.equal((await service.getDraft(first.id)).revision, 2);

  const validation = await service.validateDraft({ id: first.id, actorId });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const preview = await service.createPreview({
    id: first.id, revision: saved.revision, context: { platform: "android" }, actorId,
  });
  const previewResult = await service.getPreview(preview.token);
  assert.equal(previewResult.meta.preview, true);
  assert.equal(previewResult.data.sections[0].name, "First banners");
  await service.revokePreview({ id: preview.preview_id, actorId });
  await assert.rejects(service.getPreview(preview.token),
    (error) => error.code === "UI_PREVIEW_EXPIRED");

  const firstPublishKey = randomUUID();
  const published1 = await service.publish({
    id: first.id, revision: saved.revision, changeNote: "Integration first publish",
    idempotencyKey: firstPublishKey, actorId,
  });
  assert.equal(published1.version_number, 1);
  assert.deepEqual(await service.publish({
    id: first.id, revision: saved.revision, changeNote: "Integration first publish",
    idempotencyKey: firstPublishKey, actorId,
  }), published1);
  const public1 = await service.getPublic({ audience: "guest" });
  assert.equal(public1.version_id, published1.version_id);
  assert.equal(public1.sections[0].name, "First banners");
  assert.equal(public1.floating_action_button, undefined);

  const second = await service.createDraft({
    name: "Integration home v2",
    source: { type: "published", version_id: published1.version_id }, actorId,
  });
  assert.equal(second.based_on_version_id, published1.version_id);
  const secondContent = structuredClone(second.content);
  secondContent.sections[0].name = "Second banners";
  const saved2 = await service.saveDraft({
    id: second.id, revision: second.revision,
    body: { name: second.name, targeting: second.targeting, content: secondContent },
    mutationId: randomUUID(), actorId,
  });
  const scheduledFor = new Date(clock.getTime() + 180000).toISOString();
  const scheduleRequest = {
    id: second.id, revision: saved2.revision, scheduledFor,
    changeNote: "Integration scheduled publish", idempotencyKey: randomUUID(), actorId,
  };
  const [scheduled, concurrentScheduleRetry] = await Promise.all([0, 1].map(() =>
    service.schedule(scheduleRequest)));
  assert.deepEqual(concurrentScheduleRetry, scheduled);
  assert.equal(scheduled.status, "scheduled");
  assert.equal((await service.dueSchedules()).length, 0);
  clock = new Date(clock.getTime() + 181000);
  const due = await service.dueSchedules();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, second.id);
  const published2 = await service.publishScheduledDraft(due[0]);
  assert.equal(published2.version_number, 2);
  assert.equal((await service.getPublic({ audience: "guest" })).sections[0].name,
    "Second banners");
  assert.equal((await service.dueSchedules()).length, 0);

  const rolledBack = await service.rollback({
    versionId: published1.version_id, changeNote: "Integration rollback",
    idempotencyKey: randomUUID(), actorId,
  });
  assert.equal(rolledBack.version_number, 3);
  const public3 = await service.getPublic({ audience: "guest" });
  assert.equal(public3.version_id, rolledBack.version_id);
  assert.equal(public3.sections[0].name, "First banners");
  const history = await service.history();
  assert.deepEqual(history.items.map((item) => item.version_number), [3, 2, 1]);

  console.log("PASS: real MongoDB draft, revision/idempotency, preview/revoke, " +
    "publish, scheduled publish, rollback, and history");
  if (httpActors) {
    stage = "exercise HTTP routes";
    await runHttpFlow({ ...httpActors, firstVersionId: published1.version_id });
  }
  if (process.env.UI_LAYOUT_TEST_REDIS === "true") {
    assert.equal(mode, "copy", "Redis worker integration requires the approved copied database");
    stage = "exercise local Redis publish worker";
    assert.equal((await service.getPublic({ audience: "guest" })).version_number, 5);
    const redisDraft = await service.createDraft({ name: "Redis integration home",
      source: { type: "published", version_id: rolledBack.version_id }, actorId });
    const redisContent = structuredClone(redisDraft.content);
    redisContent.sections[0].name = "Redis banners";
    const redisSaved = await service.saveDraft({ id: redisDraft.id, revision: redisDraft.revision,
      body: { name: redisDraft.name, targeting: redisDraft.targeting, content: redisContent },
      mutationId: randomUUID(), actorId });
    const standalone = process.env.UI_LAYOUT_TEST_STANDALONE_WORKER === "true";
    if (standalone) clock = new Date();
    const redisScheduledFor = new Date(clock.getTime() + (standalone ? 125000 : 180000)).toISOString();
    const scheduledDraft = await service.schedule({ id: redisDraft.id, revision: redisSaved.revision,
      scheduledFor: redisScheduledFor, changeNote: "Local Redis worker integration",
      idempotencyKey: randomUUID(), actorId });
    await runRedisWorkerFlow({ service, expectedVersion: 6, scheduledDraft });
  }
}

try {
  await run();
} catch (error) {
  console.error("UI Builder MongoDB integration failed:", {
    stage, name: error.name, code: error.code ?? null, codeName: error.codeName ?? null,
    message: error.name === "AssertionError" ? error.message : "See error code; details hidden",
  });
  process.exitCode = 1;
} finally {
  if (cleanupMode) {
    try {
      assertTestDatabase();
      if (cleanupMode === "copy") {
        const createdCollections = await mongoose.connection.db.listCollections().toArray();
        for (const collection of createdCollections) {
          if (uiCollectionNames.includes(collection.name)) {
            await mongoose.connection.db.collection(collection.name).drop();
          }
        }
        const remaining = await mongoose.connection.db.listCollections().toArray();
        assert.deepEqual(remaining.filter((collection) => uiCollectionNames.includes(collection.name)), []);
      } else {
        await mongoose.connection.dropDatabase();
        assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), []);
      }
      cleanupConfirmed = true;
      console.log("UI Builder integration test data removed and cleanup confirmed.");
    } catch (error) {
      console.error("INTEGRATION TEST CLEANUP FAILED:", {
        database: cleanupMode === "copy" ? copyDatabase : databaseName,
        name: error.name, code: error.code ?? null,
      });
      process.exitCode = 1;
    }
  }
  await mongoose.disconnect();
  if (cleanupMode && !cleanupConfirmed) process.exitCode = 1;
}
