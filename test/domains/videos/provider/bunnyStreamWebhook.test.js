import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import express from "express";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { createBunnyStreamWebhookService } from "../../../../src/domains/videos/provider/bunnyStreamWebhook.service.js";
import { createBunnyStreamWebhookRepository } from "../../../../src/domains/videos/provider/bunnyStreamWebhook.repository.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  listDueVideoProviderOperationIds }
  from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createBunnyStreamWebhookRouter } from "../../../../src/domains/videos/provider/bunnyStreamWebhook.routes.js";
import { bunnyStreamWebhookBody, BUNNY_STREAM_WEBHOOK_PATH } from "../../../../src/domains/videos/provider/bunnyStreamWebhook.middleware.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const libraryId = "754739";
const guid = "ed494595-81ed-4e64-aba5-31f2fa69c97e";
const secret = "fake-read-only-key";
const payload = { VideoLibraryId: 754739, VideoGuid: guid, Status: 4 };
function signed(body = JSON.stringify(payload), changes = {}) {
  const rawBody = Buffer.from(body);
  return { rawBody, headers: {
    "x-bunnystream-signature-version": "v1",
    "x-bunnystream-signature-algorithm": "hmac-sha256",
    "x-bunnystream-signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    ...changes,
  } };
}
function fixture({ seed = {}, assets, operations, enqueue } = {}) {
  const db = replacementDatabase({ assets: [{ _id: "507f1f77bcf86cd799439011",
    libraryId, providerGuid: guid, ownerType: "reel", ownerId: "507f1f77bcf86cd799439012",
    technicalState: "awaiting_upload" }], ...seed });
  const queued = [];
  const repository = createBunnyStreamWebhookRepository({ assets: assets ?? db.assets,
    recordOperation: input => recordVideoProviderOperation({ ...input, model: operations ?? db.operations }) });
  const service = createBunnyStreamWebhookService({ libraryId, signingKey: secret, repository,
    enqueue: enqueue ?? (async id => { queued.push(id); }) });
  return { service, repository, queued, db };
}

