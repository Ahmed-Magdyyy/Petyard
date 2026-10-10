import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const actorId = "507f1f77bcf86cd799439012";
const batchId = "507f1f77bcf86cd799439013";
const assetId = "507f1f77bcf86cd799439014";
const request = { productId, actorId, idempotencyKey: "issued-batch-key",
  files: [{ clientId: "selected", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 }] };
const deadline = Date.parse("2026-09-28T00:00:00Z");

function setup(time, assetState = "awaiting_upload", trusted = true) {
  const db = replacementDatabase({
    batches: [{ _id: batchId, productId, actorId, idempotencyKey: request.idempotencyKey, status: "issued",
      requestFingerprint: createHash("sha256").update(JSON.stringify({ actorId, files: request.files })).digest("hex") }],
    placements: [{ _id: videoId, productId, uploadBatchId: batchId, position: 2, clientId: "selected",
      activeSlot: true, lifecycleState: "awaiting_upload", activeAssetId: assetId, abandonAt: new Date(deadline) }],
    assets: [{ _id: assetId, ownerType: "product_video", ownerId: videoId,
      ...(trusted ? { tusUploadUrl: "https://video.bunnycdn.com/tusupload/existing-guid", tusResourceExpiresAt: deadline / 1000 } : {}),
      libraryId: "754739", providerGuid: "existing-guid", technicalState: assetState }],
  });
  return createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {}, now: () => time,
    repository: createProductVideoRepository({ ...db, libraryId: "754739", now: () => time }),
    provider: {
      async createVideo() { throw new Error("Replay must not create a provider resource"); },
      createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
    },
  });
}

test("issued batch replay cannot extend upload authorization past its original 24-hour deadline", async () => {
  const application = setup(Date.parse("2026-09-27T23:00:00Z"));
  const [result] = await application.createUploadSessions(request);
  assert.equal(result.productVideoId, videoId);
  assert.equal(result.position, 2);
  assert.equal(result.upload.headers.VideoId, "existing-guid");
  assert.equal(result.upload.expiresAt, 1790553600);
});

test("legacy unbound sessions cannot gain a new TUS resource through replay or refresh", async () => {
  const application = setup(deadline - 3_600_000, "awaiting_upload", false);
  await assert.rejects(application.createUploadSessions(request), (error) => error.statusCode === 409);
  await assert.rejects(application.refreshUploadAuthorization({ productId, videoId }), (error) => error.statusCode === 409);
});

test("issued batch replay rejects an expired session without creating or cleaning a video", async () => {
  await assert.rejects(setup(deadline).createUploadSessions(request),
    (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_UPLOAD_CONFLICT");
});

test("issued batch replay cannot grant upload access to processing or finished media", async () => {
  for (const state of ["processing", "ready", "failed", "deleting", "deleted"]) {
    await assert.rejects(setup(deadline - 3_600_000, state).createUploadSessions(request),
      (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_UPLOAD_CONFLICT");
  }
});

test("issued batch replay still limits early refreshes to six hours", async () => {
  const [result] = await setup(Date.parse("2026-09-27T12:00:00Z")).createUploadSessions(request);
  assert.equal(result.upload.expiresAt, 1790532000);
});
