import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createVideoPosterService } from "../../../../src/domains/videos/provider/videoPoster.service.js";
import { createVideoPosterStore } from "../../../../src/domains/videos/provider/videoPoster.store.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { VideoAssetModel } from "../../../../src/domains/videos/provider/videoAsset.model.js";
import { VideoProviderOperationModel } from "../../../../src/domains/videos/provider/videoProviderOperation.model.js";
import { recordVideoProviderOperation } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { uploadImage } from "../../../../src/shared/utils/imageUpload.js";

const assetId = "507f191e810c19729de860ea";
const operation = { _id: "507f1f77bcf86cd799439011", type: "copy_poster", assetId,
  libraryId: "754739", providerGuid: "video-guid", leaseToken: "lease" };
const descriptor = { public_id: `petyard/video-posters/${assetId}`,
  url: `https://images.example/petyard/video-posters/${assetId}.webp` };
const configuration = () => ({ publicProvider: "bunny", public: {
  zone: "public-images", endpoint: "https://storage.bunnycdn.com",
  accessKey: "test-storage-key", cdnBaseUrl: "https://images.example" }, storageTimeoutMs: 15000 });

function fixture({ changeDuringUpload, attachFailure } = {}) {
  const asset = { _id: assetId, technicalState: "ready", providerStatus: 4 };
  const calls = [];
  const application = createVideoPosterService({
    provider: { async getVideo() { calls.push("get");
      return { guid: "video-guid", status: 4, videoLibraryId: 754739,
        thumbnailFileName: "thumbnail.jpg" }; },
    async readThumbnail(input) { calls.push(input); return Buffer.from("image"); } },
    store: { async upload(input) { calls.push({ upload: input.assetId });
      changeDuringUpload?.(asset); return descriptor; },
    async remove(input) { calls.push({ remove: input.assetId }); } },
    model: { async findOne(filter) {
      assert.deepEqual(filter, { _id: assetId, libraryId: "754739", providerGuid: "video-guid" });
      return { ...asset }; },
    async findOneAndUpdate(filter, update, options) {
      assert.deepEqual(filter.deletionRequestedAt, { $exists: false });
      assert.deepEqual(filter.deleteAcceptedAt, { $exists: false });
      assert.deepEqual(filter["poster.url"], { $exists: false });
      assert.equal(options.runValidators, true);
      if (attachFailure) throw new Error("database unavailable");
      if (asset.deletionRequestedAt || asset.technicalState !== "ready" || asset.poster) return null;
      Object.assign(asset, update.$set); return asset;
    } },
  });
  return { application, asset, calls };
}

test("cover copying attaches one stable descriptor and repeated work skips provider writes", async () => {
  const { application, asset, calls } = fixture();
  await application.copy({ operation });
  assert.deepEqual(asset.poster, descriptor);
  assert.ok(asset.posterCopiedAt instanceof Date);
  const firstCalls = [...calls];
  await application.copy({ operation });
  assert.deepEqual(calls, firstCalls);
});

test("deletion during a cover PUT prevents attachment and compensates the copied object", async () => {
  const { application, asset, calls } = fixture({ changeDuringUpload(asset) {
    asset.deletionRequestedAt = new Date();
  } });
  await application.copy({ operation });
  assert.equal(asset.poster, undefined);
  assert.deepEqual(calls.at(-1), { remove: assetId });
});

test("retry on a deleted generation cleans its deterministic key without fetching a thumbnail", async () => {
  const { application, asset, calls } = fixture();
  asset.technicalState = "deleted";
  await application.copy({ operation });
  assert.deepEqual(calls, [{ remove: assetId }]);
});

test("a pending or rejected Stream delete preserves an already attached public cover", async () => {
  const { application, asset, calls } = fixture();
  asset.poster = descriptor;
  asset.deletionRequestedAt = new Date();
  await application.copy({ operation });
  assert.deepEqual(asset.poster, descriptor);
  assert.deepEqual(calls, []);
  asset.deleteAcceptedAt = new Date();
  await application.copy({ operation });
  assert.deepEqual(calls, [{ remove: assetId }]);
});

test("an uncertain Mongo attachment is retried without deleting a potentially acknowledged cover", async () => {
  const { application, asset, calls } = fixture({ attachFailure: true });
  await assert.rejects(application.copy({ operation }));
  assert.equal(asset.poster, undefined);
  assert.equal(calls.some((call) => call.remove), false);
});

test("a duplicate copy does not delete an already attached cover owned by the same generation", async () => {
  const { application, asset, calls } = fixture({ changeDuringUpload(asset) { asset.poster = descriptor; } });
  await application.copy({ operation });
  assert.deepEqual(asset.poster, descriptor);
  assert.equal(calls.some((call) => call.remove), false);
});

