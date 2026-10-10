import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const productId = "507f191e810c19729de860ea";
const actorId = "507f1f77bcf86cd799439012";
const start = Date.parse("2026-09-27T00:00:00Z");
const request = { productId, actorId, idempotencyKey: "trusted-batch-001",
  files: [{ clientId: "selected", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 }] };

function setup() {
  let time = start;
  const db = replacementDatabase({ products: [{ _id: productId }] }, { now: () => time });
  const creations = [];
  const reservations = [];
  const cleanup = [];
  const provider = {
    async createVideo(input) { reservations.push(input); return { guid: "new-guid" }; },
    async createTusUpload(input) {
      creations.push(input);
      return { uploadUrl: "https://video.bunnycdn.com/tusupload/trusted-resource", resourceExpiresAt: input.expiresAt };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { endpoint: "tus", expiresAt, headers: { VideoId: videoId } }; },
  };
  const repository = createProductVideoRepository({ ...db, libraryId: "754739", now: () => time,
    invalidateCaches: async () => {}, enqueue: async () => {},
    async recordOperation(input) { cleanup.push(input); return { _id: "cleanup-id" }; } });
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {}, repository, provider, now: () => time });
  return { application, provider, creations, reservations, cleanup, at(value) { time = value; } };
}

test("initial Product Videos use their reserved placement identity as an exact provider marker without exposing it", async () => {
  const { application, creations, reservations } = setup();
  const [first] = await application.createUploadSessions(request);
  await application.createUploadSessions(request);
  const marker = `petyard-product-video:${first.productVideoId}`;
  assert.deepEqual(reservations, [{ title: marker }]);
  assert.equal(creations[0].title, marker);
  assert.equal(JSON.stringify(first).includes(marker), false);
  assert.equal(JSON.stringify(await application.listAdminStatus({ productId })).includes(marker), false);
});

test("a product upload returns a server-created resource that refresh and replay reuse", async () => {
  const { application, creations } = setup();
  const [first] = await application.createUploadSessions(request);
  const [replay] = await application.createUploadSessions(request);
  const refreshed = await application.refreshUploadAuthorization({ productId, videoId: first.productVideoId });
  assert.equal(first.upload.uploadUrl, "https://video.bunnycdn.com/tusupload/trusted-resource");
  assert.equal(replay.upload.uploadUrl, first.upload.uploadUrl);
  assert.equal(refreshed.upload.uploadUrl, first.upload.uploadUrl);
  assert.equal(first.upload.resourceExpiresAt, 1790488800);
  assert.equal(creations.length, 1);
  assert.equal(creations[0].sizeBytes, 100);
  assert.equal(creations[0].mimeType, "video/mp4");
});

test("TUS creation failure releases the batch and durably cleans the already persisted video", async () => {
  const { application, provider, cleanup } = setup();
  provider.createTusUpload = async () => { throw new Error("uncertain POST with secret Location"); };
  await assert.rejects(application.createUploadSessions(request), (error) =>
    error.statusCode === 503 && !error.message.includes("secret"));
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].providerGuid, "new-guid");
  await assert.rejects(application.createUploadSessions(request), (error) => error.statusCode === 409);
});

test("expired trusted upload refuses replay and refresh without creating or deleting provider media", async () => {
  const { application, creations, cleanup, at } = setup();
  const [first] = await application.createUploadSessions(request);
  at(start + 6 * 60 * 60 * 1000);
  await assert.rejects(application.createUploadSessions(request), (error) => error.statusCode === 409);
  await assert.rejects(application.refreshUploadAuthorization({ productId, videoId: first.productVideoId }),
    (error) => error.statusCode === 409);
  assert.equal(creations.length, 1);
  assert.equal(cleanup.length, 0);
  assert.equal((await application.listAdminStatus({ productId }))[0].status, "awaiting_upload");
});

test("expired upload refresh reports resource expiry without allocating or deleting media", async () => {
  const { application, creations, cleanup, at } = setup();
  const [first] = await application.createUploadSessions(request);
  at(start + 6 * 60 * 60 * 1000);
  await assert.rejects(application.refreshUploadAuthorization({ productId, videoId: first.productVideoId }),
    (error) => error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_UPLOAD_RESOURCE_EXPIRED");
  assert.equal(creations.length, 1);
  assert.equal(cleanup.length, 0);
});
