import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { VideoAssetModel } from "../../../../src/domains/videos/provider/videoAsset.model.js";
import { VideoProviderOperationModel } from "../../../../src/domains/videos/provider/videoProviderOperation.model.js";
import { VideoUploadAttemptModel } from "../../../../src/domains/videos/provider/videoUploadAttempt.model.js";

const id = () => new mongoose.Types.ObjectId();

function hasIndex(model, fields, expectedOptions) {
  return model.schema.indexes().some(([keys, options]) =>
    JSON.stringify(keys) === JSON.stringify(fields) &&
    Object.entries(expectedOptions).every(([key, value]) => options[key] === value),
  );
}

test("asset requires one typed owner and indexes provider identity uniquely", async () => {
  const asset = new VideoAssetModel({
    ownerType: "product_video",
    ownerId: id(),
    libraryId: "754739",
    providerGuid: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(await asset.validate(), undefined);
  assert.equal(asset.technicalState, "awaiting_upload");
  assert.equal(hasIndex(VideoAssetModel, { libraryId: 1, providerGuid: 1 }, { unique: true }), true);
  await assert.rejects(new VideoAssetModel({ libraryId: "754739", providerGuid: "guid" }).validate());
});

test("operation indexes enforce dedupe, one active target, and completed-only expiry", async () => {
  assert.equal(hasIndex(VideoProviderOperationModel, { dedupeKey: 1 }, { unique: true }), true);
  assert.equal(hasIndex(VideoProviderOperationModel, { activeTargetKey: 1 }, { unique: true, sparse: true }), true);
  assert.equal(hasIndex(VideoProviderOperationModel, { purgeAt: 1 }, { expireAfterSeconds: 0 }), true);
  const operation = new VideoProviderOperationModel({
    type: "reconcile", assetId: id(), libraryId: "754739",
    providerGuid: "guid", dedupeKey: "event-1", nextAttemptAt: new Date(),
  });
  assert.equal(await operation.validate(), undefined);
  assert.equal(operation.purgeAt, undefined);
  operation.lastErrorCode = "raw provider response: secret";
  await assert.rejects(operation.validate());
});

test("upload attempts expire after 30 days and reject unsafe paths", async () => {
  assert.equal(hasIndex(VideoUploadAttemptModel, { purgeAt: 1 }, { expireAfterSeconds: 0 }), true);
  const attempt = new VideoUploadAttemptModel({
    ownerType: "reel", ownerId: id(), actorId: id(),
    safeFilename: "clip.mp4", stage: "session", outcome: "started",
  });
  assert.equal(await attempt.validate(), undefined);
  const expected = Date.now() + 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(attempt.purgeAt.getTime() - expected) < 5000);
  attempt.safeFilename = "../secret.mp4";
  await assert.rejects(attempt.validate());
});