test("poster copy refuses missing local identity and mismatched provider library or GUID", async () => {
  for (const snapshot of [null, { guid: "other", status: 4, videoLibraryId: 754739 },
    { guid: "video-guid", status: 4, videoLibraryId: 99 },
    { guid: "video-guid", status: 2, videoLibraryId: 754739 }]) {
    let writes = 0;
    const application = createVideoPosterService({
      model: { async findOne() { return { technicalState: "ready", providerStatus: 4 }; } },
      provider: { async getVideo() { return snapshot; }, async readThumbnail() { writes++; } },
      store: { async upload() { writes++; }, async remove() { writes++; } },
    });
    await assert.rejects(application.copy({ operation }));
    assert.equal(writes, 0);
  }
  const { application } = fixture();
  await assert.rejects(application.copy({ operation: { ...operation, assetId: "other" } }));
});

test("poster store reuses the public image uploader with a deterministic filename", async () => {
  const buffer = await sharp({ create: { width: 8, height: 12, channels: 3,
    background: "red" } }).jpeg().toBuffer();
  const calls = [];
  const store = createVideoPosterStore({ configuration,
    async upload(file, options) { calls.push({ file, options }); return descriptor; } });
  assert.deepEqual(await store.upload({ assetId, buffer }), descriptor);
  await store.upload({ assetId, buffer });
  assert.equal(calls[0].file.mimetype, "image/jpeg");
  assert.equal(calls[0].options.folder, "petyard/video-posters");
  assert.equal(calls[0].options.publicId, assetId);
  assert.deepEqual(calls[0].options, calls[1].options);
});

test("the actual image pipeline writes WebP to the key used by poster cleanup", async () => {
  const buffer = await sharp({ create: { width: 8, height: 12, channels: 3,
    background: "red" } }).jpeg().toBuffer();
  const writes = [];
  const deletes = [];
  const store = createVideoPosterStore({ configuration,
    upload: (file, options) => uploadImage(file, { ...options,
      bunnyUpload: async (input) => { writes.push(input); } }),
    remove: async (input) => { deletes.push(input); },
  });
  assert.deepEqual(await store.upload({ assetId, buffer }), descriptor);
  await store.upload({ assetId, buffer });
  await store.remove({ assetId });
  assert.equal(writes[0].objectKey, deletes[0].objectKey);
  assert.equal(writes[0].objectKey, writes[1].objectKey);
  assert.equal(writes[0].contentType, "image/webp");
  assert.equal((await sharp(writes[0].buffer).metadata()).format, "webp");
});

test("poster store rejects SVG, corrupt bytes, oversized inputs and traversal before any PUT", async () => {
  let writes = 0;
  const store = createVideoPosterStore({ configuration, async upload() { writes++; } });
  for (const buffer of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'),
    Buffer.from("broken image"), Buffer.alloc(5 * 1024 * 1024 + 1), Buffer.alloc(0)]) {
    await assert.rejects(store.upload({ assetId, buffer }));
  }
  await assert.rejects(store.upload({ assetId: "../other", buffer: Buffer.from("image") }));
  assert.equal(writes, 0);
});

test("strict cover cleanup derives the key even without a descriptor and propagates rejection", async () => {
  const requests = [];
  const store = createVideoPosterStore({ configuration,
    async remove(input) { requests.push(input); throw new Error("storage rejected"); } });
  await assert.rejects(store.remove({ assetId }));
  assert.equal(requests[0].objectKey, `petyard/video-posters/${assetId}.webp`);
  assert.equal(requests[0].zone, "public-images");
  assert.equal(requests[0].timeoutMs, 15000);
});

test("poster copies require Bunny public-image configuration", async () => {
  const store = createVideoPosterStore({ configuration: () => ({ publicProvider: "cloudinary" }) });
  await assert.rejects(store.remove({ assetId }), /VIDEO_POSTER_BUNNY_STORAGE_REQUIRED/);
});

test("poster schema accepts stable URLs, rejects signed provider URLs, and operation recording accepts copies", async () => {
  const asset = new VideoAssetModel({ ownerType: "reel", ownerId: assetId,
    libraryId: "754739", providerGuid: "video-guid", poster: descriptor });
  await asset.validate();
  asset.poster.url = "https://stream.example/thumbnail.jpg?token=secret";
  await assert.rejects(asset.validate());
  const record = new VideoProviderOperationModel({ ...operation, dedupeKey: `poster:${assetId}` });
  await record.validate();
  const result = await recordVideoProviderOperation({ ...operation, dedupeKey: `poster:${assetId}`,
    model: { async findOneAndUpdate(filter, update) { return update.$setOnInsert; } } });
  assert.equal(result.type, "copy_poster");
});

test("missing posters are recorded durably before the asset marker even when enqueue fails", async () => {
  const calls = [];
  const runtime = createVideoProviderRuntime({ provider: {}, posters: {},
    operations: { async record(input) { calls.push(input); return { _id: operation._id }; } },
    assets: { async listNeedingPoster(input) {
      assert.deepEqual(input, { libraryId: "754739", limit: 100 });
      return [{ _id: assetId, libraryId: "754739", providerGuid: "video-guid" }]; },
    async markPosterRequested() { calls.push("marked"); } },
    async enqueue() { calls.push("enqueue"); throw new Error("Redis unavailable"); },
  });
  assert.deepEqual(await runtime.recoverPosters({ libraryId: "754739" }), { found: 1, queued: 0 });
  assert.equal(calls[0].type, "copy_poster");
  assert.equal(calls[0].dedupeKey, `poster:${assetId}`);
  assert.deepEqual(calls.slice(1), ["enqueue", "marked"]);
});

