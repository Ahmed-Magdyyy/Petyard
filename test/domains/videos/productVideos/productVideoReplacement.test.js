import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { deleteProductWithVideoCleanup } from "../../../../src/domains/videos/productVideos/productVideoProductDeletion.service.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const actorId = "507f1f77bcf86cd799439012";
const oldAssetId = "507f1f77bcf86cd799439013";
const request = { productId, videoId, actorId, idempotencyKey: "replacement-001",
  file: { clientId: "selected-file", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } };

function setup() {
  const db = replacementDatabase({
    products: [{ _id: productId }],
    placements: [{ _id: videoId, productId, position: 2, activeAssetId: oldAssetId,
      activeSlot: true, lifecycleState: "ready", showInReelsFeed: true }],
    assets: [{ _id: oldAssetId, ownerType: "product_video", ownerId: videoId,
      libraryId: "754739", providerGuid: "old-guid", technicalState: "ready" }],
  });
  const cleanup = [];
  const deleted = [];
  const reservations = [];
  const uploadTitles = [];
  let counter = 0;
  let rejectNextCleanup = false;
  let time = Date.parse("2026-09-27T00:00:00Z");
  const provider = {
    async createVideo(input) { reservations.push(input); return { guid: `new-guid-${++counter}` }; },
    async createTusUpload({ videoId, expiresAt, title }) {
      uploadTitles.push(title);
      return { uploadUrl: `https://video.bunnycdn.com/tusupload/${videoId}`, resourceExpiresAt: expiresAt };
    },
    createTusUploadAuthorization({ videoId: guid, expiresAt }) {
      return { endpoint: "tus", expiresAt, headers: { VideoId: guid } };
    },
    async deleteVideo(guid) { deleted.push(guid); return { accepted: true }; },
    async terminateTusUpload() { return { state: "terminated" }; },
    async getVideo(guid) {
      if (deleted.includes(guid)) throw { status: 404 };
      return { guid, status: 0 };
    },
  };
  const recordOperation = async (spec) => {
    if (rejectNextCleanup) { rejectNextCleanup = false; throw new Error("cleanup write failed"); }
    cleanup.push(spec); return { _id: `op-${cleanup.length}` };
  };
  const repository = createProductVideoRepository({ libraryId: "754739", ...db,
    now: () => time, invalidateCaches: async () => {},
    recordOperation,
    async enqueue() {},
  });
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {}, repository, provider, now: () => time });
  const observer = createVideoAssetObserver({ model: db.assets, now: () => time,
    onApplied: (asset) => application.handleVerifiedAsset(asset),
    onDeleted: (asset) => application.handleDeletedAsset(asset) });
  const runtime = createVideoProviderRuntime({ provider, assets: observer,
    operations: {
      async claimById({ operationId }) { return { ...cleanup[Number(operationId)], leaseToken: "lease" }; },
      async complete() { return {}; },
      async fail() { throw new Error("cleanup should succeed"); },
    } });
  return { db, provider, reservations, uploadTitles, advance(ms) { time += ms; }, application,
    failNextCleanup() { rejectNextCleanup = true; },
    async deleteProduct() { await deleteProductWithVideoCleanup({ productId, ...db,
      recordOperation, enqueue: async () => {}, isUploadEnabled: () => true, now: () => time }); },
    async verify(guid, status = 4) {
      const asset = await db.assets.findOne({ providerGuid: guid });
      return observer.applySnapshot({ operation: { assetId: asset._id,
        libraryId: "754739", providerGuid: guid }, snapshot: {
        guid, status, length: 20, width: 1920, height: 1080, availableResolutions: "720p",
      } });
    },
    async drainCleanup() {
      for (let i = deleted.length; i < cleanup.length; i++) await runtime.process(String(i));
      return [...deleted];
    },
  };
}

test("replacement provider markers identify the replacement generation rather than the reused placement", async () => {
  const { application, reservations, uploadTitles } = setup();
  const first = await application.createReplacementUploadSession(request);
  await application.createReplacementUploadSession(request);
  await application.cancelReplacementUpload({ productId, videoId, replacementId: first.replacementId });
  const next = await application.createReplacementUploadSession({ ...request, idempotencyKey: "replacement-002" });
  const firstMarker = `petyard-product-replacement:${first.replacementId}`;
  const nextMarker = `petyard-product-replacement:${next.replacementId}`;
  assert.notEqual(firstMarker, nextMarker);
  assert.deepEqual(reservations, [{ title: firstMarker }, { title: nextMarker }]);
  assert.deepEqual(uploadTitles, [firstMarker, nextMarker]);
  assert.equal(JSON.stringify([first, next, await application.listAdminStatus({ productId })])
    .includes("petyard-product-"), false);
});

