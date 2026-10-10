import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createProductVideoPreviewService } from "../../../../src/domains/videos/productVideos/productVideoPreview.service.js";
import { createProductVideoPreviewRepository } from "../../../../src/domains/videos/productVideos/productVideoPreview.repository.js";
import { createProductVideoRouter } from "../../../../src/domains/videos/productVideos/productVideo.routes.js";
import { allowedTo, enabledControls as requireControls } from "../../../../src/domains/auth/auth.middleware.js";
import { enabledControls, roles } from "../../../../src/shared/constants/enums.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const productId = "507f191e810c19729de860ea";
const videoId = "507f191e810c19729de860eb";
const assetId = "507f191e810c19729de860ec";
const replacementId = "507f191e810c19729de860ed";
const actor = { id: "admin-1", role: roles.ADMIN, enabledControls: [enabledControls.PRODUCTS] };
const signed = { href: "https://cdn.example/signed/playlist.m3u8", expiresAt: 1_700_000_000 };
const candidate = { placement: { _id: videoId, productId, activeSlot: true,
  lifecycleState: "ready", activeAssetId: assetId },
asset: { _id: assetId, ownerType: "product_video", ownerId: videoId,
  libraryId: "754739", providerGuid: "private-guid", technicalState: "ready", providerStatus: 4,
  readyAt: new Date(), durationSeconds: 12, width: 1920, height: 1080, availableResolutions: ["720p"] },
replacement: null };
const pending = { ...candidate, placement: { ...candidate.placement,
  activeAssetId: "other-asset", pendingAssetId: assetId, replacementId },
replacement: { _id: replacementId, productId, videoId, assetId, status: "issued" } };

function fixture({ rows = candidate, grant = signed, onProbe } = {}) {
  let lookups = 0;
  let probes = 0;
  const app = createProductVideoPreviewService({
    repository: { async findCandidate(input) {
      assert.equal(input.productId, productId);
      assert.equal(input.videoId, videoId);
      lookups++;
      return structuredClone(typeof rows === "function" ? rows(lookups) : rows);
    } },
    provider: { async probeSignedHls(input) {
      probes++;
      assert.deepEqual(input, { videoId: "private-guid", expiresAt: signed.expiresAt });
      await onProbe?.();
      return grant;
    } }, now: () => 1_699_999_100_000,
  });
  return { app, lookups: () => lookups, probes: () => probes };
}

test("product editors receive only a short-lived preview grant after an HLS probe and fresh read", async () => {
  const { app, lookups, probes } = fixture();
  assert.deepEqual(await app.grant({ productId, videoId, actor }), {
    url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z",
  });
  assert.equal(lookups(), 2);
  assert.equal(probes(), 1);
  await app.grant({ productId, videoId, actor: { id: "super-1", role: roles.SUPER_ADMIN } });
});

test("preview denies users, moderators and admins without product control before DB/provider access", async () => {
  const { app, lookups, probes } = fixture();
  for (const forbidden of [null, { role: roles.SUPER_ADMIN },
    { id: "user", role: "user" }, { id: "moderator", role: "moderator" },
    { id: "admin", role: roles.ADMIN, enabledControls: [enabledControls.VIDEOS] }]) {
    await assert.rejects(app.grant({ productId, videoId, actor: forbidden }),
      (error) => error.statusCode === 403);
  }
  assert.equal(lookups(), 0);
  assert.equal(probes(), 0);
});

test("preview validates product/video IDs and the explicit active/pending selector", async () => {
  const { app, lookups } = fixture();
  for (const input of [{ productId: "invalid", videoId }, { productId, videoId: "invalid" },
    { productId, videoId, asset: "other" }, { productId, videoId, asset: ["active", "pending"] }]) {
    await assert.rejects(app.grant({ ...input, actor }), (error) => error.statusCode === 422);
  }
  assert.equal(lookups(), 0);
});

test("preview rejects missing, detached, wrong-owner, failed and invalid-metadata candidates", async () => {
  const invalid = [null,
    { ...candidate, placement: { ...candidate.placement, productId: "another-product" } },
    { ...candidate, placement: { ...candidate.placement, activeAssetId: "another-asset" } },
    { ...candidate, placement: { ...candidate.placement, activeSlot: false } },
    { ...candidate, placement: { ...candidate.placement, removedAt: new Date() } },
    ...[{ ownerType: "reel" }, { ownerId: "another-video" }, { technicalState: "processing" },
      { deleteAcceptedAt: new Date() }, { providerStatus: 2 }, { readyAt: new Date("invalid") },
      { durationSeconds: 91 }, { durationSeconds: 0 }, { width: 1.5 }, { height: 0 },
      { availableResolutions: [] }].map((change) => ({ ...candidate, asset: { ...candidate.asset, ...change } })),
  ];
  for (const rows of invalid) {
    const { app, probes } = fixture({ rows });
    await assert.rejects(app.grant({ productId, videoId, actor }), (error) => error.statusCode === 404);
    assert.equal(probes(), 0);
  }
});

test("pending deletion preserves active preview until provider acceptance", async () => {
  const { app } = fixture({ rows: { ...candidate,
    placement: { ...candidate.placement, lifecycleState: "deleting", deletionRequestedAt: new Date() },
    asset: { ...candidate.asset, deletionRequestedAt: new Date() } } });
  assert.equal((await app.grant({ productId, videoId, actor })).url, signed.href);
});

