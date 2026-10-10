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
const deadline = Date.parse("2026-09-28T00:00:00Z");

function setup({ ready = false, beforeMissingCommit, beforeVerifiedCommit, assetChanges = {} } = {}) {
  let time = deadline;
  let rejectCleanup = false;
  const deleted = [];
  const db = replacementDatabase({
    products: [{ _id: productId }],
    batches: [{ _id: batchId, actorId, status: "issued" }],
    placements: [{ _id: videoId, productId, position: 2, activeSlot: true,
      lifecycleState: ready ? "ready" : "awaiting_upload", activeAssetId: assetId,
      uploadBatchId: batchId, abandonAt: new Date(deadline),
      safeFilename: "demo.mp4", showInReelsFeed: true }],
    assets: [{ _id: assetId, ownerType: "product_video", ownerId: videoId,
      libraryId: "754739", providerGuid: "original-guid", technicalState: ready ? "ready" : "awaiting_upload",
      ...assetChanges }],
  });
  const provider = {
    async getVideo() { throw { status: 404 }; },
    async deleteVideo(guid) { deleted.push(guid); return { accepted: true }; },
    async terminateTusUpload() { return { state: "terminated" }; },
    async createVideo() { return { guid: "replacement-guid" }; },
    async createTusUpload({ videoId, expiresAt }) {
      return { uploadUrl: `https://video.bunnycdn.com/tusupload/${videoId}`, resourceExpiresAt: expiresAt };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {}, provider, now: () => time,
    repository: createProductVideoRepository({ ...db, libraryId: "754739", now: () => time,
      invalidateCaches: async () => {}, enqueue: async () => {},
      async recordOperation(spec) {
        if (rejectCleanup) throw new Error("database unavailable");
        return (await db.operations.create([{ ...spec, session: undefined }]))[0];
      },
    }),
  });
  const observer = createVideoAssetObserver({ model: db.assets, now: () => time,
    onApplied: async (asset) => {
      await beforeVerifiedCommit?.(asset);
      return application.handleVerifiedAsset(asset);
    },
    onMissing: async (asset) => {
      if (beforeMissingCommit) await beforeMissingCommit();
      return application.handleMissingAsset(asset);
    },
    onDeleted: (asset) => application.handleDeletedAsset(asset),
  });
  const runtime = createVideoProviderRuntime({ provider: { ...provider,
    async getVideo(guid) {
      if (deleted.includes(guid)) throw { status: 404 };
      return provider.getVideo(guid);
    } }, assets: observer, operations: {
    async claimById({ operationId }) { return db.operations.findById(operationId); },
    async complete({ operationId }) { await db.operations.updateOne({ _id: operationId }, { $set: { done: true } }); return true; },
    async fail() {},
  } });
  return { application, provider, at(value) { time = value; },
    failCleanup(value) { rejectCleanup = value; },
    async reconcile(guid = "original-guid") {
      const asset = await db.assets.findOne({ providerGuid: guid });
      const [operation] = await db.operations.create([{ type: "reconcile", assetId: asset._id,
        libraryId: "754739", providerGuid: guid, leaseToken: "test-lease" }]);
      return runtime.process(operation._id);
    },
    async drainCleanup() {
      const rows = await db.operations.find({ type: "abandoned_upload_cleanup", done: { $exists: false } });
      for (const row of rows) await runtime.process(row._id);
      return [...deleted];
    },
  };
}

