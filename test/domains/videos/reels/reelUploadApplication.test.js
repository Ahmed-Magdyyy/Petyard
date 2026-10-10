import assert from "node:assert/strict";
import test from "node:test";

import { createReelUploadService } from "../../../../src/domains/videos/reels/reelUpload.service.js";
import { ReelUploadSessionModel } from "../../../../src/domains/videos/reels/reelUploadSession.model.js";

const videoId = "507f1f77bcf86cd799439011";
const actor = { id: "507f191e810c19729de860ea", role: "admin" };
const file = { filename: "puppy.mp4", mimeType: "video/mp4", sizeBytes: 1024 };
const uploadUrl = "https://video.bunnycdn.com/tusupload/resource-1";
const nowMs = Date.UTC(2026, 8, 28, 12);

function provider(calls) {
  return {
    async createVideo({ title }) { assert.equal(title, "petyard-reel-session:session-1");
      calls.push("createVideo"); return { guid: "video-guid-1" }; },
    async createTusUpload({ title }) {
      assert.equal(title, "petyard-reel-session:session-1"); calls.push("createTusUpload");
      return { uploadUrl, resourceExpiresAt: Math.floor(nowMs / 1000) + 21600 }; },
    createTusUploadAuthorization({ videoId: guid, expiresAt }) {
      assert.equal(guid, "video-guid-1");
      return { endpoint: "https://video.bunnycdn.com/tusupload", expiresAt,
        headers: { AuthorizationSignature: "test-signature" } };
    },
  };
}

test("a new Reel reservation creates one Bunny video and one trusted TUS resource", async () => {
  const calls = [];
  const app = createReelUploadService({
    now: () => nowMs, provider: provider(calls), repository: {
      async reserve(args) { assert.deepEqual(args.file, file);
        return { id: "session-1", status: "reserving", newlyCreated: true,
          providerTitle: "petyard-reel-session:session-1" }; },
      async attachProviderVideo({ providerGuid }) {
        assert.equal(providerGuid, "video-guid-1"); calls.push("attachProviderVideo"); },
      async issue({ uploadUrl: url }) { assert.equal(url, uploadUrl); calls.push("issue");
        return { providerGuid: "video-guid-1", uploadUrl,
          resourceExpiresAt: Math.floor(nowMs / 1000) + 21600,
          abandonAt: new Date(nowMs + 86400000) }; },
      async failSetup() { throw new Error("unexpected compensation"); },
    },
  });
  const result = await app.createSession({ videoId, actor, idempotencyKey: "reel-key-123", file });
  assert.deepEqual(calls, ["createVideo", "attachProviderVideo", "createTusUpload", "issue"]);
  assert.equal(result.status, "awaiting_upload");
  assert.equal(result.upload.uploadUrl, uploadUrl);
  assert.equal(result.upload.expiresAt, Math.floor(nowMs / 1000) + 21600);
});

test("an issued retry reuses credentials and a reserving retry never creates another Bunny video", async () => {
  const calls = [];
  let status = "issued";
  const app = createReelUploadService({ now: () => nowMs, provider: provider(calls),
    repository: {
      async reserve() { return status === "issued"
        ? { status, providerGuid: "video-guid-1", uploadUrl,
          resourceExpiresAt: Math.floor(nowMs / 1000) + 21600,
          abandonAt: new Date(nowMs + 86400000) }
        : { status, id: "session-1", newlyCreated: false }; },
      async attachProviderVideo() { throw new Error("unused"); },
      async issue() { throw new Error("unused"); },
      async failSetup() { throw new Error("unused"); },
    } });
  const args = { videoId, actor, idempotencyKey: "reel-key-123", file };
  assert.equal((await app.createSession(args)).status, "awaiting_upload");
  status = "reserving";
  assert.deepEqual(await app.createSession(args), { videoId, sessionId: "session-1", status: "reserving" });
  assert.deepEqual(calls, []);
});

test("a provider failure persists compensation before returning a safe error", async () => {
  const calls = [];
  const brokenProvider = provider(calls);
  brokenProvider.createTusUpload = async () => { throw new Error("provider secret body"); };
  const app = createReelUploadService({ now: () => nowMs, provider: brokenProvider,
    repository: {
      async reserve() { return { id: "session-1", status: "reserving", newlyCreated: true,
        providerTitle: "petyard-reel-session:session-1" }; },
      async attachProviderVideo() { calls.push("attach"); },
      async issue() { throw new Error("unused"); },
      async failSetup({ providerGuid }) {
        assert.equal(providerGuid, "video-guid-1"); calls.push("compensate"); },
    } });
  await assert.rejects(app.createSession({ videoId, actor, idempotencyKey: "reel-key-123", file }),
    (error) => error.statusCode === 503 && !error.message.includes("secret"));
  assert.deepEqual(calls, ["createVideo", "attach", "compensate"]);
});

