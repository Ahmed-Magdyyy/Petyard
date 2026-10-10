import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const assetId = "507f1f77bcf86cd799439013";
const batchId = "507f1f77bcf86cd799439014";

for (const action of ["visibility", "cancel", "deleteAccepted", "ready", "failed"]) {
  test(`${action} invalidates the injected Product cache only after persistence`, async () => {
    const initialState = action === "cancel" ? "awaiting_upload" : action === "deleteAccepted" ? "deleting"
      : ["ready", "failed"].includes(action) ? "processing" : "ready";
    const db = replacementDatabase({
      products: [{ _id: productId }],
      placements: [{ _id: videoId, productId, position: 0, activeSlot: true,
        lifecycleState: initialState, activeAssetId: assetId, uploadBatchId: batchId, safeFilename: "test.mp4" }],
      assets: [{ _id: assetId, ownerType: "product_video", ownerId: videoId,
        libraryId: "1", providerGuid: "guid", technicalState: action === "failed" ? "failed"
          : action === "cancel" ? "awaiting_upload" : "ready" }],
      batches: [{ _id: batchId, actorId: productId }],
    });
    const effects = [];
    const repository = createProductVideoRepository({ libraryId: "1", ...db,
      recordOperation: async () => ({ _id: "cleanup-id" }),
    });
    const service = createProductVideoService({ repository, provider: {},
      enqueue: async (id) => { effects.push(`queue:${id}`); throw new Error("Redis unavailable"); },
      invalidateCaches: async (id) => {
        assert.equal(String(id), productId);
        const row = await db.placements.findOne({ _id: videoId });
        assert.equal(row.lifecycleState, action === "visibility" || action === "ready" ? "ready"
          : action === "failed" ? "failed" : "removed");
        effects.push("cache");
      },
    });
    const asset = { _id: assetId, ownerType: "product_video", ownerId: videoId,
      technicalState: action === "failed" ? "failed" : "ready" };
    if (action === "visibility") assert.deepEqual(await service.setReelsVisibility({ productId, videoId, showInReelsFeed: false }),
      { productVideoId: videoId, showInReelsFeed: false });
    if (action === "cancel") assert.deepEqual(await service.cancelPendingUpload({ productId, videoId }),
      { productVideoId: videoId, status: "cancelled" });
    if (action === "deleteAccepted") assert.deepEqual(await service.handleDeletedAsset(asset), { status: "removed" });
    if (action === "ready" || action === "failed") assert.deepEqual(await service.handleVerifiedAsset(asset), { status: action });
    assert.deepEqual(effects, ["cancel", "failed"].includes(action) ? ["queue:cleanup-id", "cache"] : ["cache"]);
  });
}
