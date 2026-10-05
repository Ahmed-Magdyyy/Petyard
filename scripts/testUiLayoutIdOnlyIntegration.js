// Opt-in checks against the approved copied cluster. Never writes to its source database.
// Only a verified-empty, uniquely named test database may be created and removed.
import "@dotenvx/dotenvx/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import sharp from "sharp";
import Redis from "ioredis";
import { Worker, QueueEvents } from "bullmq";
import { ProductModel } from "../src/domains/product/product.model.js";
import { UserModel } from "../src/domains/user/user.model.js";
import productRoutes from "../src/domains/product/product.routes.js";
import { productBatchBodyParser } from "../src/domains/product/productBatch.middleware.js";
import { i18nMiddleware } from "../src/shared/middlewares/i18nMiddleware.js";
import { globalError } from "../src/shared/middlewares/errorMiddleware.js";
import { adminUiBuilderRouter, adminUiLayoutRouter, publicUiLayoutRouter,
  publicUiLayoutPreviewRouter } from "../src/domains/uiLayout/uiLayout.routes.js";
import { createUiLayoutService } from "../src/domains/uiLayout/uiLayout.service.js";
import { collectLayoutReferences } from "../src/domains/uiLayout/uiLayout.productReferences.js";
import { UiLayoutAuditModel, UiLayoutDraftModel, UiLayoutAssetModel } from "../src/domains/uiLayout/uiLayout.model.js";
import { deleteImage } from "../src/shared/utils/imageUpload.js";
import { getMediaConfiguration } from "../src/shared/utils/mediaConfig.js";
import { downloadBunnyObject, getBunnyObjectKeyFromUrl } from "../src/shared/utils/bunnyStorage.js";
import cloudinary from "../src/shared/utils/cloudinary.js";
import { bullMqConfig } from "../src/config/bullmq.js";
import { createUiLayoutJobProcessor } from "../src/domains/uiLayout/uiLayout.jobs.js";
import { UI_LAYOUT_QUEUE_NAME, UI_LAYOUT_JOB_PUBLISH, enqueueUiLayoutSchedule,
  startUiLayoutReconciliation, closeUiLayoutQueue } from "../src/domains/uiLayout/uiLayout.queue.js";

const runId = randomUUID().replaceAll("-", "");
// This copied Atlas cluster limits database names to 38 bytes.
const databaseName = `petyard_ui_it_${runId.slice(0, 24)}`;
const prefix = `ui-layout-it-${runId}`;
let ownsDatabase = false, server, media, redis, worker, events;
let stage = "connect";
// These flags affect this test process only. No repository/server configuration is changed.
process.env.REDIS_URL = "";
process.env.UI_BUILDER_PUBLISH_ENABLED = "true";
process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = "false";
process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "false";
delete process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
const service = createUiLayoutService();

