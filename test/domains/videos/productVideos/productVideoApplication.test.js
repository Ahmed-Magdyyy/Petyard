import assert from "node:assert/strict";
import test from "node:test";

import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";

test("a product editor receives upload sessions in selection order", async () => {
  const placements = [
    { id: "placement-a", clientId: "first", position: 0, providerGuid: null },
    { id: "placement-b", clientId: "second", position: 1, providerGuid: null },
  ];
  const attached = new Map();
  const repository = {
    async reserveBatch() { return { status: "reserved", placements }; },
    async attachProviderVideo({ placementId, providerGuid }) {
      attached.set(placementId, providerGuid);
    },
    async attachTusUpload() {},
    async markBatchIssued() {},
  };
  let next = 0;
  const provider = {
    async createVideo() { next += 1; return { guid: `guid-${next}` }; },
    async createTusUpload({ videoId, expiresAt }) {
      return { uploadUrl: `https://video.bunnycdn.com/tusupload/${videoId}`, resourceExpiresAt: expiresAt };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) {
      return {
        endpoint: "https://video.bunnycdn.com/tusupload",
        expiresAt,
        headers: { VideoId: videoId, AuthorizationSignature: "ephemeral-signature" },
      };
    },
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository, provider, now: () => Date.parse("2026-09-23T00:00:00Z"),
  });

  const result = await application.createUploadSessions({
    productId: "507f191e810c19729de860ea",
    actorId: "507f1f77bcf86cd799439011",
    idempotencyKey: "batch-key-123",
    files: [
      { clientId: "first", filename: "first.mp4", mimeType: "video/mp4", sizeBytes: 100, showInReelsFeed: true },
      { clientId: "second", filename: "second.mov", mimeType: "video/quicktime", sizeBytes: 200, showInReelsFeed: false },
    ],
  });

  assert.deepEqual(result.map(({ clientId, productVideoId, position, status }) => ({
    clientId, productVideoId, position, status,
  })), [
    { clientId: "first", productVideoId: "placement-a", position: 0, status: "awaiting_upload" },
    { clientId: "second", productVideoId: "placement-b", position: 1, status: "awaiting_upload" },
  ]);
  assert.deepEqual([...attached.entries()], [
    ["placement-a", "guid-1"], ["placement-b", "guid-2"],
  ]);
  assert.equal(result[0].upload.headers.VideoId, "guid-1");
});

test("invalid media is rejected before reserving product capacity or calling Bunny", async () => {
  let touched = false;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: { async reserveBatch() { touched = true; } },
    provider: { async createVideo() { touched = true; } },
  });

  await assert.rejects(application.createUploadSessions({
    productId: "507f191e810c19729de860ea",
    actorId: "507f1f77bcf86cd799439011",
    idempotencyKey: "batch-key-123",
    files: [{
      clientId: "first", filename: "demo.avi", mimeType: "video/x-msvideo",
      sizeBytes: 251 * 1024 * 1024, showInReelsFeed: true,
    }],
  }), (error) => error.statusCode === 400 &&
    error.errors?.[0]?.code === "VIDEO_INVALID_MEDIA");
  assert.equal(touched, false);
});

test("partial batch setup returns no sessions and persists cleanup for created provider videos", async () => {
  const placements = [
    { id: "placement-a", clientId: "first", position: 0, providerGuid: null },
    { id: "placement-b", clientId: "second", position: 1, providerGuid: null },
  ];
  let cleanup;
  let creations = 0;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async reserveBatch() { return { status: "reserved", placements }; },
      async attachProviderVideo() {},
      async attachTusUpload() {},
      async failBatch(specification) { cleanup = specification; },
    },
    provider: {
      async createVideo() {
        creations += 1;
        if (creations === 2) throw new Error("provider rejected upload");
        return { guid: "guid-1" };
      },
      createTusUploadAuthorization() { return { endpoint: "tus" }; },
      async createTusUpload({ expiresAt }) {
        return { uploadUrl: "https://video.bunnycdn.com/tusupload/guid-1", resourceExpiresAt: expiresAt };
      },
    },
  });

  await assert.rejects(application.createUploadSessions({
    productId: "507f191e810c19729de860ea",
    actorId: "507f1f77bcf86cd799439011",
    idempotencyKey: "batch-key-123",
    files: [
      { clientId: "first", filename: "first.mp4", mimeType: "video/mp4", sizeBytes: 100 },
      { clientId: "second", filename: "second.mp4", mimeType: "video/mp4", sizeBytes: 100 },
    ],
  }), (error) => error.statusCode === 503 &&
    error.errors?.[0]?.code === "VIDEO_PROVIDER_UNAVAILABLE");
  assert.deepEqual(cleanup.createdVideos, [{ placementId: "placement-a", providerGuid: "guid-1" }]);
});