test("a late Bunny create response still reaches compensation after its reservation expired", async () => {
  const calls = [];
  const app = createReelUploadService({ now: () => nowMs, provider: provider(calls),
    repository: {
      async reserve() { return { id: "session-1", status: "reserving", newlyCreated: true,
        providerTitle: "petyard-reel-session:session-1" }; },
      async attachProviderVideo() { throw new Error("stale reservation"); },
      async issue() { throw new Error("unused"); },
      async failSetup({ providerGuid }) { assert.equal(providerGuid, "video-guid-1");
        calls.push("compensate-late-guid"); },
    } });
  await assert.rejects(app.createSession({ videoId, actor, idempotencyKey: "reel-key-123", file }),
    (error) => error.statusCode === 503);
  assert.deepEqual(calls, ["createVideo", "compensate-late-guid"]);
});

test("Reel upload never creates a Bunny video without a persisted search marker", async () => {
  const calls = [];
  const app = createReelUploadService({ now: () => nowMs, provider: provider(calls),
    repository: {
      async reserve() { return { id: "session-1", status: "reserving", newlyCreated: true }; },
      async attachProviderVideo() { throw new Error("unused"); },
      async issue() { throw new Error("unused"); },
      async failSetup({ providerGuid }) { assert.equal(providerGuid, undefined);
        calls.push("compensate-reservation"); },
    } });
  await assert.rejects(app.createSession({ videoId, actor, idempotencyKey: "reel-key-123", file }),
    (error) => error.statusCode === 503);
  assert.deepEqual(calls, ["compensate-reservation"]);
});

test("Reel upload rejects invalid media before any repository or provider call", async () => {
  const app = createReelUploadService({ provider: provider([]), repository: {
    async reserve() { throw new Error("unexpected reservation"); },
    async attachProviderVideo() {}, async issue() {}, async failSetup() {},
  } });
  for (const badFile of [{ ...file, filename: "../puppy.mp4" },
    { ...file, mimeType: "video/avi" }, { ...file, sizeBytes: 250 * 1024 * 1024 + 1 }]) {
    await assert.rejects(app.createSession({ videoId, actor, idempotencyKey: "reel-key-123",
      file: badFile }), (error) => error.statusCode === 400);
  }
});

test("Reel upload session model enforces one idempotency key per Reel", () => {
  const unique = ReelUploadSessionModel.schema.indexes().find(([, options]) => options.unique);
  assert.deepEqual(unique[0], { videoId: 1, idempotencyKey: 1 });
});

const sessionId = "507f1f77bcf86cd799439012";
const assetId = "507f1f77bcf86cd799439013";

test("Reel status is a safe projection and refresh keeps the same bounded TUS resource", async () => {
  const calls = [];
  const context = { video: { _id: videoId, status: "draft" },
    row: { _id: sessionId, status: "issued", abandonAt: new Date(nowMs + 86400000) },
    asset: { _id: assetId, ownerType: "reel", ownerId: videoId,
      providerGuid: "video-guid-1", technicalState: "awaiting_upload", tusUploadUrl: uploadUrl,
      tusResourceExpiresAt: Math.floor(nowMs / 1000) + 1200 }, isCurrent: true };
  const app = createReelUploadService({ now: () => nowMs, provider: provider(calls),
    repository: { reserve() {}, attachProviderVideo() {}, issue() {}, failSetup() {},
      async getSessionContext() { return context; } } });
  const input = { videoId, sessionId, actor };
  const status = await app.getUploadStatus(input);
  assert.deepEqual(status, { videoId, sessionId, status: "awaiting_upload", videoStatus: "draft",
    failureCode: null, canRefresh: true, abandonAt: new Date(nowMs + 86400000).toISOString() });
  assert.ok(!JSON.stringify(status).includes("bunnycdn"));
  const refreshed = await app.refreshUploadAuthorization(input);
  assert.equal(refreshed.upload.uploadUrl, uploadUrl);
  assert.equal(refreshed.upload.expiresAt, context.asset.tusResourceExpiresAt);
  assert.deepEqual(calls, []);
  context.asset.tusResourceExpiresAt = Math.floor(nowMs / 1000);
  assert.equal((await app.getUploadStatus(input)).canRefresh, false);
  await assert.rejects(app.refreshUploadAuthorization(input),
    (error) => error.errors[0].code === "VIDEO_UPLOAD_RESOURCE_EXPIRED");
});

test("Reel refresh refuses processing, deletion, stale generations, and abandonment", async () => {
  const context = { video: { _id: videoId, status: "draft" },
    row: { _id: sessionId, status: "issued", abandonAt: new Date(nowMs + 86400000) },
    asset: { providerGuid: "video-guid-1", technicalState: "awaiting_upload", tusUploadUrl: uploadUrl,
      tusResourceExpiresAt: Math.floor(nowMs / 1000) + 21600 }, isCurrent: true };
  const app = createReelUploadService({ now: () => nowMs, provider: provider([]),
    repository: { reserve() {}, attachProviderVideo() {}, issue() {}, failSetup() {},
      async getSessionContext() { return context; } } });
  for (const change of [() => { context.asset.technicalState = "processing"; },
    () => { context.asset.technicalState = "awaiting_upload"; context.asset.deletionRequestedAt = new Date(); },
    () => { delete context.asset.deletionRequestedAt; context.isCurrent = false; },
    () => { context.isCurrent = true; context.row.abandonAt = new Date(nowMs); }]) {
    change();
    assert.equal((await app.getUploadStatus({ videoId, actor })).canRefresh, false);
    await assert.rejects(app.refreshUploadAuthorization({ videoId, sessionId, actor }),
      (error) => error.statusCode === 409);
  }
});