async function run() {
  const uri = new URL(process.env.UI_LAYOUT_TEST_MONGO_URI);
  assert.equal(uri.hostname, "magdy.pbupj.mongodb.net", "Only the approved copied cluster is allowed");
  assert.equal(uri.pathname, "/petyard");
  assert.ok(process.env.JWT_ACCESS_SECRET, "A local test JWT secret is required");
  // Preserve the source URI's authentication database/SRV options; change only the selected data database.
  await mongoose.connect(uri.toString(), { dbName: databaseName, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, databaseName);
  assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), []);
  ownsDatabase = true;

  stage = "copy public catalog fixtures";
  const source = mongoose.connection.getClient().db("petyard");
  // Read the largest 50 active BSON documents rather than hand-picked tiny DTOs.
  const products = await source.collection(ProductModel.collection.collectionName).aggregate([
    { $match: { isActive: true } }, { $addFields: { integration_size: { $bsonSize: "$$ROOT" } } },
    { $sort: { integration_size: -1, _id: 1 } }, { $limit: 50 }, { $project: { integration_size: 0 } },
  ], { maxTimeMS: 10000 }).toArray();
  assert.equal(products.length, 50, "The copied catalog must contain 50 active products for the maximum-size check");
  await ProductModel.collection.insertMany(products);
  for (const name of ["categories", "brands", "subcategories", "warehouses"]) {
    const rows = await source.collection(name).find({}).maxTimeMS(10000).toArray();
    if (rows.length) await mongoose.connection.db.collection(name).insertMany(rows);
  }
  const actor = new mongoose.Types.ObjectId(), customer = new mongoose.Types.ObjectId();
  await UserModel.collection.insertMany([actor, customer].map((_id, index) => ({
    _id, name: "isolated integration account", role: index ? "user" : "superAdmin",
    active: true, phoneVerified: true, account_status: "confirmed", deletedAt: null,
  })));
  const token = jwt.sign({ userId: String(actor) }, process.env.JWT_ACCESS_SECRET);
  const customerToken = jwt.sign({ userId: String(customer) }, process.env.JWT_ACCESS_SECRET);
  const fallbackDraft = await service.createDraft({ name: "Isolated legacy fallback", source: { type: "blank" }, actorId: String(actor) });
  await service.saveDraft({ id: fallbackDraft.id, revision: 1, actorId: String(actor), body: {
    name: fallbackDraft.name, targeting: fallbackDraft.targeting, content: {
      sections: [{ id: randomUUID(), section_type: "banners", name: "Legacy", position: 0, data: {} }],
      navigation: { items: [{ key: "home", label_key: "home", icon_key: "home", destination: "home", order: 0, enabled: true }] },
    },
  } });
  const fallback = await service.publish({ id: fallbackDraft.id, revision: 2, actorId: String(actor),
    changeNote: "Isolated legacy fallback", idempotencyKey: randomUUID() });
  const app = express();
  app.use("/api/v1/products/batch", productBatchBodyParser);
  app.use(express.json({ limit: "256kb" }), i18nMiddleware);
  app.use((req, _res, next) => { req.requestId = randomUUID(); next(); });
  app.use("/api/v1/products", productRoutes);
  app.use("/api/v1/admin/ui-builder", adminUiBuilderRouter);
  app.use("/api/v1/admin/home-layouts", adminUiLayoutRouter);
  app.use("/api/v1/home-layout/preview", publicUiLayoutPreviewRouter);
  app.use("/api/v1/ui-layouts", publicUiLayoutRouter);
  app.use(globalError);
  server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", body, headers = {}, auth = token } = {}) => fetch(base + path, {
    method, signal: AbortSignal.timeout(30000), headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path, options = {}, status = 200) => {
    const response = await request(path, options), body = await response.json();
    assert.equal(response.status, status, `${path}: ${body.error?.code ?? body.message ?? "unexpected status"}`);
    return body.data;
  };

  stage = "real multi-product HTTP and complete DTO parity";
  const ids = products.slice(0, 3).map((row) => String(row._id));
  const missing = String(new mongoose.Types.ObjectId());
  const batch = await json("/api/v1/products/batch", { method: "POST", auth: customerToken,
    headers: { "Accept-Language": "ar" }, body: { ids: [...ids, ids[0], missing] } });
  assert.deepEqual(batch.unavailable_product_ids, [missing]);
  assert.deepEqual(batch.products.map((row) => String(row.id)), ids);
  for (const product of batch.products) {
    const detail = await json(`/api/v1/products/${product.id}`, { auth: customerToken, headers: { "Accept-Language": "ar" } });
    assert.deepEqual(product, detail, "Batch must return the complete existing detail DTO");
  }
  for (const language of ["en", "ar"]) {
    for (const auth of [null, customerToken, token]) {
      const maximum = await request("/api/v1/products/batch", { method: "POST", auth,
        headers: { "Accept-Language": language }, body: { ids: products.map((row) => String(row._id)) } });
      const text = await maximum.text();
      assert.equal(maximum.status, 200, "The largest 50 copied catalog records must fit in one response");
      assert.equal(JSON.parse(text).data.products.length, 50);
      assert.ok(Buffer.byteLength(text) <= 2097152);
      console.log(`PASS: largest 50 copied products, ${language}, ${auth === token ? "staff" : auth ? "customer" : "guest"}, ${Buffer.byteLength(text)} response bytes`);
    }
  }

  stage = "new-profile HTTP lifecycle";
  let imageUrl = products.flatMap((row) => [...(row.images ?? []), ...(row.variants ?? []).flatMap((v) => v.images ?? [])])[0]?.url;
  assert.ok(imageUrl, "Copied public catalog media is required");
  if (process.env.UI_LAYOUT_TEST_MEDIA === "true") {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const form = new FormData(); form.set("usage", "promo");
    form.set("image", new Blob([png], { type: "image/png" }), "isolated-ui-layout.png");
    const response = await fetch(`${base}/api/v1/admin/ui-builder/assets`, { method: "POST",
      headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(30000) });
    const uploaded = await response.json();
    assert.equal(response.status, 201, uploaded.error?.code);
    // Save the known upload identity before any subsequent database read can fail.
    media = { public_id: `petyard/ui-builder/${uploaded.data.id}`, url: uploaded.data.url };
    const stored = await UiLayoutAssetModel.findOne({ id: uploaded.data.id });
    assert.equal(stored.publicId, media.public_id);
    imageUrl = stored.url;
    const read = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
    assert.equal(read.status, 200);
    assert.equal((await sharp(Buffer.from(await read.arrayBuffer())).metadata()).format, "webp");
    console.log("PASS: real multipart media upload and publicly readable processed WebP");
  }
  const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/uiLayout.idOnly.json", import.meta.url), "utf8"));
  const brand = new mongoose.Types.ObjectId(), category = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection("brands").insertOne({ _id: brand, name_en: "Fixture brand", name_ar: "علامة" });
  await mongoose.connection.db.collection("categories").insertOne({ _id: category, name_en: "Fixture category", name_ar: "فئة" });
  const replacements = new Map(fixture.content.product_ids.map((id, index) => [id, ids[index]]));
  for (const ref of collectLayoutReferences(fixture.content)) {
    if (ref.type === "product") ref.owner[ref.key] = replacements.get(ref.value);
    if (ref.type === "brand") ref.owner[ref.key] = String(brand);
    if (ref.type === "category") ref.owner[ref.key] = String(category);
  }
  function replaceImages(value) {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "image_url")) value.image_url = imageUrl;
    Object.values(value).forEach(replaceImages);
  }
  replaceImages(fixture.content);
  fixture.content.product_ids = ids;
  const drafts = "/api/v1/admin/home-layouts/drafts";
  const first = await json(drafts, { method: "POST", body: { layout_key: "customer_home", name: "Isolated profile", source: { type: "blank" } } }, 201);
  const path = `${drafts}/${first.id}`, mutationId = randomUUID();
  const patch = { name: fixture.name, targeting: fixture.targeting, content: fixture.content };
  const saveOptions = { method: "PATCH", body: patch, headers: { "If-Match": '"1"', "X-Client-Mutation-Id": mutationId } };
  const [saved, repeated] = await Promise.all([json(path, saveOptions), json(path, saveOptions)]);
  assert.deepEqual(saved, repeated); assert.deepEqual((await json(path)).content, fixture.content);
  const invalid = await json(`${path}/validate`, { method: "POST", body: {} });
  assert.ok(invalid.errors.some((error) => error.code === "CLIENT_VERSION_UNSUPPORTED"));
  const preview = await json(`${path}/preview`, { method: "POST", body: { revision: 2 } }, 201);
  const previewResponse = await request(`/api/v1/home-layout/preview?token=${preview.token}`, { auth: null });
  assert.match(previewResponse.headers.get("cache-control"), /no-store/);
  const previewBody = (await previewResponse.json()).data;
  assert.deepEqual(previewBody.sections, fixture.content.sections); assert.deepEqual(previewBody.product_ids, ids);
  process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION = "2.0.0"; // Synthetic test renderer only; not a release declaration.
  patch.targeting = { ...fixture.targeting, min_app_version: "2.0.0", priority: 100 };
  await json(path, { method: "PATCH", body: patch, headers: { "If-Match": '"2"', "X-Client-Mutation-Id": randomUUID() } });
  assert.equal((await json(`${path}/validate`, { method: "POST", body: {} })).valid, true);
  const publishOptions = { method: "POST", body: { revision: 3, mode: "now", change_note: "Isolated publication" }, headers: { "Idempotency-Key": randomUUID() } };
  const [published, publishRetry] = await Promise.all([json(`${path}/publish`, publishOptions, 201), json(`${path}/publish`, publishOptions, 201)]);
  assert.deepEqual(published, publishRetry);
  const publicPath = "/api/v1/ui-layouts/customer_home";
  const context = { "X-App-Version": "2.0.0", "X-App-Platform": "android" };
  const live = await request(publicPath, { auth: null, headers: context });
  const liveBody = (await live.json()).data;
  assert.deepEqual(liveBody.sections, fixture.content.sections); assert.deepEqual(liveBody.product_ids, ids);
  assert.equal((await request(publicPath, { auth: null, headers: { ...context, "If-None-Match": live.headers.get("etag") } })).status, 304);
  const oldClient = await json(publicPath, { auth: null, headers: { "X-App-Version": "1.0.0" } });
  assert.equal(oldClient.version_id, fallback.version_id); assert.equal(oldClient.product_reference_format, undefined);
  assert.deepEqual((await json(`/api/v1/admin/home-layouts/versions/${published.version_id}`)).content, fixture.content);
  const clone = await json(drafts, { method: "POST", body: { layout_key: "customer_home", name: "Isolated clone", source: { type: "published", version_id: published.version_id } } }, 201);
  assert.deepEqual(clone.content, fixture.content);
  const failing = createUiLayoutService({ auditModel: { init: () => UiLayoutAuditModel.init(), create: async () => { throw new Error("INJECTED_AUDIT_FAILURE"); } } });
  const historyBefore = await service.history();
  await assert.rejects(failing.publish({ id: clone.id, revision: 1, actorId: String(actor), changeNote: "Must abort", idempotencyKey: randomUUID() }), /INJECTED_AUDIT_FAILURE/);
  assert.deepEqual(await service.history(), historyBefore);
  assert.equal((await service.getDraft(clone.id)).status, "draft");
  assert.equal((await service.getPublic({ appVersion: "2.0.0", platform: "android", locale: "en" })).version_id, published.version_id,
    "An aborted publication must leave the compatible active version unchanged");
  await json(`/api/v1/admin/home-layouts/versions/${published.version_id}/rollback`, { method: "POST", body: { change_note: "Isolated rollback" }, headers: { "Idempotency-Key": randomUUID() } }, 201);
  console.log("PASS: real new-profile HTTP save/read/retries, preview, version gate, publish/ETag/history/clone/rollback, transaction-abort safety");

  if (process.env.UI_LAYOUT_TEST_REDIS === "true") {
    stage = "isolated local Redis worker";
    const redisUrl = process.env.UI_LAYOUT_TEST_REDIS_URL || "redis://127.0.0.1:6379";
    const endpoint = new URL(redisUrl);
    assert.equal(endpoint.protocol, "redis:");
    const wslHost = process.env.UI_LAYOUT_TEST_LOCAL_REDIS_HOST;
    assert.ok(["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
      (endpoint.hostname === wslHost && isIP(wslHost) === 4 &&
        /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(wslHost) && endpoint.password),
    "Redis must be localhost or the explicitly confirmed, password-protected local WSL test instance");
    redis = new Redis(redisUrl, { connectTimeout: 3000, maxRetriesPerRequest: 1, retryStrategy: () => null });
    redis.on("error", () => {});
    assert.equal(await redis.ping(), "PONG");
    assert.deepEqual(await redis.keys(`${prefix}:*`), []);
    bullMqConfig.redisUrl = redisUrl; bullMqConfig.prefix = prefix;
    const processor = createUiLayoutJobProcessor();
    const connection = { host: endpoint.hostname, port: Number(endpoint.port || 6379),
      username: endpoint.username || undefined, password: decodeURIComponent(endpoint.password) || undefined };
    worker = new Worker(UI_LAYOUT_QUEUE_NAME, processor.process, { connection, prefix });
    worker.on("error", () => {});
    events = new QueueEvents(UI_LAYOUT_QUEUE_NAME, { connection, prefix });
    events.on("error", () => {});
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
    // Production starts reconciliation too: an early/stale job completion is not publication.
    await startUiLayoutReconciliation();
    const scheduled = await service.schedule({ id: clone.id, revision: 1, actorId: String(actor), changeNote: "Isolated worker",
      scheduledFor: new Date(Date.now() + 125000).toISOString(), idempotencyKey: randomUUID() });
    const waiting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("WORKER_TIMEOUT")), 200000);
      function finish(error) {
        clearTimeout(timer); worker.off("completed", completed); worker.off("failed", failed);
        error ? reject(error) : resolve();
      }
      function matches(job) { return job?.name === UI_LAYOUT_JOB_PUBLISH && job.data.draftId === clone.id; }
      function completed(job, result) {
        if (matches(job) && result?.version_id) finish();
      }
      function failed(job) { if (matches(job)) finish(new Error("WORKER_FAILED")); }
      worker.on("completed", completed); worker.on("failed", failed);
    });
    await enqueueUiLayoutSchedule(scheduled);
    await waiting;
    assert.equal((await service.getDraft(clone.id)).status, "published");
    assert.deepEqual((await service.getPublic({ appVersion: "2.0.0", platform: "android", locale: "en" })).sections, fixture.content.sections);
    console.log("PASS: real delayed new-profile publication through isolated local Redis/BullMQ worker");
  } else console.log("NOT RUN: Redis worker acceptance (set UI_LAYOUT_TEST_REDIS=true)");
}

