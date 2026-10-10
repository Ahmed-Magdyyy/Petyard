import assert from "node:assert/strict";
import test from "node:test";

import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";

test("protected Product Video status exposes a safe rejected-delete code", async () => {
  const repository = createProductVideoRepository({
    libraryId: "754739",
    placements: { find() { return { sort() { return { async lean() {
      return [{ _id: "placement-a", position: 0, activeAssetId: "asset-a",
        lifecycleState: "deleting", showInReelsFeed: true }];
    } }; } }; } },
    assets: { find() { return { select() { return { async lean() {
      return [{ _id: "asset-a", safeFailureCode: null }];
    } }; } }; } },
    operations: { find() { return { sort() { return { select() { return { async lean() {
      return [{ assetId: "asset-a", lastErrorCode: "BUNNY_STREAM_REJECTED" }];
    } }; } }; } }; } },
  });

  assert.deepEqual(await repository.listForProduct({ productId: "product-a" }), [{
    id: "placement-a", position: 0, lifecycleState: "deleting",
    showInReelsFeed: true, safeFailureCode: "BUNNY_STREAM_REJECTED",
  }]);
});