test("Reel status separates verified readiness, publication, failures, and cancellation", async () => {
  const context = { video: { _id: videoId, status: "draft" },
    row: { _id: sessionId, status: "issued" }, isCurrent: true,
    asset: { _id: assetId, ownerType: "reel", ownerId: videoId, technicalState: "ready",
      providerStatus: 4, readyAt: new Date(nowMs), durationSeconds: 2, width: 640, height: 360,
      availableResolutions: ["360p"] } };
  const app = createReelUploadService({ provider: provider([]), repository: {
    reserve() {}, attachProviderVideo() {}, issue() {}, failSetup() {},
    async getSessionContext() { return context; } } });
  assert.equal((await app.getUploadStatus({ videoId, actor })).status, "ready");
  delete context.asset.readyAt;
  assert.equal((await app.getUploadStatus({ videoId, actor })).status, "processing");
  context.row.status = "failed";
  context.row.failureCode = "VIDEO_UPLOAD_CANCELLED";
  context.isCurrent = false;
  assert.equal((await app.getUploadStatus({ videoId, actor })).status, "cancelled");
  context.row.failureCode = "VIDEO_UPLOAD_ABANDONED";
  assert.equal((await app.getUploadStatus({ videoId, actor })).status, "failed");
  context.row = null;
  context.asset = null;
  assert.equal((await app.getUploadStatus({ videoId, actor })).status, "none");
});

test("Reel upload management rejects invalid identities/roles before persistence", async () => {
  let cancelled = false;
  const app = createReelUploadService({ provider: provider([]), repository: {
    reserve() {}, attachProviderVideo() {}, issue() {}, failSetup() {},
    getSessionContext() { throw new Error("unexpected read"); },
    async cancelUpload(input) { assert.equal(input.sessionId, sessionId); cancelled = true; } } });
  for (const method of ["getUploadStatus", "refreshUploadAuthorization", "cancelUpload"]) {
    await assert.rejects(app[method]({ videoId, sessionId, actor: { ...actor, role: "user" } }),
      (error) => error.statusCode === 403);
    await assert.rejects(app[method]({ videoId, sessionId: "bad-id", actor }),
      (error) => error.statusCode === 400);
  }
  for (const method of ["refreshUploadAuthorization", "cancelUpload"]) {
    await assert.rejects(app[method]({ videoId, actor }), (error) => error.statusCode === 400);
  }
  assert.deepEqual(await app.cancelUpload({ videoId, sessionId, actor }),
    { videoId, sessionId, status: "cancelled" });
  assert.equal(cancelled, true);
});

test("replacement authorization reuses the initial upload machinery without requiring a draft Video", async () => {
  const context = { video: { _id: videoId, status: "published" }, row: { _id: sessionId,
    status: "issued", purpose: "replacement", abandonAt: new Date(nowMs + 86400000) },
    isCurrent: true, asset: { providerGuid: "video-guid-1", technicalState: "awaiting_upload",
      tusUploadUrl: uploadUrl, tusResourceExpiresAt: Math.floor(nowMs / 1000) + 21600 } };
  const app = createReelUploadService({ now: () => nowMs, provider: provider([]), repository: {
    attachProviderVideo() {}, issue() {}, failSetup() {},
    async reserve(input) { assert.equal(input.purpose, "replacement");
      return { id: sessionId, status: "issued", providerGuid: "video-guid-1", uploadUrl,
        resourceExpiresAt: context.asset.tusResourceExpiresAt, abandonAt: context.row.abandonAt }; },
    async getSessionContext(input) { assert.equal(input.purpose, "replacement"); return context; },
  } });
  const input = { videoId, actor, purpose: "replacement" };
  assert.equal((await app.createSession({ ...input, idempotencyKey: "replacement-key", file })).sessionId, sessionId);
  assert.equal((await app.getUploadStatus(input)).canRefresh, true);
  assert.equal((await app.refreshUploadAuthorization({ ...input, sessionId })).upload.uploadUrl, uploadUrl);
  await assert.rejects(app.createSession({ ...input, purpose: "injected", idempotencyKey: "replacement-key", file }),
    (error) => error.statusCode === 400);
  context.row.appliedAt = new Date(nowMs);
  context.isCurrent = false;
  const applied = await app.getUploadStatus(input);
  assert.equal(applied.status, "applied"); assert.equal(applied.canRefresh, false);
});