test("an issued batch replay re-signs the same provider video without creating another", async () => {
  let created = false;
  let issuedAgain = false;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async reserveBatch() {
        return { status: "issued", placements: [{
          id: "placement-a", clientId: "first", position: 2, providerGuid: "existing-guid",
          abandonAt: new Date(Date.now() + 86_400_000),
          uploadUrl: "https://video.bunnycdn.com/tusupload/existing-guid", resourceExpiresAt: Math.floor(Date.now() / 1000) + 21600,
        }] };
      },
      async markBatchIssued() { issuedAgain = true; },
    },
    provider: {
      async createVideo() { created = true; },
      createTusUploadAuthorization({ videoId }) {
        return { endpoint: "tus", headers: { VideoId: videoId } };
      },
    },
  });

  const [result] = await application.createUploadSessions({
    productId: "507f191e810c19729de860ea",
    actorId: "507f1f77bcf86cd799439011",
    idempotencyKey: "batch-key-123",
    files: [{ clientId: "first", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 }],
  });

  assert.equal(result.productVideoId, "placement-a");
  assert.equal(result.upload.headers.VideoId, "existing-guid");
  assert.equal(created, false);
  assert.equal(issuedAgain, false);
});

test("an inconsistent issued batch never allocates a replacement provider resource", async () => {
  let created = false;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: { async reserveBatch() {
      return { status: "issued", placements: [{
        id: "placement-a", clientId: "first", position: 0, providerGuid: null,
      }] };
    } },
    provider: { async createVideo() { created = true; } },
  });

  await assert.rejects(application.createUploadSessions({
    productId: "507f191e810c19729de860ea",
    actorId: "507f1f77bcf86cd799439011",
    idempotencyKey: "batch-key-123",
    files: [{ clientId: "first", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 }],
  }), (error) => error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_UPLOAD_CONFLICT");
  assert.equal(created, false);
});

test("an unfinished Product Video refreshes authorization for its existing Bunny resource", async () => {
  let created = false;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: { async getRefreshableUpload() {
      return {
        productVideoId: "placement-a", position: 1, status: "awaiting_upload",
        providerGuid: "existing-guid",
        uploadUrl: "https://video.bunnycdn.com/tusupload/existing-guid",
        resourceExpiresAt: Date.parse("2026-09-23T06:00:00Z") / 1000,
        abandonAt: new Date("2026-09-24T00:00:00Z"),
      };
    } },
    provider: {
      async createVideo() { created = true; },
      createTusUploadAuthorization({ videoId, expiresAt }) {
        assert.equal(videoId, "existing-guid");
        assert.equal(expiresAt, Date.parse("2026-09-23T06:00:00Z") / 1000);
        return { endpoint: "tus", headers: { VideoId: videoId }, expiresAt };
      },
    },
    now: () => Date.parse("2026-09-23T00:00:00Z"),
  });

  const result = await application.refreshUploadAuthorization({
    productId: "507f191e810c19729de860ea", videoId: "507f1f77bcf86cd799439011",
  });

  assert.deepEqual(result, {
    productVideoId: "placement-a", position: 1, status: "awaiting_upload",
    upload: { endpoint: "tus", headers: { VideoId: "existing-guid" },
      uploadUrl: "https://video.bunnycdn.com/tusupload/existing-guid",
      resourceExpiresAt: Date.parse("2026-09-23T06:00:00Z") / 1000,
      expiresAt: Date.parse("2026-09-23T06:00:00Z") / 1000 },
  });
  assert.equal(created, false);
});

test("protected Product Video status hides provider identity and upload credentials", async () => {
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: { async listForProduct() {
      return [{
        id: "placement-a", position: 0, lifecycleState: "processing",
        showInReelsFeed: true, providerGuid: "private-guid", safeFilename: "demo.mp4",
        safeFailureCode: null,
      }];
    } },
    provider: {},
  });

  assert.deepEqual(await application.listAdminStatus({
    productId: "507f191e810c19729de860ea",
  }), [{
    productVideoId: "placement-a", position: 0, status: "processing",
    showInReelsFeed: true, failureCode: null,
  }]);
});

