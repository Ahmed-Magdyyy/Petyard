import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../src/domains/videos/productVideos/productVideo.service.js";
import { createReelUploadService } from "../../../src/domains/videos/reels/reelUpload.service.js";

const nowMs = Date.UTC(2026, 9, 1);
const seconds = nowMs / 1000;
const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const file = { clientId: "first", filename: "test.mp4", mimeType: "video/mp4", sizeBytes: 100 };

for (const kind of ["product", "reel", "replacement"]) {
  test(`${kind} initial, replay and refresh grants respect the configured upload lifetime`, async () => {
    let resource;
    const provider = {
      async createVideo() { return { guid: "video-guid" }; },
      async createTusUpload({ expiresAt }) {
        assert.equal(expiresAt, seconds + 3600);
        resource = { providerGuid: "video-guid", uploadUrl: "https://video.bunnycdn.com/tusupload/resource",
          resourceExpiresAt: expiresAt, abandonAt: new Date(nowMs + 86400000) };
        return resource;
      },
      createTusUploadAuthorization({ expiresAt }) {
        assert.ok(expiresAt <= seconds + 3600);
        return { expiresAt };
      },
    };
    const common = { provider, now: () => nowMs, uploadAuthorizationTtlSeconds: 3600 };
    let issued = false;
    let create;
    let refresh;
    if (kind === "reel") {
      const { clientId, ...reelFile } = file;
      const input = { videoId, actor: { id: productId, role: "admin" }, idempotencyKey: "upload-key-123", file: reelFile };
      const app = createReelUploadService({ ...common, repository: {
        async reserve() { return issued ? { id: videoId, status: "issued", ...resource }
          : { id: videoId, status: "reserving", newlyCreated: true, providerTitle: `petyard-reel-session:${videoId}` }; },
        async attachProviderVideo() {},
        async issue() { issued = true; return resource; },
        async failSetup() { assert.fail("unexpected cleanup"); },
        async getSessionContext() { return { video: { _id: videoId, status: "draft" },
          row: { _id: videoId, status: "issued", abandonAt: resource.abandonAt }, isCurrent: true,
          asset: { technicalState: "awaiting_upload", providerGuid: resource.providerGuid,
            tusUploadUrl: resource.uploadUrl, tusResourceExpiresAt: resource.resourceExpiresAt } }; },
      } });
      create = () => app.createSession(input);
      refresh = () => app.refreshUploadAuthorization({ ...input, sessionId: videoId });
    } else {
      const input = { productId, videoId, actorId: productId, idempotencyKey: "upload-key-123", file, files: [file] };
      const app = createProductVideoService({ ...common, repository: {
        async reserveBatch() { return { status: issued ? "issued" : "reserved",
          placements: [{ id: videoId, clientId: "first", position: 0, ...(issued ? resource : {}) }] }; },
        async attachProviderVideo() {}, async attachTusUpload() {}, async markBatchIssued() { issued = true; },
        async failBatch() { assert.fail("unexpected cleanup"); },
        async getRefreshableUpload() { return { ...resource, productVideoId: videoId, position: 0, status: "awaiting_upload" }; },
        async reserveReplacement() { return { id: videoId, position: 0, status: issued ? "issued" : "reserving", ...(issued ? resource : {}) }; },
        async attachReplacementVideo() {},
        async issueReplacement() { issued = true; return { id: videoId, position: 0, status: "issued", ...resource }; },
        async failReplacementSetup() { assert.fail("unexpected cleanup"); },
        async getRefreshableReplacement() { return { position: 0, ...resource }; },
      } });
      create = kind === "product" ? async () => (await app.createUploadSessions(input))[0]
        : () => app.createReplacementUploadSession(input);
      refresh = kind === "product" ? () => app.refreshUploadAuthorization(input)
        : () => app.refreshReplacementAuthorization({ ...input, replacementId: videoId });
    }
    assert.equal((await create()).upload.expiresAt, seconds + 3600);
    assert.equal((await create()).upload.expiresAt, seconds + 3600);
    assert.equal((await refresh()).upload.expiresAt, seconds + 3600);
  });
}
