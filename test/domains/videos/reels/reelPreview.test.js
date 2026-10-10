import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createReelPreviewService } from "../../../../src/domains/videos/reels/reelPreview.service.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";

const reel = { _id: "reel-1", kind: "reel", status: "draft", activeAssetId: "asset-1" };
const asset = { _id: "asset-1", ownerType: "reel", ownerId: "reel-1",
  providerGuid: "bunny-guid", technicalState: "ready", providerStatus: 4,
  readyAt: new Date(),
  durationSeconds: 18, width: 720, height: 1280, availableResolutions: ["720p"] };
const session = { _id: "session-1", status: "issued", assetId: "asset-1" };
const signed = { href: "https://bunny.example/signed/playlist.m3u8", expiresAt: 1_700_000_000 };

function fixture({ candidate = { video: reel, asset, session }, grant = signed } = {}) {
  let lookups = 0;
  let probes = 0;
  const app = createReelPreviewService({
    repository: { async findCurrentForVideoId(id) {
      assert.equal(id, "reel-1");
      lookups += 1;
      return typeof candidate === "function" ? candidate(lookups) : candidate;
    } },
    provider: { async probeSignedHls({ videoId, expiresAt }) {
      probes += 1;
      assert.equal(videoId, "bunny-guid");
      assert.equal(expiresAt, 1_700_000_000);
      return grant;
    } },
    now: () => 1_699_999_100_000,
  });
  return { app, lookups: () => lookups, probes: () => probes };
}

test("staff receives only a short-lived signed Reel preview grant", async () => {
  const { app, lookups, probes } = fixture();
  assert.deepEqual(await app.grant({ id: "reel-1", actor: { id: "admin-1", role: "admin" } }),
    { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" });
  assert.equal(lookups(), 2);
  assert.equal(probes(), 1);
  assert.equal(await app.verifyReady(reel), true);
});

test("preview rejects unauthorized actors before querying or signing", async () => {
  const { app, lookups, probes } = fixture();
  for (const actor of [null, { id: "user-1", role: "user" }, { role: "admin" }]) {
    await assert.rejects(app.grant({ id: "reel-1", actor }),
      (error) => error.statusCode === 403);
  }
  assert.equal(lookups(), 0);
  assert.equal(probes(), 0);
});

test("preview rejects missing, stale, deleting, and unplayable assets", async () => {
  for (const candidate of [null, { video: reel, asset: { ...asset, technicalState: "failed" }, session },
    { video: reel, asset: { ...asset, deletionRequestedAt: new Date() }, session },
    { video: reel, asset: { ...asset, durationSeconds: 91 }, session }]) {
    const { app, probes } = fixture({ candidate });
    await assert.rejects(app.grant({ id: "reel-1",
      actor: { id: "super-1", role: "superAdmin" } }), (error) => error.statusCode === 404);
    assert.equal(probes(), 0);
  }
  const { app } = fixture({ grant: null });
  await assert.rejects(app.grant({ id: "reel-1", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_PREVIEW_NOT_READY");
});

test("preview does not return a URL after replacement during its CDN probe", async () => {
  const { app } = fixture({ candidate: (lookups) => lookups === 1
    ? { video: reel, asset, session }
    : { video: { ...reel, activeAssetId: "asset-2" },
      asset: { ...asset, _id: "asset-2" }, session: { ...session, _id: "session-2" } } });
  await assert.rejects(app.grant({ id: "reel-1", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_PREVIEW_CHANGED");
});

test("protected preview HTTP route returns no-store grant and denies requests without access", async () => {
  const serverApp = express();
  let allowed = false;
  serverApp.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, res, next) => {
      if (!allowed) return res.sendStatus(403);
      req.user = { _id: "admin-1", role: "admin" };
      next();
    }],
    getPreviewService: async () => ({ async grant({ id, actor }) {
      assert.equal(id, "reel-1");
      assert.equal(actor.role, "admin");
      return { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" };
    } }),
  }));
  serverApp.use(globalError);
  const server = serverApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/reel-1/preview`;
    assert.equal((await fetch(url)).status, 403);
    allowed = true;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: {
      url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z",
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("pending preview selects the replacement and refuses a cancellation during its signed probe", async () => {
  let lookups = 0;
  let cancelled = false;
  const app = createReelPreviewService({ repository: { async findCurrentForVideoId(id, selection) {
    assert.equal(selection, "pending"); assert.equal(id, "reel-1");
    return cancelled && ++lookups > 1 ? null : { video: reel, asset, session };
  } }, provider: { async probeSignedHls() { return signed; } } });
  assert.deepEqual(await app.grant({ id: "reel-1", asset: "pending", actor: { id: "admin-1", role: "admin" } }),
    { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" });
  cancelled = true;
  await assert.rejects(app.grant({ id: "reel-1", asset: "pending", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.errors[0].code === "VIDEO_PREVIEW_CHANGED");
  const current = fixture();
  await assert.rejects(current.app.grant({ id: "reel-1", asset: "other", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 422);
  assert.equal(current.lookups(), 0);
});

test("pending preview repository binds the current library, pending asset, actor and previous generation", async () => {
  const videoId = "507f1f77bcf86cd799439011";
  const pending = { authorId: "actor-1", uploadSessionId: "new-session", assetId: "new-asset", status: "draft" };
  let linked = true;
  const repository = createReelLifecycleRepository({ libraryId: "754739",
    videos: { async findOne() { return { _id: videoId, activeAssetId: "old-asset", pendingChange: pending }; } },
    assets: { async findOne(filter) { assert.equal(filter._id, "new-asset");
      assert.equal(filter.ownerId, videoId); assert.equal(filter.libraryId, "754739");
      assert.deepEqual(filter.deletionRequestedAt, { $exists: false }); return { ...asset, _id: "new-asset" }; } },
    sessions: { async findOne(filter) { assert.deepEqual(filter, { _id: "new-session", videoId,
      assetId: "new-asset", status: "issued", purpose: "replacement", actorId: "actor-1", previousAssetId: "old-asset" });
      return linked ? { ...session, _id: "new-session" } : null; } },
  });
  assert.equal((await repository.findCurrentForVideoId(videoId, "pending")).asset._id, "new-asset");
  linked = false;
  assert.equal(await repository.findCurrentForVideoId(videoId, "pending"), null);
});