test("verified readiness advances only the Product Video that still owns the asset", async () => {
  const placement = {
    id: "placement-a", productId: "product-a", activeAssetId: "asset-a",
    pendingAssetId: null, lifecycleState: "processing", activeSlot: true,
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async findPlacementForAsset() { return { ...placement }; },
      async commitActiveReady({ placementId, assetId }) {
        assert.equal(placementId, "placement-a");
        assert.equal(assetId, "asset-a");
        placement.lifecycleState = "ready";
        return true;
      },
      async listForProduct() { return [{
        id: placement.id, position: 0, lifecycleState: placement.lifecycleState,
        showInReelsFeed: true,
      }]; },
    },
    provider: {},
  });

  assert.deepEqual(await application.handleVerifiedAsset({
    _id: "asset-a", ownerType: "product_video", ownerId: "placement-a",
    technicalState: "ready",
  }), { status: "ready" });
  assert.equal((await application.listAdminStatus({ productId: "product-a" }))[0].status, "ready");
});

test("provider reconciliation makes an owned Product Video ready before completing its operation", async () => {
  const placement = {
    id: "placement-a", productId: "product-a", activeAssetId: "asset-a",
    lifecycleState: "processing", activeSlot: true,
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async findPlacementForAsset() { return placement; },
      async commitActiveReady() { placement.lifecycleState = "ready"; return true; },
      async listForProduct() { return [{
        id: placement.id, position: 0, lifecycleState: placement.lifecycleState,
        showInReelsFeed: true,
      }]; },
    },
    provider: {},
  });
  const asset = {
    _id: "asset-a", ownerType: "product_video", ownerId: "placement-a",
    libraryId: "754739", providerGuid: "guid-a", technicalState: "processing",
  };
  const assetModel = {
    async findOneAndUpdate(_filter, update) {
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const observer = createVideoAssetObserver({
    model: assetModel,
    onApplied: (verified) => application.handleVerifiedAsset(verified),
  });
  const operation = { _id: "op-a", type: "reconcile", assetId: "asset-a",
    libraryId: "754739", providerGuid: "guid-a", leaseToken: "lease-a" };
  const runtime = createVideoProviderRuntime({
    provider: { async getVideo() { return { guid: "guid-a", status: 4,
      length: 30, width: 1080, height: 1920, availableResolutions: "720p" }; } },
    operations: {
      async claimById() { return operation; },
      async complete() {
        assert.equal(placement.lifecycleState, "ready");
        return operation;
      },
      async fail() { throw new Error("ready reconciliation must not fail"); },
    },
    assets: observer,
  });

  assert.deepEqual(await runtime.process(operation._id), { status: "completed" });
  assert.equal((await application.listAdminStatus({ productId: "product-a" }))[0].status, "ready");
});

test("terminal provider failure releases the Product Video instead of exposing failed media", async () => {
  const placement = {
    id: "placement-a", activeAssetId: "asset-a", pendingAssetId: null,
    lifecycleState: "processing", activeSlot: true,
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async findPlacementForAsset() { return { ...placement }; },
      async commitTerminalFailure({ placementId, assetId, failureCode }) {
        assert.equal(placementId, "placement-a");
        assert.equal(assetId, "asset-a");
        assert.equal(failureCode, "VIDEO_DURATION_EXCEEDED");
        placement.activeSlot = false;
        return true;
      },
      async listForProduct() {
        return placement.activeSlot ? [{ id: placement.id, position: 0,
          lifecycleState: placement.lifecycleState, showInReelsFeed: true }] : [];
      },
    },
    provider: {},
  });

  assert.deepEqual(await application.handleVerifiedAsset({
    _id: "asset-a", ownerType: "product_video", ownerId: "placement-a",
    technicalState: "failed", safeFailureCode: "VIDEO_DURATION_EXCEEDED",
  }), { status: "failed" });
  assert.deepEqual(await application.listAdminStatus({ productId: "product-a" }), []);
});