test("replacement upload reserves the existing slot and leaves its ready video attached", async () => {
  const { application } = setup();
  const result = await application.createReplacementUploadSession(request);
  assert.equal(result.productVideoId, videoId);
  assert.equal(result.position, 2);
  assert.equal(result.status, "awaiting_upload");
  assert.equal(result.upload.headers.VideoId, "new-guid-1");
  assert.equal(result.upload.uploadUrl, "https://video.bunnycdn.com/tusupload/new-guid-1");
  const [status] = await application.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement.status, "awaiting_upload");
  assert.equal(status.replacement.id, result.replacementId);
  assert.equal(JSON.stringify(status).includes("new-guid"), false);
});

test("uncertain replacement TUS creation cleans the saved new GUID and keeps the old video ready", async () => {
  const { application, provider, drainCleanup } = setup();
  provider.createTusUpload = async () => { throw new Error("uncertain TUS creation"); };
  await assert.rejects(application.createReplacementUploadSession(request), (error) => error.statusCode === 503);
  const [status] = await application.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement, undefined);
  assert.deepEqual(await drainCleanup(), ["new-guid-1"]);
});

test("empty provider observations preserve refreshability and late empty observations never regress processing", async () => {
  const { application, verify } = setup();
  const first = await application.createReplacementUploadSession(request);
  const target = { productId, videoId, replacementId: first.replacementId };
  await verify("new-guid-1", 0);
  assert.equal((await application.refreshReplacementAuthorization(target)).upload.uploadUrl, first.upload.uploadUrl);
  await verify("new-guid-1", 2);
  await verify("new-guid-1", 0);
  await assert.rejects(application.refreshReplacementAuthorization(target), (error) => error.statusCode === 409);
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.status, "processing");
});

test("whole-product deletion during TUS creation prevents late issuance", async () => {
  const { application, provider, deleteProduct, drainCleanup } = setup();
  let release;
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  provider.createTusUpload = ({ expiresAt }) => {
    reached(); return new Promise((resolve) => { release = () => resolve({
      uploadUrl: "https://video.bunnycdn.com/tusupload/late", resourceExpiresAt: expiresAt,
    }); });
  };
  const pending = application.createReplacementUploadSession(request);
  await waiting;
  try { await deleteProduct(); } finally { release(); }
  await assert.rejects(pending, (error) => error.statusCode === 503);
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  const deleted = await drainCleanup();
  assert.equal(deleted.includes("old-guid"), true);
  assert.equal(deleted.includes("new-guid-1"), true);
});

test("an identical replacement retry refreshes the existing grant without allocating another asset", async () => {
  const { application, advance } = setup();
  const first = await application.createReplacementUploadSession(request);
  advance(60_000);
  const retry = await application.createReplacementUploadSession(request);
  assert.equal(retry.replacementId, first.replacementId);
  assert.equal(retry.upload.headers.VideoId, "new-guid-1");
  assert.equal(retry.upload.expiresAt, first.upload.expiresAt);
  assert.equal(retry.upload.uploadUrl, first.upload.uploadUrl);
  await assert.rejects(application.createReplacementUploadSession({ ...request,
    file: { ...request.file, filename: "different.mp4" } }), (error) => error.statusCode === 409);
  await assert.rejects(application.createReplacementUploadSession({ ...request,
    idempotencyKey: "replacement-002" }), (error) => error.statusCode === 409);
});

test("replacement cutover waits for verified readiness then cleans only the old asset", async () => {
  const { application, verify, drainCleanup } = setup();
  await application.createReplacementUploadSession(request);
  await verify("new-guid-1", 2);
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.status, "processing");
  assert.deepEqual(await drainCleanup(), []);
  await verify("new-guid-1");
  assert.deepEqual(await application.listAdminStatus({ productId }), [{
    productVideoId: videoId, position: 2, status: "ready", showInReelsFeed: true, failureCode: null,
  }]);
  assert.deepEqual(await drainCleanup(), ["old-guid"]);
  await verify("new-guid-1");
  assert.deepEqual(await drainCleanup(), ["old-guid"]);
  const replay = await application.createReplacementUploadSession(request);
  assert.equal(replay.status, "completed");
  assert.equal(replay.upload, undefined);
});

