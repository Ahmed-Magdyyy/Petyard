import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createPublicProductVideoRepository } from "../../../../src/domains/videos/public/publicProductVideo.repository.js";
import { createPublicProductPlaybackService } from "../../../../src/domains/videos/public/publicProductPlayback.service.js";
import { createPublicProductPlaybackRouter } from "../../../../src/domains/videos/public/publicProductPlayback.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const placementId = "507f1f77bcf86cd799439011";
const productId = "507f1f77bcf86cd799439012";
const placement = { _id: placementId, productId, activeSlot: true,
  lifecycleState: "ready", activeAssetId: "asset-1", showInReelsFeed: false,
  product: { _id: productId, isActive: true },
  asset: { _id: "asset-1", ownerId: placementId, ownerType: "product_video",
    technicalState: "ready", providerStatus: 4, providerGuid: "bunny-guid" } };
const signed = { href: "https://bunny.example/signed/playlist.m3u8",
  expiresAt: 1_700_000_000 };

function fixture({ enabled = true, candidate = placement } = {}) {
  let lookups = 0;
  let signs = 0;
  const app = createPublicProductPlaybackService({
    repository: { async getPlayable(id) {
      assert.equal(id, placementId);
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

test("product playback remains available when feed visibility is off", async () => {
  const { app, lookups, signs } = fixture();
  assert.deepEqual(await app.grant({ id: placementId }),
    { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" });
  assert.equal(lookups(), 2);
  assert.equal(signs(), 1);
});

test("product playback hides disabled, inactive, stale, and removed placements", async () => {
  const disabled = fixture({ enabled: false });
  await assert.rejects(disabled.app.grant({ id: placementId }),
    (error) => error.statusCode === 404);
  assert.equal(disabled.lookups(), 0);
  for (const candidate of [null,
    { ...placement, product: { ...placement.product, isActive: false } },
    { ...placement, activeSlot: false },
    { ...placement, lifecycleState: "removed" },
    { ...placement, activeAssetId: "asset-2" },
    { ...placement, asset: { ...placement.asset, technicalState: "failed" } },
    { ...placement, asset: { ...placement.asset, deleteAcceptedAt: new Date() } },
  ]) {
    const { app, signs } = fixture({ candidate });
    await assert.rejects(app.grant({ id: placementId }),
      (error) => error.statusCode === 404);
    assert.equal(signs(), 0);
  }
});

test("a pending or rejected delete keeps playback until Bunny accepts deletion", async () => {
  const requestedAt = new Date();
  const pending = { ...placement, lifecycleState: "deleting", deletionRequestedAt: requestedAt,
    asset: { ...placement.asset, deletionRequestedAt: requestedAt } };
  const { app } = fixture({ candidate: pending });
  assert.equal((await app.grant({ id: placementId })).url, signed.href);
  const { app: accepted } = fixture({ candidate: (lookups) => lookups === 1 ? pending
    : { ...pending, asset: { ...pending.asset, deleteAcceptedAt: new Date() } } });
  await assert.rejects(accepted.grant({ id: placementId }), (error) => error.statusCode === 404);
});

test("product playback rechecks replacement and product visibility after signing", async () => {
  for (const changed of [
    { ...placement, product: { ...placement.product, isActive: false } },
    { ...placement, activeAssetId: "asset-2", asset: { ...placement.asset, _id: "asset-2" } },
  ]) {
    const { app } = fixture({ candidate: (lookups) => lookups === 1 ? placement : changed });
    await assert.rejects(app.grant({ id: placementId }),
      (error) => error.statusCode === 404);
  }
});

test("product playback repository joins its live product and active asset", async () => {
  let pipeline;
  const repository = createPublicProductVideoRepository({
    placements: { aggregate: async (query) => { pipeline = query; return []; } },
    products: { collection: { name: "products" } },
    assets: { collection: { name: "videoassets" } },
  });
  assert.equal(await repository.getPlayable(placementId), null);
  assert.equal(pipeline[0].$match._id.toString(), placementId);
  assert.equal(pipeline[1].$match.showInReelsFeed, undefined);
  assert.equal(pipeline[4].$match["product.isActive"], true);
  assert.equal(pipeline[7].$match["asset.technicalState"], "ready");
  assert.equal(await repository.getPlayable("invalid"), null);
});

test("public product playback uses optionalProtect and returns private, no-store grants", async () => {
  let calls = 0;
  const serverApp = express();
  serverApp.use("/api/v1/product-videos", createPublicProductPlaybackRouter({
    getService: async () => ({ async grant({ id }) {
      calls += 1;
      assert.equal(id, placementId);
      return { url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z" };
    } }),
  }));
  serverApp.use(globalError);
  const server = serverApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` +
      `/api/v1/product-videos/${placementId}/playback`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: {
      url: signed.href, expiresAt: "2023-11-14T22:13:20.000Z",
    } });
    const rejected = await fetch(`http://127.0.0.1:${server.address().port}` +
      `/api/v1/product-videos/${placementId}/playback`, {
        headers: { authorization: "Bearer invalid-token" },
      });
    assert.equal(rejected.status, 401);
    assert.equal(calls, 1, "authentication must reject before the service runs");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