test("deletion request leaves the Product Video attached until provider acceptance", async () => {
  const placement = {
    id: "placement-a", lifecycleState: "ready", activeSlot: true,
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async requestDeletion({ productId, videoId }) {
        assert.equal(productId, "product-a");
        assert.equal(videoId, "placement-a");
        placement.lifecycleState = "deleting";
        return { id: placement.id, status: "deleting" };
      },
      async listForProduct() { return placement.activeSlot ? [{
        id: placement.id, position: 0, lifecycleState: placement.lifecycleState,
        showInReelsFeed: true,
      }] : []; },
    },
    provider: {},
  });

  assert.deepEqual(await application.requestDeletion({
    productId: "product-a", videoId: "placement-a",
  }), { productVideoId: "placement-a", status: "deleting" });
  assert.equal((await application.listAdminStatus({ productId: "product-a" }))[0].status, "deleting");
});

test("accepted Bunny deletion removes the Product Video before operation completion", async () => {
  const placement = {
    id: "placement-a", activeAssetId: "asset-a",
    lifecycleState: "deleting", activeSlot: true,
  };
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async findPlacementForAsset() { return { ...placement }; },
      async commitDeletionAccepted({ placementId, assetId }) {
        assert.equal(placementId, placement.id);
        assert.equal(assetId, "asset-a");
        placement.activeSlot = false;
        placement.lifecycleState = "removed";
        return true;
      },
      async listForProduct() { return placement.activeSlot ? [{
        id: placement.id, position: 0, lifecycleState: placement.lifecycleState,
        showInReelsFeed: true,
      }] : []; },
    },
    provider: {},
  });
  const asset = { _id: "asset-a", ownerType: "product_video", ownerId: "placement-a",
    libraryId: "754739", providerGuid: "guid-a", technicalState: "ready",
    deletionRequestedAt: new Date("2026-09-23T00:00:00Z") };
  const observer = createVideoAssetObserver({
    model: {
      async findOne() { return asset; },
      async findOneAndUpdate(_filter, update) {
        Object.assign(asset, update.$set);
        return asset;
      },
    },
    onDeleted: (deleted) => application.handleDeletedAsset(deleted),
  });
  const operation = { _id: "operation-a", type: "delete", assetId: "asset-a",
    libraryId: "754739", providerGuid: "guid-a", leaseToken: "lease-a" };
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { return { accepted: true, status: 204 }; },
      async getVideo() { throw { status: 404 }; } },
    operations: {
      async claimById() { return operation; },
      async complete() {
        assert.equal(placement.activeSlot, false);
        return operation;
      },
      async fail() { throw new Error("accepted delete must not retry"); },
    },
    assets: observer,
  });

  assert.deepEqual(await runtime.process(operation._id), { status: "completed" });
  assert.deepEqual(await application.listAdminStatus({ productId: "product-a" }), []);
});

test("cancelling an unfinished upload releases its product slot", async () => {
  let active = true;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async cancelPendingUpload({ productId, videoId }) {
        assert.equal(productId, "product-a");
        assert.equal(videoId, "placement-a");
        active = false;
        return { id: videoId, status: "cancelled" };
      },
      async listForProduct() { return active ? [{ id: "placement-a", position: 0,
        lifecycleState: "awaiting_upload", showInReelsFeed: true }] : []; },
    },
    provider: {},
  });

  assert.deepEqual(await application.cancelPendingUpload({
    productId: "product-a", videoId: "placement-a",
  }), { productVideoId: "placement-a", status: "cancelled" });
  assert.deepEqual(await application.listAdminStatus({ productId: "product-a" }), []);
});

test("an editor may change only the ready Product Video reels visibility", async () => {
  let saved = null;
  const application = createProductVideoService({ enqueue: async () => {}, invalidateCaches: async () => {},
    repository: {
      async setReelsVisibility(input) {
        saved = input;
        return { id: input.videoId, showInReelsFeed: input.showInReelsFeed };
      },
    },
    provider: {},
  });

  await assert.rejects(
    application.setReelsVisibility({ productId: "product-a", videoId: "placement-a", showInReelsFeed: "false" }),
    (error) => error.statusCode === 400 && error.errors?.[0]?.code === "VIDEO_INVALID_VISIBILITY",
  );
  assert.equal(saved, null);
  assert.deepEqual(await application.setReelsVisibility({
    productId: "product-a", videoId: "placement-a", showInReelsFeed: false,
  }), { productVideoId: "placement-a", showInReelsFeed: false });
  assert.deepEqual(saved, {
    productId: "product-a", videoId: "placement-a", showInReelsFeed: false,
  });
});