async function withHttp(service, work) {
  const app = express();
  app.use(BUNNY_STREAM_WEBHOOK_PATH, bunnyStreamWebhookBody);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(mongoSanitize());
  app.use(hpp());
  app.use("/api/v1/integrations/bunny-stream", createBunnyStreamWebhookRouter({ getService: () => service }));
  app.post("/echo", (req, res) => res.json(req.body));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("a signed Bunny hint durably schedules reconciliation rather than publishing from callback status", async () => {
  const { service, queued } = fixture();
  const result = await service.receive(signed());
  assert.equal(result.status, "recorded");
  assert.match(result.operationId, /^[a-f\d]{24}$/);
  assert.equal(result.queued, true);
  assert.deepEqual(queued, [result.operationId]);
});

test("invalid signatures fail before parsing or any database access", async () => {
  const { service } = fixture({ assets: { findOne() { throw new Error("Database must not be accessed"); } } });
  const good = signed();
  for (const change of [
    { "x-bunnystream-signature-version": undefined }, { "x-bunnystream-signature-version": "v2" },
    { "x-bunnystream-signature-algorithm": "sha256" }, { "x-bunnystream-signature": undefined },
    { "x-bunnystream-signature": "a".repeat(63) }, { "x-bunnystream-signature": "A".repeat(64) },
    { "x-bunnystream-signature": "g".repeat(64) },
    { "x-bunnystream-signature": createHmac("sha256", "fake-write-key").update(good.rawBody).digest("hex") },
  ]) {
    await assert.rejects(service.receive({ ...good, headers: { ...good.headers, ...change } }),
      error => error.statusCode === 401 && !error.message.includes(secret));
  }
  await assert.rejects(service.receive({ ...good, rawBody: Buffer.from("{invalid JSON") }),
    error => error.statusCode === 401);
});

test("authenticated malformed and wrong-library hints fail without accessing MongoDB", async () => {
  const { service } = fixture({ assets: { findOne() { throw new Error("Database must not be accessed"); } } });
  for (const body of ["{", "null", "[]", "1", ...[
    { ...payload, VideoLibraryId: "754739" }, { ...payload, VideoLibraryId: 999 },
    { ...payload, VideoLibraryId: 0 }, { ...payload, VideoLibraryId: Number.MAX_SAFE_INTEGER + 1 },
    { ...payload, VideoGuid: "untrusted/path" }, { ...payload, VideoGuid: null },
    { ...payload, Status: "4" }, { ...payload, Status: -1 }, { ...payload, Status: 11 },
    { ...payload, Status: 1.5 }, { VideoLibraryId: 754739, VideoGuid: guid },
  ].map(value => JSON.stringify(value))]) {
    await assert.rejects(service.receive(signed(body)), error => error.statusCode === 422);
  }
  await assert.rejects(service.receive(signed(" ".repeat(16385))), error => error.statusCode === 413);
  await assert.rejects(service.receive({ ...signed(), rawBody: {} }), error => error.statusCode === 422);
});

test("unknown, foreign and deleting assets are ignored without creating work", async () => {
  for (const seed of [{ assets: [] }, { assets: [{ _id: "507f1f77bcf86cd799439011", libraryId: "999",
    providerGuid: guid, ownerType: "reel", technicalState: "processing" }] },
    ...["deleting", "deleted"].map(technicalState => ({ assets: [{ _id: "507f1f77bcf86cd799439011",
      libraryId, providerGuid: guid, ownerType: "reel", technicalState }] })),
    { assets: [{ _id: "507f1f77bcf86cd799439011", libraryId, providerGuid: guid,
      ownerType: "reel", technicalState: "processing", deletionRequestedAt: new Date() }] }]) {
    const { service, queued } = fixture({ seed,
      operations: { findOneAndUpdate() { throw new Error("No work may be created"); } } });
    assert.deepEqual(await service.receive(signed()), { status: "ignored" });
    assert.deepEqual(queued, []);
  }
});

test("exact retries deduplicate across service instances and queue outages retain durable work", async () => {
  const first = fixture({ enqueue: async () => { throw new Error("Redis unavailable"); } });
  const recorded = await first.service.receive(signed());
  assert.equal(recorded.queued, false);
  // Existing Provider Operation service exposes due work without a database
  // side-channel assertion; this is the same interface used by the sweeper.
  assert.deepEqual(await listDueVideoProviderOperationIds({ now: new Date(Date.now() + 1000),
    model: first.db.operations }), [recorded.operationId]);
  const restarted = fixture({ assets: first.db.assets, operations: first.db.operations });
  const retried = await restarted.service.receive(signed());
  assert.equal(retried.operationId, recorded.operationId);
  assert.equal(retried.queued, true);
  assert.deepEqual(restarted.queued, [recorded.operationId]);
  const when = new Date(Date.now() + 1000);
  const claimed = await claimVideoProviderOperationById({ operationId: recorded.operationId,
    now: when, model: first.db.operations });
  await completeVideoProviderOperation({ operationId: recorded.operationId, leaseToken: claimed.leaseToken,
    now: when, model: first.db.operations });
  assert.deepEqual(await restarted.service.receive(signed()), {
    status: "recorded", operationId: recorded.operationId, queued: false });
  assert.deepEqual(restarted.queued, [recorded.operationId]);
});

test("a persistence failure cannot acknowledge or enqueue a notification", async () => {
  const { service, queued } = fixture({ operations: { findOneAndUpdate() {
    throw new Error(`Mongo unavailable; ${secret}`);
  } } });
  await assert.rejects(service.receive(signed()), error => error.statusCode === 503 &&
    error.errors[0].code === "VIDEO_WEBHOOK_UNAVAILABLE" && !error.message.includes(secret));
  assert.deepEqual(queued, []);
});

test("Product Video hints and all documented callback statuses use reconciliation only", async () => {
  const { service } = fixture({ seed: { assets: [{ _id: "507f1f77bcf86cd799439011",
    libraryId, providerGuid: guid, ownerType: "product_video", technicalState: "processing" }] } });
  const ids = new Set();
  for (let Status = 0; Status <= 10; Status++) {
    const result = await service.receive(signed(JSON.stringify({ ...payload, Status })));
    assert.equal(result.status, "recorded");
    ids.add(result.operationId);
  }
  assert.equal(ids.size, 11);
});

test("the webhook HTTP path preserves exact bytes across normal parsers and security middleware", async () => {
  const { service } = fixture();
  await withHttp(service, async base => {
    const hint = signed(`{\n "Status": 4, "VideoGuid": "${guid}", "VideoLibraryId": 754739\n}`);
    const request = rawBody => fetch(`${base}${BUNNY_STREAM_WEBHOOK_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", ...hint.headers }, body: rawBody });
    const accepted = await request(hint.rawBody);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await accepted.json(), { received: true });
    assert.equal((await request(Buffer.concat([hint.rawBody, Buffer.from(" ")]))).status, 401);
    const ordinary = await fetch(`${base}/echo`, { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"ordinary":true}' });
    assert.deepEqual(await ordinary.json(), { ordinary: true });
  });
});

test("the HTTP boundary rejects unsupported, compressed, oversized and invalid signed bodies", async () => {
  const { service } = fixture();
  await withHttp(service, async base => {
    for (const [hint, headers, expected] of [
      [signed(), { "content-type": "text/plain" }, 415],
      [signed(), { "content-encoding": "gzip" }, 415],
      [signed(" ".repeat(16385)), {}, 413], [signed("{"), {}, 422],
      [signed(""), {}, 422], [signed(), { "x-bunnystream-signature-version": "v1, v1" }, 401],
    ]) {
      const response = await fetch(`${base}${BUNNY_STREAM_WEBHOOK_PATH}`, { method: "POST",
        headers: { "content-type": "application/json", ...hint.headers, ...headers }, body: hint.rawBody });
      assert.equal(response.status, expected);
      assert.equal((await response.text()).includes(secret), false);
    }
  });
});

test("HTTP acknowledges unknown targets and queue loss, but not a persistence failure", async () => {
  for (const [instance, expected] of [
    [fixture({ seed: { assets: [] } }), 202],
    [fixture({ enqueue: async () => { throw new Error("Redis unavailable"); } }), 202],
    [fixture({ operations: { findOneAndUpdate() { throw new Error(secret); } } }), 503],
  ]) {
    await withHttp(instance.service, async base => {
      const hint = signed();
      const response = await fetch(`${base}${BUNNY_STREAM_WEBHOOK_PATH}`, { method: "POST",
        headers: { "content-type": "application/json", ...hint.headers }, body: hint.rawBody });
      assert.equal(response.status, expected);
      const result = await response.json();
      if (expected === 202) assert.deepEqual(result, { received: true });
      else assert.equal(JSON.stringify(result).includes(secret), false);
    });
  }
});