test("a failed replacement preserves the old ready video and cleans only the failed upload", async () => {
  const { application, verify, drainCleanup } = setup();
  await application.createReplacementUploadSession(request);
  await verify("new-guid-1", 5);
  const [status] = await application.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement, undefined);
  assert.equal(status.failureCode, "BUNNY_TRANSCODE_FAILED");
  assert.deepEqual(await drainCleanup(), ["new-guid-1"]);
  assert.equal((await application.createReplacementUploadSession(request)).status, "failed");
  const next = await application.createReplacementUploadSession({ ...request, idempotencyKey: "replacement-002" });
  assert.equal(next.upload.headers.VideoId, "new-guid-2");
});

test("replacement reservation blocks deletion and visibility edits before Bunny returns a GUID", async () => {
  const { application, provider } = setup();
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  provider.createVideo = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const upload = application.createReplacementUploadSession(request);
  await waiting;
  try {
    await assert.rejects(application.requestDeletion({ productId, videoId }), (error) => error.statusCode === 409);
    await assert.rejects(application.setReelsVisibility({ productId, videoId, showInReelsFeed: false }),
      (error) => error.statusCode === 409);
  } finally {
    release({ guid: "new-guid-1" });
    await upload.catch(() => {});
  }
});

test("failed replacement session setup compensates a created Bunny resource without removing the old video", async () => {
  const { application, db, drainCleanup } = setup();
  const create = db.assets.create;
  let fail = true;
  db.assets.create = async (...args) => {
    if (fail) { fail = false; throw new Error("database temporarily unavailable"); }
    return create(...args);
  };
  await assert.rejects(application.createReplacementUploadSession(request),
    (error) => error.statusCode === 503 && error.errors[0].code === "VIDEO_PROVIDER_UNAVAILABLE");
  const [status] = await application.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement, undefined);
  assert.deepEqual(await drainCleanup(), ["new-guid-1"]);
  assert.equal((await application.createReplacementUploadSession(request)).status, "failed");
});

test("cancelling a replacement leaves the old video ready and stale cancellation cannot cancel its successor", async () => {
  const { application, verify, drainCleanup } = setup();
  const first = await application.createReplacementUploadSession(request);
  const target = { productId, videoId, replacementId: first.replacementId };
  assert.deepEqual(await application.cancelReplacementUpload(target), {
    productVideoId: videoId, replacementId: first.replacementId, status: "cancelled",
  });
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "ready");
  const next = await application.createReplacementUploadSession({ ...request, idempotencyKey: "replacement-002" });
  await application.cancelReplacementUpload(target);
  await verify("new-guid-1");
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.id, next.replacementId);
  assert.deepEqual(await drainCleanup(), ["new-guid-1"]);
});

test("replacement authorization refresh targets the same live generation and never extends the deadline", async () => {
  const { application, advance } = setup();
  const first = await application.createReplacementUploadSession(request);
  advance(5 * 60 * 60 * 1000);
  const target = { productId, videoId, replacementId: first.replacementId };
  const refreshed = await application.refreshReplacementAuthorization(target);
  assert.equal(refreshed.upload.headers.VideoId, "new-guid-1");
  assert.equal(refreshed.upload.expiresAt, Date.parse("2026-09-27T06:00:00Z") / 1000);
  advance(60 * 60 * 1000);
  await assert.rejects(application.refreshReplacementAuthorization(target), (error) =>
    error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_UPLOAD_RESOURCE_EXPIRED");
});

test("whole-product deletion tombstones both active and pending media and late readiness cannot revive either", async () => {
  const { application, deleteProduct, verify, drainCleanup } = setup();
  await application.createReplacementUploadSession(request);
  await deleteProduct();
  await verify("new-guid-1");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["old-guid", "new-guid-1"]);
});

test("product deletion during provider creation compensates the late resource without attaching it", async () => {
  const { application, provider, deleteProduct, drainCleanup } = setup();
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  provider.createVideo = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const upload = application.createReplacementUploadSession(request);
  await waiting;
  await deleteProduct();
  release({ guid: "new-guid-1" });
  await assert.rejects(upload, (error) => error.statusCode === 503);
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["old-guid", "new-guid-1"]);
});

test("replacement cutover rolls back when cleanup cannot be persisted and reconciliation can safely retry", async () => {
  const { application, verify, drainCleanup, failNextCleanup } = setup();
  const first = await application.createReplacementUploadSession(request);
  failNextCleanup();
  await assert.rejects(verify("new-guid-1"), /cleanup write failed/);
  const [pending] = await application.listAdminStatus({ productId });
  assert.equal(pending.status, "ready");
  assert.equal(pending.replacement.id, first.replacementId);
  assert.deepEqual(await drainCleanup(), []);
  await verify("new-guid-1");
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement, undefined);
  assert.deepEqual(await drainCleanup(), ["old-guid"]);
});