test("an expired Product Video whose provider resource is absent releases its slot with durable cleanup", async () => {
  const { application, reconcile, drainCleanup } = setup();
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("an existing status-0 Product upload is abandoned only at its original deadline", async () => {
  const { application, provider, at, reconcile, drainCleanup } = setup();
  provider.getVideo = async guid => ({ guid, status: 0 });
  at(deadline - 1);
  assert.equal((await reconcile()).status, "completed");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
  assert.deepEqual(await drainCleanup(), []);
  at(deadline);
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("an existing status-0 replacement is abandoned at its deadline while ready media remains", async () => {
  const { application, provider, at, reconcile, drainCleanup } = setup({ ready: true });
  const upload = await application.createReplacementUploadSession({ productId, videoId, actorId,
    idempotencyKey: "existing-abandoned-replacement", file: {
      clientId: "new", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } });
  provider.getVideo = async guid => ({ guid, status: 0 });
  at(deadline + 86_400_000 - 1);
  await reconcile("replacement-guid");
  assert.equal((await application.listAdminStatus({ productId }))[0].replacement.id, upload.replacementId);
  at(deadline + 86_400_000);
  await reconcile("replacement-guid");
  assert.deepEqual(await application.listAdminStatus({ productId }), [{ productVideoId: videoId,
    position: 2, status: "ready", showInReelsFeed: true, failureCode: "VIDEO_UPLOAD_ABANDONED" }]);
  assert.deepEqual(await drainCleanup(), ["replacement-guid"]);
});

test("status-0 abandonment rolls back when its durable obligation cannot be stored", async () => {
  const { application, provider, failCleanup, reconcile, drainCleanup } = setup();
  provider.getVideo = async guid => ({ guid, status: 0 });
  failCleanup(true);
  assert.equal((await reconcile()).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
  assert.deepEqual(await drainCleanup(), []);
  failCleanup(false);
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("processing and ready Product generations survive late status-0 observations past the deadline", async () => {
  for (const status of [1, 2, 3, 4]) {
    const { application, provider, at, reconcile, drainCleanup } = setup();
    at(deadline - 1);
    provider.getVideo = async guid => ({ guid, status, length: 2,
      width: 320, height: 240, availableResolutions: "240p" });
    await reconcile();
    at(deadline);
    provider.getVideo = async guid => ({ guid, status: 0 });
    await reconcile();
    assert.equal((await application.listAdminStatus({ productId }))[0].status,
      status === 4 ? "ready" : "awaiting_upload");
    assert.deepEqual(await drainCleanup(), []);
  }
});

test("a winning ready generation survives an earlier paused status-0 abandonment callback", async () => {
  let entered;
  let release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { application, provider, reconcile, drainCleanup } = setup({
    beforeVerifiedCommit: async asset => {
      if (asset.providerStatus === 0) { entered(); await gate; }
    },
  });
  provider.getVideo = async guid => ({ guid, status: 0 });
  const stale = reconcile();
  await paused;
  provider.getVideo = async guid => ({ guid, status: 4, length: 2,
    width: 320, height: 240, availableResolutions: "240p" });
  await reconcile();
  release();
  await stale;
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "ready");
  assert.deepEqual(await drainCleanup(), []);
});

test("foreign owner and library generations cannot be abandoned by a status-0 snapshot", async () => {
  for (const assetChanges of [{ ownerId: actorId }, { libraryId: "999" }, { ownerType: "reel" }]) {
    const { application, provider, reconcile, drainCleanup } = setup({ assetChanges });
    provider.getVideo = async guid => ({ guid, status: 0 });
    await reconcile();
    assert.equal((await application.listAdminStatus({ productId })).length, 1);
    assert.deepEqual(await drainCleanup(), []);
  }
});

test("an absent expired replacement is retired without removing the old ready Product Video", async () => {
  const { application, at, reconcile, drainCleanup } = setup({ ready: true });
  const request = { productId, videoId, actorId, idempotencyKey: "replace-expired-001",
    file: { clientId: "replacement", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } };
  await application.createReplacementUploadSession(request);
  at(deadline + 86_400_000);
  assert.equal((await reconcile("replacement-guid")).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), [{ productVideoId: videoId,
    position: 2, status: "ready", showInReelsFeed: true, failureCode: "VIDEO_UPLOAD_ABANDONED" }]);
  assert.deepEqual(await drainCleanup(), ["replacement-guid"]);
  assert.equal((await application.createReplacementUploadSession(request)).status, "failed");
});

test("an empty provider response is not accepted as evidence that an expired upload is absent", async () => {
  const { application, provider, reconcile, drainCleanup } = setup();
  provider.getVideo = async () => undefined;
  assert.equal((await reconcile()).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId })).length, 1);
  assert.deepEqual(await drainCleanup(), []);
});

test("repeated absence reconciliation completes without duplicating cleanup after local detachment", async () => {
  const { reconcile, drainCleanup } = setup();
  await reconcile();
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("absence before the original deadline does not abandon a resumable Product Video", async () => {
  const { application, at, reconcile, drainCleanup } = setup();
  at(deadline - 1);
  assert.equal((await reconcile()).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
  assert.deepEqual(await drainCleanup(), []);
  at(deadline);
  assert.equal((await reconcile()).status, "completed");
});

for (const status of [401, 403, 429, 500, null]) {
  test(`provider failure ${status ?? "timeout"} cannot abandon an expired upload`, async () => {
    const { application, provider, reconcile, drainCleanup } = setup();
    provider.getVideo = async () => { throw { status, code: "BUNNY_STREAM_TIMEOUT" }; };
    assert.equal((await reconcile()).status, "retryable");
    assert.equal((await application.listAdminStatus({ productId })).length, 1);
    assert.deepEqual(await drainCleanup(), []);
  });
}

test("a processing replacement survives its deadline and a later provider absence", async () => {
  const { application, provider, at, reconcile, drainCleanup } = setup({ ready: true });
  await application.createReplacementUploadSession({ productId, videoId, actorId, idempotencyKey: "processing-001",
    file: { clientId: "replacement", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } });
  provider.getVideo = async () => ({ guid: "replacement-guid", status: 2 });
  await reconcile("replacement-guid");
  at(deadline + 86_400_000);
  provider.getVideo = async () => { throw { status: 404 }; };
  assert.equal((await reconcile("replacement-guid")).status, "retryable");
  const [status] = await application.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement.status, "processing");
  assert.deepEqual(await drainCleanup(), []);
});

test("failed cleanup persistence rolls back abandonment and can recover on the next reconciliation", async () => {
  const { application, failCleanup, reconcile, drainCleanup } = setup();
  failCleanup(true);
  assert.equal((await reconcile()).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
  assert.deepEqual(await drainCleanup(), []);
  failCleanup(false);
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("a ready Product Video is never abandoned by an old missing-resource observation", async () => {
  const { application, reconcile, drainCleanup } = setup({ ready: true });
  assert.equal((await reconcile()).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "ready");
  assert.deepEqual(await drainCleanup(), []);
});

test("a ready observation wins over an earlier paused missing observation", async () => {
  let resumeMissing;
  let missingEntered;
  const paused = new Promise((resolve) => { missingEntered = resolve; });
  const gate = new Promise((resolve) => { resumeMissing = resolve; });
  const { application, provider, reconcile, drainCleanup } = setup({
    beforeMissingCommit: async () => { missingEntered(); await gate; },
  });
  let observations = 0;
  provider.getVideo = async () => {
    if (++observations === 1) throw { status: 404 };
    return { guid: "original-guid", status: 4, length: 2,
      width: 320, height: 240, availableResolutions: "240p" };
  };
  const staleMissing = reconcile();
  await paused;
  assert.equal((await reconcile()).status, "completed");
  resumeMissing();
  assert.equal((await staleMissing).status, "retryable");
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "ready");
  assert.deepEqual(await drainCleanup(), []);
});

test("a late ready observation cannot revive a Product Video after absence cleanup committed", async () => {
  const { application, provider, reconcile, drainCleanup } = setup();
  assert.equal((await reconcile()).status, "completed");
  provider.getVideo = async () => ({ guid: "original-guid", status: 4,
    length: 2, width: 320, height: 240, availableResolutions: "240p" });
  assert.equal((await reconcile()).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.deepEqual(await drainCleanup(), ["original-guid"]);
});

test("a late ready replacement observation cannot replace the old video after abandonment", async () => {
  const { application, provider, at, reconcile, drainCleanup } = setup({ ready: true });
  await application.createReplacementUploadSession({ productId, videoId, actorId,
    idempotencyKey: "replacement-late-ready-001",
    file: { clientId: "replacement", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 } });
  at(deadline + 86_400_000);
  assert.equal((await reconcile("replacement-guid")).status, "completed");
  provider.getVideo = async () => ({ guid: "replacement-guid", status: 4,
    length: 2, width: 320, height: 240, availableResolutions: "240p" });
  assert.equal((await reconcile("replacement-guid")).status, "completed");
  assert.deepEqual(await application.listAdminStatus({ productId }), [{ productVideoId: videoId,
    position: 2, status: "ready", showInReelsFeed: true, failureCode: "VIDEO_UPLOAD_ABANDONED" }]);
  assert.deepEqual(await drainCleanup(), ["replacement-guid"]);
});