test("poster recovery never marks an asset when recording the obligation fails", async () => {
  const runtime = createVideoProviderRuntime({ provider: {}, posters: {},
    operations: { async record() { throw new Error("Mongo unavailable"); } },
    assets: { async listNeedingPoster() { return [{ _id: assetId }]; },
      async markPosterRequested() { assert.fail("no obligation persisted"); } },
  });
  await assert.rejects(runtime.recoverPosters({ libraryId: "754739" }));
});

test("poster observer selects only this library's unscheduled ready non-deleting generations", async () => {
  let filter;
  const observer = createVideoAssetObserver({ model: { find(input) { filter = input;
    return { sort() { return this; }, limit() { return this; }, async lean() { return []; } }; } } });
  await observer.listNeedingPoster({ libraryId: "754739", limit: 10 });
  assert.deepEqual(filter, { libraryId: "754739", technicalState: "ready", providerStatus: 4,
    deletionRequestedAt: { $exists: false }, deleteAcceptedAt: { $exists: false },
    "poster.url": { $exists: false }, posterRequestedAt: { $exists: false } });
});

test("failed poster copies keep their leased operation retryable with a sanitized error", async () => {
  let failure;
  const runtime = createVideoProviderRuntime({ provider: {}, assets: {},
    operations: { async claimById() { return operation; }, async fail(input) { failure = input; },
      async complete() { assert.fail("copy failed"); } },
    posters: { async copy() { throw new Error("secret URL and key"); } },
  });
  assert.deepEqual(await runtime.process(operation._id), { status: "retryable" });
  assert.equal(failure.errorCode, "VIDEO_POSTER_COPY_FAILED");
  assert.equal(JSON.stringify(failure).includes("secret"), false);
});

test("Stream acceptance removes public media but keeps cleanup due if image deletion fails", async () => {
  const calls = [];
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { calls.push("stream accepted"); },
      async getVideo() { throw { status: 404 }; } },
    assets: { async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { calls.push("asset removed"); } },
    operations: { async claimById() { return { ...operation, type: "delete" }; },
      async fail(input) { calls.push(input.errorCode); }, async complete() { assert.fail("cover remains"); } },
    posters: { async remove() { calls.push("image delete"); throw new Error("rejected"); } },
  });
  assert.deepEqual(await runtime.process(operation._id), { status: "retryable" });
  assert.deepEqual(calls, ["stream accepted", "asset removed", "image delete", "VIDEO_POSTER_CLEANUP_FAILED"]);
});

test("a rejected Stream delete does not remove the cover or detach the asset", async () => {
  const runtime = createVideoProviderRuntime({ provider: { async deleteVideo() { throw { status: 403 }; } },
    assets: { async getDeletionTarget() { return {}; }, async markDeleteAccepted() { assert.fail(); } },
    operations: { async claimById() { return { ...operation, type: "delete" }; }, async fail() {} },
    posters: { async remove() { assert.fail("Stream rejected"); } },
  });
  assert.deepEqual(await runtime.process(operation._id), { status: "retryable" });
});

test("a confirmed absent Stream resource completes only after strict cover cleanup", async () => {
  const calls = [];
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { throw { status: 404 }; },
      async getVideo() { throw { status: 404 }; } },
    assets: { async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { calls.push("accepted"); } },
    operations: { async claimById() { return { ...operation, type: "delete" }; },
      async complete() { calls.push("completed"); return operation; } },
    posters: { async remove() { calls.push("poster removed"); } },
  });
  assert.deepEqual(await runtime.process(operation._id), { status: "completed" });
  assert.deepEqual(calls, ["accepted", "poster removed", "completed"]);
});

test("an unclaimed poster operation never performs provider or image work", async () => {
  const runtime = createVideoProviderRuntime({ provider: {}, assets: {},
    operations: { async claimById() { return null; } },
    posters: { async copy() { assert.fail("no lease"); } },
  });
  assert.deepEqual(await runtime.process(operation._id), { status: "skipped" });
});

for (const failedCopy of [false, true]) {
  test(`a stale poster ${failedCopy ? "failure" : "completion"} creates a fresh durable compensation check`, async () => {
    let recorded;
    const runtime = createVideoProviderRuntime({ provider: {}, assets: {},
      posters: { async copy() { if (failedCopy) throw new Error("late cleanup failed"); } },
      operations: { async claimById() { return operation; }, async complete() { return null; },
        async fail() { return null; }, async record(input) { recorded = input; return { _id: "new-operation" }; } },
      async enqueue(id) { assert.equal(id, "new-operation"); },
    });
    assert.deepEqual(await runtime.process(operation._id), { status: failedCopy ? "retryable" : "stale" });
    assert.equal(recorded.type, "copy_poster");
    assert.equal(recorded.assetId, assetId);
    assert.equal(recorded.dedupeKey, `poster-late:${operation._id}:${operation.leaseToken}`);
  });
}