test("pending replacement preview requires the exact issued replacement and ready generation", async () => {
  const { app } = fixture({ rows: pending });
  assert.equal((await app.grant({ productId, videoId, actor, asset: "pending" })).url, signed.href);
  for (const rows of [{ ...pending, replacement: null },
    { ...pending, replacement: { ...pending.replacement, status: "cancelled" } },
    { ...pending, replacement: { ...pending.replacement, assetId: "wrong-asset" } },
    { ...pending, placement: { ...pending.placement, deletionRequestedAt: new Date() } },
    { ...pending, asset: { ...pending.asset, deletionRequestedAt: new Date() } }]) {
    const { app, probes } = fixture({ rows });
    await assert.rejects(app.grant({ productId, videoId, actor, asset: "pending" }),
      (error) => error.statusCode === 404);
    assert.equal(probes(), 0);
  }
});

test("missing signed HLS returns not-ready and never issues a preview response", async () => {
  const { app } = fixture({ grant: null });
  await assert.rejects(app.grant({ productId, videoId, actor }),
    (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_PREVIEW_NOT_READY");
});

test("deleted product, asset cutover and accepted deletion during probe block preview issuance", async () => {
  for (const changed of [null,
    { ...candidate, placement: { ...candidate.placement, activeAssetId: "new-asset" },
      asset: { ...candidate.asset, _id: "new-asset" } },
    { ...candidate, asset: { ...candidate.asset, deleteAcceptedAt: new Date() } }]) {
    const { app } = fixture({ rows: (n) => n === 1 ? candidate : changed });
    await assert.rejects(app.grant({ productId, videoId, actor }),
      (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_PREVIEW_CHANGED");
  }
});

test("pending cancellation or adoption during probe cannot grant an old pending preview", async () => {
  const { app } = fixture({ rows: (n) => n === 1 ? pending : candidate });
  await assert.rejects(app.grant({ productId, videoId, actor, asset: "pending" }),
    (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_PREVIEW_CHANGED");
});

test("preview rejects unbounded playback lifetimes at construction", () => {
  for (const ttl of [0, 59, 901, 1.5]) {
    assert.throws(() => createProductVideoPreviewService({
      repository: { findCandidate() {} }, provider: { probeSignedHls() {} }, playbackTtlSeconds: ttl,
    }), TypeError);
  }
});

test("preview repository binds product, placement, owner and configured library without active-product filtering", async () => {
  const calls = [];
  const repository = createProductVideoPreviewRepository({ libraryId: "754739",
    products: { async exists(filter) { calls.push(filter); return { _id: productId }; } },
    placements: { findOne(filter) { calls.push(filter); return { async lean() { return pending.placement; } }; } },
    assets: { findOne(filter) { calls.push(filter); return { async lean() { return candidate.asset; } }; } },
    replacements: { findOne(filter) { calls.push(filter); return { async lean() { return pending.replacement; } }; } },
  });
  assert.deepEqual(await repository.findCandidate({ productId, videoId, asset: "pending" }), pending);
  assert.deepEqual(calls, [{ _id: productId }, { _id: videoId, productId,
    activeSlot: true, removedAt: { $exists: false } },
  { _id: assetId, libraryId: "754739", ownerType: "product_video", ownerId: videoId },
  { _id: replacementId, productId, videoId, assetId, status: "issued" }]);
});

test("deleted products and malformed requests never query provider assets", async () => {
  const repository = createProductVideoPreviewRepository({ libraryId: "754739",
    products: { async exists() { return null; } },
    placements: { findOne() { assert.fail("product missing"); } },
    assets: { findOne() { assert.fail("product missing"); } },
  });
  assert.equal(await repository.findCandidate({ productId, videoId }), null);
  assert.equal(await repository.findCandidate({ productId, videoId: "invalid" }), null);
});

test("protected preview HTTP uses existing role/control middleware and works with upload/public flags off", async () => {
  const application = express();
  let identity;
  let grants = 0;
  application.use("/api/v1/products/:id/videos", createProductVideoRouter({
    access: [(req, res, next) => {
      if (!identity) return res.sendStatus(401);
      req.user = identity; next();
    }, allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControls(enabledControls.PRODUCTS)],
    isUploadEnabled: () => { assert.fail("previews must not check upload flag"); },
    getPreviewService: () => ({ async grant(input) {
      grants++;
      assert.equal(input.productId, productId);
      assert.equal(input.videoId, videoId);
      assert.equal(input.asset, "pending");
      assert.equal(input.actor.id, identity._id);
      return { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" };
    } }),
  }));
  application.use(globalError);
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/products/${productId}/videos/${videoId}/preview?asset=pending`;
    assert.equal((await fetch(url)).status, 401);
    for (const user of [{ _id: "user", role: "user" }, { _id: "moderator", role: "moderator" },
      { _id: "admin", role: roles.ADMIN, enabledControls: [enabledControls.VIDEOS] }]) {
      identity = user;
      assert.equal((await fetch(url)).status, 403);
    }
    assert.equal(grants, 0);
    for (const user of [{ _id: "admin", role: roles.ADMIN, enabledControls: [enabledControls.PRODUCTS] },
      { _id: "super", role: roles.SUPER_ADMIN }]) {
      identity = user;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), { data: { url: signed.href,
        expiresAt: "2023-11-14T22:13:20.000Z" } });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
