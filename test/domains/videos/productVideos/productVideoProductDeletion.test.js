import assert from "node:assert/strict";
import test from "node:test";

import { deleteProductWithVideoCleanup } from "../../../../src/domains/videos/productVideos/productVideoProductDeletion.service.js";

test("deleting a product persists every attached Bunny cleanup in the product transaction", async () => {
  const calls = [];
  const session = {
    async withTransaction(work) {
      calls.push("transaction:start");
      await work();
      calls.push("transaction:committed");
    },
    async endSession() { calls.push("session:ended"); },
  };
  const rows = [
    { _id: "placement-a", activeAssetId: "asset-a" },
    { _id: "placement-b", activeAssetId: "asset-b", pendingAssetId: "asset-c" },
  ];
  const assetById = new Map([
    ["asset-a", { _id: "asset-a", ownerId: "placement-a", ownerType: "product_video", libraryId: "754739", providerGuid: "guid-a", technicalState: "ready" }],
    ["asset-b", { _id: "asset-b", ownerId: "placement-b", ownerType: "product_video", libraryId: "754739", providerGuid: "guid-b", technicalState: "ready" }],
    ["asset-c", { _id: "asset-c", ownerId: "placement-b", ownerType: "product_video", libraryId: "754739", providerGuid: "guid-c", technicalState: "processing" }],
  ]);
  const fakeModels = {
    connection: { async startSession() { return session; } },
    products: { async findOneAndDelete(filter, options) {
      assert.deepEqual(filter, { _id: "product-a" });
      assert.equal(options.session, session);
      calls.push("product:delete");
      return { _id: "product-a" };
    } },
    placements: {
      async exists() { return { _id: "placement-a" }; },
      find(filter) {
        assert.deepEqual(filter, { productId: "product-a", activeSlot: true });
        return { session(value) {
          assert.equal(value, session);
          return { async lean() { return rows; } };
        } };
      },
      async updateMany(filter, update, options) {
        assert.deepEqual(filter, { productId: "product-a", activeSlot: true });
        assert.equal(update.$set.activeSlot, false);
        assert.equal(update.$set.lifecycleState, "removed");
        assert.equal(options.session, session);
        calls.push("placements:tombstone");
      },
    },
    assets: {
      findOne(filter) {
        return { session(value) {
          assert.equal(value, session);
          const asset = assetById.get(String(filter._id));
          assert.equal(asset?.ownerId, String(filter.ownerId));
          return asset;
        } };
      },
      async updateOne(filter, update, options) {
        assert.equal(options.session, session);
        assert.equal(update.$set.technicalState, "deleting");
        assert.ok(update.$set.deletionRequestedAt instanceof Date);
        calls.push(`asset:${filter._id}:delete-intent`);
      },
    },
    async recordOperation(input) {
      assert.equal(input.session, session);
      assert.equal(input.type, "delete");
      calls.push(`operation:${input.assetId}`);
      return { _id: `operation-${input.assetId}` };
    },
    async enqueue(id) {
      assert.ok(calls.includes("transaction:committed"));
      calls.push(`enqueue:${id}`);
    },
    now: () => 1_000,
  };

  await deleteProductWithVideoCleanup({ productId: "product-a", ...fakeModels });
  assert.deepEqual(calls, [
    "transaction:start", "product:delete",
    "asset:asset-a:delete-intent", "operation:asset-a",
    "asset:asset-b:delete-intent", "operation:asset-b",
    "asset:asset-c:delete-intent", "operation:asset-c",
    "placements:tombstone", "transaction:committed", "session:ended",
    "enqueue:operation-asset-a", "enqueue:operation-asset-b", "enqueue:operation-asset-c",
  ]);
});

test("image-only product deletion needs no Bunny configuration or queue operation", async () => {
  let deleted = false;
  let enqueueCount = 0;
  await deleteProductWithVideoCleanup({
    productId: "product-with-images-only",
    isUploadEnabled: () => false,
    connection: { async startSession() { throw new Error("image-only deletion must not start a transaction"); } },
    products: { async deleteOne(filter) {
      assert.deepEqual(filter, { _id: "product-with-images-only" });
      deleted = true;
      return { deletedCount: 1 };
    } },
    placements: {
      async exists(filter) {
        assert.deepEqual(filter, { productId: "product-with-images-only" });
        return null;
      },
      find() { throw new Error("no video placements expected"); },
    },
    assets: { findOne() { throw new Error("no video assets expected"); } },
    recordOperation() { throw new Error("no provider operation expected"); },
    async enqueue() { enqueueCount += 1; },
  });
  assert.equal(deleted, true);
  assert.equal(enqueueCount, 0);
});
