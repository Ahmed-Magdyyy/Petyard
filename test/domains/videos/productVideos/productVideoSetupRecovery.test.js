import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const actorId = "507f1f77bcf86cd799439012";
const assetId = "507f1f77bcf86cd799439013";
const batchId = "507f1f77bcf86cd799439014";
const start = Date.parse("2026-09-27T00:00:00Z");

function setup({ ready = false, issued = false, knownAsset = true } = {}) {
  let time = start + 3_600_000;
  let rejectCleanup = false;
  const deleted = [];
  const db = replacementDatabase({
    products: [{ _id: productId }],
    batches: [{ _id: batchId, productId, actorId, status: ready || issued ? "issued" : "reserving",
      updatedAt: new Date(start), idempotencyKey: "batch-request-001" }],
    placements: [{ _id: videoId, productId, position: 2, activeSlot: true,
      lifecycleState: ready ? "ready" : issued ? "awaiting_upload" : "reserving",
      ...(knownAsset ? { activeAssetId: assetId } : {}), uploadBatchId: batchId,
      safeFilename: "demo.mp4", showInReelsFeed: true }],
    assets: knownAsset ? [{ _id: assetId, ownerType: "product_video", ownerId: videoId,
      libraryId: "754739", providerGuid: "original-guid", technicalState: ready ? "ready" : "awaiting_upload" }] : [],
  }, { now: () => time });
  const provider = {
    async createVideo() { return { guid: "new-guid" }; },
    async createTusUpload({ videoId, expiresAt }) {
      return { uploadUrl: `https://video.bunnycdn.com/tusupload/${videoId}`, resourceExpiresAt: expiresAt };
    },
    async deleteVideo(guid) { deleted.push(guid); return { accepted: true }; },
    async terminateTusUpload() { return { state: "terminated" }; },
    async getVideo(guid) {
      if (deleted.includes(guid)) throw { status: 404 };
      return { guid, status: 0 };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {}, provider, now: () => time,
    repository: createProductVideoRepository({ ...db, libraryId: "754739", now: () => time,
      invalidateCaches: async () => {}, enqueue: async () => {},
      async recordOperation({ session, ...spec }) {
        if (rejectCleanup) throw new Error("database unavailable");
        const existing = await db.operations.findOne({ dedupeKey: spec.dedupeKey });
        return existing || (await db.operations.create([spec]))[0];
      },
    }),
  });
  const observer = createVideoAssetObserver({ model: db.assets, now: () => time,
    onApplied: (asset) => application.handleVerifiedAsset(asset),
    onDeleted: (asset) => application.handleDeletedAsset(asset) });
  const runtime = createVideoProviderRuntime({ provider, assets: observer, operations: {
    async claimById({ operationId }) { return db.operations.findById(operationId); },
    async complete({ operationId }) { await db.operations.updateOne({ _id: operationId }, { $set: { done: true } }); return true; },
    async fail() { throw new Error("unexpected cleanup failure"); },
  } });
  return { application, provider, at(value) { time = value; },
    async observe(guid, status) {
      const asset = await db.assets.findOne({ providerGuid: guid });
      return observer.applySnapshot({ operation: { assetId: asset._id, libraryId: "754739", providerGuid: guid },
        snapshot: { guid, status, length: 0, storageSize: 0 } });
    },
    failCleanup(value) { rejectCleanup = value; },
    async drainCleanup() {
      const rows = await db.operations.find({ done: { $exists: false } });
      for (const row of rows) await runtime.process(row._id);
      return [...deleted];
    },
  };
}

