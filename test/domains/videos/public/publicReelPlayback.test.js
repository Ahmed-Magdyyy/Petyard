import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createPublicReelPlaybackService } from "../../../../src/domains/videos/public/publicReelPlayback.service.js";
import { createPublicVideoRouter } from "../../../../src/domains/videos/public/publicVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const video = { _id: "reel-1", kind: "reel", status: "published",
  activeAssetId: "asset-1", activeUploadSessionId: "session-1" };
const asset = { _id: "asset-1", ownerType: "reel", ownerId: "reel-1",
  providerGuid: "bunny-guid", technicalState: "ready", providerStatus: 4,
  readyAt: new Date(), durationSeconds: 18, width: 720, height: 1280,
  availableResolutions: ["720p"] };
const session = { _id: "session-1", status: "issued", assetId: "asset-1" };
const current = { video, asset, session };
const signed = { href: "https://bunny.example/signed/playlist.m3u8",
  expiresAt: 1_700_000_000 };

function fixture({ enabled = true, candidate = current } = {}) {
  let lookups = 0;
  let signs = 0;
  const app = createPublicReelPlaybackService({
    repository: { async findCurrentForVideoId(id) {
      assert.equal(id, "reel-1");
      lookups += 1;
      return typeof candidate === "function" ? candidate(lookups) : candidate;
    } },
    provider: { createSignedHlsUrl({ videoId, expiresAt }) {
      signs += 1;
      assert.equal(videoId, "bunny-guid");
      assert.equal(expiresAt, 1_700_000_000);
      return signed;
    } },
    isEnabled: () => enabled,
    now: () => 1_699_999_100_000,
  });
  return { app, lookups: () => lookups, signs: () => signs };
}

test("public Reel playback returns only a short-lived grant and rechecks current media", async () => {
  const { app, lookups, signs } = fixture();
  assert.deepEqual(await app.grant({ id: "reel-1" }),
    { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" });
  assert.equal(lookups(), 2);
  assert.equal(signs(), 1);
});

test("disabled, unpublished, missing, stale, and deleting Reels never get a grant", async () => {
  const disabled = fixture({ enabled: false });
  await assert.rejects(disabled.app.grant({ id: "reel-1" }),
    (error) => error.statusCode === 404);
  assert.equal(disabled.lookups(), 0);
  for (const candidate of [null, { ...current, video: { ...video, status: "unpublished" } },
    { ...current, video: { ...video, activeAssetId: "asset-2" } },
    { ...current, video: { ...video, activeUploadSessionId: "session-2" } },
    { ...current, asset: { ...asset, technicalState: "failed" } },
    { ...current, asset: { ...asset, deletionRequestedAt: new Date() } },
    { ...current, asset: { ...asset, durationSeconds: 91 } }]) {
    const { app, signs } = fixture({ candidate });
    await assert.rejects(app.grant({ id: "reel-1" }),
      (error) => error.statusCode === 404);
    assert.equal(signs(), 0);
  }
});

test("public grant rejects an unpublish or asset switch while signing", async () => {
  for (const changed of [
    { ...current, video: { ...video, status: "unpublished" } },
    { ...current, video: { ...video, activeAssetId: "asset-2" },
      asset: { ...asset, _id: "asset-2" } },
    { ...current, video: { ...video, activeUploadSessionId: "session-2" },
      session: { ...session, _id: "session-2" } },
  ]) {
    const { app } = fixture({ candidate: (lookups) => lookups === 1 ? current : changed });
    await assert.rejects(app.grant({ id: "reel-1" }),
      (error) => error.statusCode === 404);
  }
});

test("public playback HTTP route is no-store and does not require a save identity", async () => {
  const serverApp = express();
  serverApp.use("/api/v1/videos", createPublicVideoRouter({
    optionalAccess: (_req, _res, next) => next(),
    getPlaybackService: async () => ({ async grant({ id }) {
      assert.equal(id, "reel-1");
      return { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" };
    } }),
  }));
  serverApp.use(globalError);
  const server = serverApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` +
      "/api/v1/videos/reel-1/playback");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: {
      url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z",
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