try { await run(); } catch (error) {
  console.error("ID-only integration failed", { stage, name: error.name, code: error.code ?? null,
    message: error.name === "AssertionError" ? error.message : "Details hidden; no credentials logged" });
  process.exitCode = 1;
} finally {
  async function cleanup(resource, action) {
    try { await action(); }
    catch (error) { console.error("Integration cleanup failed", { resource, databaseName, code: error.code ?? null }); process.exitCode = 1; }
  }
  await cleanup("HTTP server", () => new Promise((resolve) => server ? server.close(resolve) : resolve()));
  await cleanup("worker", () => worker?.close());
  await cleanup("queue events", () => events?.close());
  await cleanup("queue", closeUiLayoutQueue);
  await cleanup("Redis prefix", async () => {
    if (!redis) return;
    try {
      for (const key of await redis.keys(`${prefix}:*`)) await redis.unlink(key);
      assert.deepEqual(await redis.keys(`${prefix}:*`), []);
    } finally { redis.disconnect(); }
  });
  await cleanup("media", async () => {
    if (media) {
      assert.match(media.public_id, /^petyard\/ui-builder\/[0-9a-f-]{36}$/);
      await deleteImage(media);
      const config = getMediaConfiguration();
      if (config.publicProvider === "bunny") {
        const objectKey = getBunnyObjectKeyFromUrl({ url: media.url, cdnBaseUrl: config.public.cdnBaseUrl, allowedRoot: "petyard" });
        assert.ok(objectKey);
        await assert.rejects(downloadBunnyObject({ ...config.public, objectKey, timeoutMs: config.storageTimeoutMs }), (error) => error.statusCode === 404);
      } else await assert.rejects(cloudinary.api.resource(media.public_id), (error) => error.error?.http_code === 404 || error.http_code === 404);
      console.log("Temporary media removed; provider absence confirmed.");
    }
  });
  await cleanup("database", async () => {
    if (ownsDatabase) {
      assert.match(databaseName, /^petyard_ui_it_[0-9a-f]{24}$/);
      assert.equal(mongoose.connection.name, databaseName);
      // The approved account can drop collections but does not have dropDatabase permission.
      // Every collection here belongs to this run: the exact database was verified empty first.
      for (const collection of await mongoose.connection.db.listCollections().toArray()) {
        await mongoose.connection.db.collection(collection.name).drop();
      }
      assert.deepEqual(await mongoose.connection.db.listCollections().toArray(), []);
      console.log("Owned temporary database removed; copied source and live database unchanged.");
    }
  });
  await cleanup("MongoDB connection", () => mongoose.disconnect());
}