test("a stale unissued batch releases its reservation and durably cleans its known resource", async () => {
  const { application, drainCleanup } = setup();
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 1, failed: 0 });
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 0, recovered: 0, failed: 0 });
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("stalled replacement TUS creation is recovered from its persisted GUID without touching ready media", async () => {
  const { application, provider, at, drainCleanup, observe } = setup({ ready: true });
  let release;
  let started;
  const reachedTus = new Promise((resolve) => { started = resolve; });
  provider.createTusUpload = ({ expiresAt }) => { started(); return new Promise((resolve) => {
    release = () => resolve({ uploadUrl: "https://video.bunnycdn.com/tusupload/late", resourceExpiresAt: expiresAt });
  }); };
  const upload = application.createReplacementUploadSession({ productId, videoId, actorId,
    idempotencyKey: "stalled-tus-001", file: { clientId: "selected", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } });
  await reachedTus;
  try {
    await observe("new-guid", 0);
    at(start + 2 * 3_600_000);
    assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 1, failed: 0 });
    const [status] = await application.listAdminStatus({ productId });
    assert.equal(status.status, "ready");
    assert.equal(status.replacement, undefined);
    assert.deepEqual(await drainCleanup(), ["new-guid"]);
  } finally { release(); await upload.catch(() => {}); }
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement, undefined);
});

test("a stalled replacement reservation expires without touching its old ready video", async () => {
  const { application, provider, at, drainCleanup } = setup({ ready: true });
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  provider.createVideo = () => { started(); return new Promise((resolve) => { release = resolve; }); };
  const upload = application.createReplacementUploadSession({ productId, videoId, actorId,
    idempotencyKey: "stalled-replacement", file: { clientId: "new", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 10 } });
  await waiting;
  let successor;
  try {
    at(start + 7_200_000);
    assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 1, failed: 0 });
    const [status] = await application.listAdminStatus({ productId });
    assert.equal(status.status, "ready");
    assert.equal(status.replacement, undefined);
    assert.equal(status.failureCode, "VIDEO_UPLOAD_SETUP_EXPIRED");
    assert.deepEqual(await drainCleanup(), []);
    provider.createVideo = async () => ({ guid: "successor-guid" });
    successor = await application.createReplacementUploadSession({ productId, videoId, actorId,
      idempotencyKey: "successor-replacement", file: { clientId: "new", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 10 } });
  } finally {
    release({ guid: "late-guid" });
    await upload.catch(() => {});
  }
  assert.deepEqual(await drainCleanup(), ["late-guid"]);
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.id, successor.replacementId);
  const grant = await application.refreshReplacementAuthorization({ productId, videoId, replacementId: successor.replacementId });
  assert.equal(grant.upload.headers.VideoId, "successor-guid");
});

test("a setup reservation younger than one hour is not recovered", async () => {
  const { application, at, drainCleanup } = setup();
  at(start + 3_599_999);
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 0, recovered: 0, failed: 0 });
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "reserving");
  assert.deepEqual(await drainCleanup(), []);
});

test("an already issued upload is not reclaimed as stale setup even after a long delay", async () => {
  const { application, at, drainCleanup } = setup({ issued: true });
  at(start + 172_800_000);
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 0, recovered: 0, failed: 0 });
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
  assert.deepEqual(await drainCleanup(), []);
});

test("recovery of setup without a persisted GUID frees the slot but invents no provider deletion", async () => {
  const { application, drainCleanup } = setup({ knownAsset: false });
  assert.equal((await application.recoverUploadSetups()).recovered, 1);
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), []);
});

test("cleanup persistence failure keeps setup reserved and the next sweep retries it", async () => {
  const { application, failCleanup, drainCleanup } = setup();
  failCleanup(true);
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 0, failed: 1 });
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "reserving");
  assert.deepEqual(await drainCleanup(), []);
  failCleanup(false);
  assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 1, failed: 0 });
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("an issued replacement is never reclaimed by the setup sweep", async () => {
  const { application, at, drainCleanup } = setup({ ready: true });
  const created = await application.createReplacementUploadSession({ productId, videoId, actorId,
    idempotencyKey: "issued-replacement", file: { clientId: "new", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 10 } });
  at(start + 172_800_000);
  assert.equal((await application.recoverUploadSetups()).examined, 0);
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.id, created.replacementId);
  assert.deepEqual(await drainCleanup(), []);
});

test("invalid recovery batch sizes fail before changing reservations", async () => {
  const { application } = setup();
  for (const limit of [0, -1, 101, 1.5, "1"]) {
    await assert.rejects(application.recoverUploadSetups({ limit }), RangeError);
  }
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "reserving");
});
