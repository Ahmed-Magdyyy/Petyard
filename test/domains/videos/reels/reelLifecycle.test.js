import assert from "node:assert/strict";
import test from "node:test";

import { createReelLifecycle } from "../../../../src/domains/videos/reels/reelLifecycle.service.js";
import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createVideoAssetAppliedHandler } from "../../../../src/domains/videos/provider/videoAssetAppliedHandler.js";

const asset = { _id: "asset-1", ownerType: "reel", ownerId: "reel-1",
  technicalState: "ready", providerStatus: 4,
  readyAt: new Date("2026-09-28T12:00:00.000Z"),
  durationSeconds: 12, width: 720, height: 1280, availableResolutions: ["720p"] };

function fixture({ role = "super", previewReady = true } = {}) {
  const state = { video: { _id: "reel-1", kind: "reel", status: "draft",
    activeAssetId: "asset-1", activeUploadSessionId: "session-1",
    autoPublishWhenReady: role === "super", revision: 0 },
  session: { _id: "session-1", videoId: "reel-1", assetId: "asset-1", status: "issued" },
  publishedCalls: 0, previewCalls: 0 };
  const videos = {
    async findOne(filter) {
      return String(filter._id) === state.video._id && filter.kind === state.video.kind &&
        String(filter.activeAssetId) === state.video.activeAssetId &&
        String(filter.activeUploadSessionId) === state.video.activeUploadSessionId
        ? { ...state.video } : null;
    },
    async findOneAndUpdate(filter, update) {
      state.publishedCalls += 1;
      if (String(filter._id) !== state.video._id ||
          String(filter.activeAssetId) !== state.video.activeAssetId ||
          String(filter.activeUploadSessionId) !== state.video.activeUploadSessionId ||
          filter.status !== state.video.status ||
          filter.autoPublishWhenReady !== state.video.autoPublishWhenReady) return null;
      state.video = { ...state.video, ...update.$set,
        revision: state.video.revision + update.$inc.revision };
      return { ...state.video };
    },
  };
  const sessions = { async findOne(filter) {
    return String(filter.videoId) === state.session.videoId &&
      String(filter.assetId) === state.session.assetId && filter.status === state.session.status
      ? { ...state.session } : null;
  } };
  const lifecycle = createReelLifecycle({ repository: createReelLifecycleRepository({ videos, sessions }),
    verifyPreviewReady: async () => { state.previewCalls += 1; return previewReady; },
    now: () => new Date("2026-09-28T12:01:00.000Z") });
  return { lifecycle, state };
}

test("super-admin Reel publishes once after issued-session, ready-asset, and preview checks", async () => {
  const { lifecycle, state } = fixture();
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "published" });
  assert.equal(state.video.status, "published");
  assert.equal(state.video.publishedAt.toISOString(), "2026-09-28T12:01:00.000Z");
  assert.equal(state.video.revision, 1);
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "already_published" });
  assert.equal(state.publishedCalls, 1);
  assert.equal(state.previewCalls, 1);
});

test("admin Reel remains draft for review even when its asset is ready", async () => {
  const { lifecycle, state } = fixture({ role: "admin" });
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "awaiting_review" });
  assert.equal(state.video.status, "draft");
  assert.equal(state.previewCalls, 0);
});

test("unwired preview gate never auto-publishes a Reel", async () => {
  const { state } = fixture();
  const lifecycle = createReelLifecycle({ repository: {
    async findCurrentForAsset() { return { video: state.video, session: state.session }; },
    async publishIfCurrent() { throw new Error("must remain gated"); },
  } });
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "preview_pending" });
});

test("stale, unissued, failed, and deleting assets cannot auto-publish", async () => {
  const { lifecycle, state } = fixture();
  state.session.status = "failed";
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "stale" });
  state.session.status = "issued";
  state.video.activeAssetId = "other-asset";
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "stale" });
  state.video.activeAssetId = "asset-1";
  for (const invalid of [{ ...asset, technicalState: "failed" },
    { ...asset, providerStatus: 2 },
    { ...asset, deletionRequestedAt: new Date() },
    { ...asset, durationSeconds: 91 },
    { ...asset, availableResolutions: [] }]) {
    assert.deepEqual(await lifecycle.handleVerifiedAsset(invalid), { status: "not_ready" });
  }
  assert.equal(state.publishedCalls, 0);
});

test("asset dispatcher keeps Product Video and Reel owners separate", async () => {
  const calls = [];
  const handle = createVideoAssetAppliedHandler({
    productVideos: { handleVerifiedAsset(value) { calls.push(["product", value.ownerType]); } },
    reelVideos: { handleVerifiedAsset(value) { calls.push(["reel", value.ownerType]); } },
  });
  await handle({ ownerType: "product_video" });
  await handle({ ownerType: "reel" });
  assert.deepEqual(handle({ ownerType: "unknown" }), { status: "ignored" });
  assert.deepEqual(calls, [["product", "product_video"], ["reel", "reel"]]);
});

test("preview-pending super-admin Reel is claimed and retried by the sweep", async () => {
  const candidate = { _id: "reel-1", activeAssetId: "asset-1", activeUploadSessionId: "session-1" };
  const calls = [];
  const lifecycle = createReelLifecycle({ repository: {
    async listDuePreviewProbes({ before, limit }) {
      assert.equal(limit, 2);
      assert.ok(before instanceof Date);
      return [candidate];
    },
    async claimDuePreviewProbe({ candidate: received, claimedAt, nextProbeAt }) {
      assert.equal(received, candidate);
      assert.equal(nextProbeAt.getTime() - claimedAt.getTime(), 5 * 60_000);
      calls.push("claimed");
      return asset;
    },
    async findCurrentForAsset() {
      return { video: { kind: "reel", status: "draft", autoPublishWhenReady: true },
        session: { _id: "session-1" } };
    },
    async publishIfCurrent() { calls.push("published"); return { status: "published" }; },
  }, verifyPreviewReady: async () => { calls.push("probed"); return true; },
  now: () => new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(await lifecycle.recoverPreviewPending({ limit: 2 }),
    { examined: 1, attempted: 1, published: 1, applied: 0 });
  assert.deepEqual(calls, ["claimed", "probed", "published"]);
});
