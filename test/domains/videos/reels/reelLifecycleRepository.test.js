import assert from "node:assert/strict";
import test from "node:test";

import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";

test("Reel preview repository requires the exact current ready asset and issued session", async () => {
  const calls = [];
  const reelId = "650000000000000000000001";
  const video = { _id: reelId, kind: "reel", activeAssetId: "asset-1",
    activeUploadSessionId: "session-1" };
  const asset = { _id: "asset-1", ownerType: "reel", ownerId: reelId,
    technicalState: "ready" };
  const session = { _id: "session-1", status: "issued", assetId: "asset-1" };
  const repository = createReelLifecycleRepository({
    videos: { async findOne(filter) { calls.push(["video", filter]); return video; } },
    assets: { async findOne(filter) { calls.push(["asset", filter]); return asset; } },
    sessions: { async findOne(filter) { calls.push(["session", filter]); return session; } },
  });
  assert.deepEqual(await repository.findCurrentForVideoId(reelId),
    { video, asset, session });
  assert.deepEqual(calls, [
    ["video", { _id: reelId, kind: "reel" }],
    ["asset", { _id: "asset-1", ownerType: "reel", ownerId: reelId,
      technicalState: "ready", deletionRequestedAt: { $exists: false } }],
    ["session", { _id: "session-1", videoId: reelId, assetId: "asset-1",
      status: "issued" }],
  ]);
  assert.equal(await repository.findCurrentForVideoId("not-an-object-id"), null);
});

test("Reel publication and recovery claims use owner, generation, and state CAS", async () => {
  const calls = [];
  const claimedAt = new Date("2026-09-28T12:00:00.000Z");
  const nextProbeAt = new Date("2026-09-28T12:05:00.000Z");
  const asset = { _id: "asset-1", ownerId: "reel-1" };
  const candidate = { _id: "reel-1", activeAssetId: "asset-1",
    activeUploadSessionId: "session-1" };
  const repository = createReelLifecycleRepository({
    videos: {
      async findOneAndUpdate(filter, update) {
        calls.push(["update", filter, update]);
        return { ...candidate, status: "draft" };
      },
      async updateOne(filter, update) { calls.push(["defer", filter, update]); },
      find(filter) {
        calls.push(["list", filter]);
        return { sort(order) { calls.push(["sort", order]); return this; },
          limit(count) { calls.push(["limit", count]); return this; },
          async lean() { return [candidate]; } };
      },
    },
    assets: { async findOne(filter) { calls.push(["asset", filter]); return asset; } },
  });
  await repository.publishIfCurrent({ asset, sessionId: "session-1", now: claimedAt });
  assert.deepEqual(calls[0], ["update", { _id: "reel-1", kind: "reel",
    activeAssetId: "asset-1", activeUploadSessionId: "session-1", status: "draft",
    autoPublishWhenReady: true, $or: [{ productIds: [] }, { productIds: { $exists: false } }] },
    { $set: { status: "published", publishedAt: claimedAt },
    $unset: { nextPreviewProbeAt: "" }, $inc: { revision: 1 } }]);
  await repository.deferPreviewProbe({ asset, sessionId: "session-1", nextProbeAt });
  assert.deepEqual(calls[1], ["defer", { _id: "reel-1", kind: "reel",
    status: "draft", autoPublishWhenReady: true, activeAssetId: "asset-1",
    activeUploadSessionId: "session-1" },
  { $set: { nextPreviewProbeAt: nextProbeAt } }]);
  assert.deepEqual(await repository.listDuePreviewProbes({ before: claimedAt, limit: 2 }),
    [candidate]);
  assert.deepEqual(calls[2][1].$or, [
    { nextPreviewProbeAt: { $exists: false } },
    { nextPreviewProbeAt: { $lte: claimedAt } },
  ]);
  assert.deepEqual(await repository.claimDuePreviewProbe({ candidate, claimedAt, nextProbeAt }), asset);
  const claim = calls.find(([name, filter]) => name === "update" && filter.$or?.[0].nextPreviewProbeAt);
  assert.equal(claim[1].activeAssetId, "asset-1");
  assert.equal(claim[1].activeUploadSessionId, "session-1");
  assert.deepEqual(claim[1].$or, [
    { nextPreviewProbeAt: { $exists: false } },
    { nextPreviewProbeAt: { $lte: claimedAt } },
  ]);
  assert.equal(claim[2].$set.nextPreviewProbeAt, nextProbeAt);
});
