import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import express from "express";

import { createProductMediaService } from "../../../../src/domains/videos/public/productMedia.service.js";
import { createPublicProductVideoRepository } from "../../../../src/domains/videos/public/publicProductVideo.repository.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { ProductVideoModel } from "../../../../src/domains/videos/productVideos/productVideo.model.js";
import { CollectionModel } from "../../../../src/domains/collection/collection.model.js";
import { getProductByIdService, mapProductToCardDto } from "../../../../src/domains/product/product.service.js";
import productRoutes from "../../../../src/domains/product/product.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const productId = "507f1f77bcf86cd799439011";
const images = Object.freeze([
  Object.freeze({ public_id: "product/front", url: "https://images.example/front.webp", isMain: false }),
  Object.freeze({ public_id: "product/back", url: "https://images.example/back.webp", isMain: true }),
]);
const video = { _id: "507f1f77bcf86cd799439012", position: 7,
  showInReelsFeed: false, pendingAssetId: "private-pending-asset",
  asset: { providerGuid: "private-bunny-guid", libraryId: "754739",
    durationSeconds: 12, width: 1920, height: 1080 } };

function queryResult(value) {
  const query = { populate() { return query; }, select() { return query; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  return query;
}

function detailFixture(t, { active = true, rows = [video] } = {}) {
  const product = { _id: productId, slug: "ball", type: "SIMPLE", isActive: active,
    name_en: "Ball", name_ar: "كرة", desc_en: "Play", desc_ar: "العب",
    category: null, warehouseStocks: [], images, price: 100 };
  const previousFlag = process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED;
    else process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = previousFlag;
  });
  t.mock.method(ProductModel, "exists", async (filter) => {
    assert.deepEqual(filter, { _id: productId, isActive: true });
    return active ? { _id: productId } : null;
  });
  const detailLookup = t.mock.method(ProductModel, "findById", () => queryResult(product));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, "findOne", () => queryResult(null));
  const mediaLookup = t.mock.method(ProductVideoModel, "aggregate", async () => rows);
  return { product, detailLookup, mediaLookup };
}

test("product media preserves image order and appends only public video metadata", async () => {
  const application = createProductMediaService({ isEnabled: () => true,
    repository: { async listForProduct(id) { assert.equal(id, productId); return [video]; } } });
  const media = await application.project({ productId, images });
  assert.deepEqual(media.slice(0, 2), images.map((image, position) => ({
    ...image, id: `image:${image.public_id}`, type: "image", position,
  })));
  assert.deepEqual(media[2], { id: String(video._id), type: "video", position: 2,
    posterUrl: null, durationSeconds: 12, width: 1920, height: 1080,
    aspectRatio: 1920 / 1080, canSave: false,
    playbackHref: `/api/v1/product-videos/${video._id}/playback` });
  assert.equal(JSON.stringify(media).includes("private"), false);
  assert.equal(images.length, 2);
});

test("the gallery public flag hides videos without querying placements", async () => {
  let enabled = false;
  let queries = 0;
  const application = createProductMediaService({ isEnabled: () => enabled,
    repository: { async listForProduct() { queries += 1; return [video]; } } });
  assert.equal((await application.project({ productId, images })).length, 2);
  assert.equal(queries, 0);
  enabled = true;
  assert.equal((await application.project({ productId, images })).length, 3);
  enabled = false;
  assert.equal((await application.project({ productId, images })).length, 2);
  assert.equal(queries, 1);
});

test("product gallery exposes only the copied public poster URL, not its storage descriptor", async () => {
  const row = { ...video, asset: { ...video.asset, poster: {
    public_id: "internal-object-key", url: "https://images.example/poster.webp" } } };
  const app = createProductMediaService({ isEnabled: () => true,
    repository: { async listForProduct() { return [row]; } } });
  const media = await app.project({ productId, images });
  assert.equal(media[2].posterUrl, "https://images.example/poster.webp");
  assert.equal(JSON.stringify(media).includes("internal-object-key"), false);
  assert.equal(JSON.stringify(media).includes("private-bunny-guid"), false);
});

test("gallery reads ignore feed visibility and pending replacements, with selection ordering", async () => {
  let pipeline;
  const repository = createPublicProductVideoRepository({
    placements: { async aggregate(query) { pipeline = query; return [video]; } },
    products: { collection: { name: "products" } },
    assets: { collection: { name: "videoassets" } },
  });
  assert.deepEqual(await repository.listForProduct(productId), [video]);
  assert.equal(pipeline[0].$match.productId.toString(), productId);
  assert.deepEqual(pipeline[1].$match.lifecycleState.$in, ["ready", "deleting"]);
  assert.equal(pipeline[1].$match.showInReelsFeed, undefined);
  assert.equal(pipeline[5].$lookup.localField, "activeAssetId");
  assert.deepEqual(pipeline[7].$match["asset.deleteAcceptedAt"], { $exists: false });
  assert.equal(pipeline[7].$match["asset.deletionRequestedAt"], undefined);
  assert.deepEqual(pipeline.at(-1), { $sort: { position: 1, _id: 1 } });
  assert.deepEqual(await repository.listForProduct("invalid"), []);
});

test("product detail keeps legacy images and includes zero-stock gallery videos outside list DTOs", async (t) => {
  const { product } = detailFixture(t);
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "true";
  const result = await getProductByIdService(productId);
  assert.deepEqual(result.images, images);
  assert.equal(result.stock, 0);
  assert.equal(result.media[2].id, video._id);
  assert.equal("media" in mapProductToCardDto(product, { lang: "en" }), false);
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "false";
  const hidden = await getProductByIdService(productId);
  assert.deepEqual(hidden.images, result.images);
  assert.equal(hidden.media.length, images.length);
});

test("inactive or deleted products return public 404 before loading cached detail or video data", async (t) => {
  const { detailLookup, mediaLookup } = detailFixture(t, { active: false });
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "true";
  for (const actor of [null, { role: "user" }, { role: "admin", enabledControls: [] }]) {
    await assert.rejects(getProductByIdService(productId, "en", actor),
      (error) => error.statusCode === 404);
  }
  assert.equal(detailLookup.mock.callCount(), 0);
  assert.equal(mediaLookup.mock.callCount(), 0);
});

test("authorized product staff can still retrieve an inactive product", async (t) => {
  detailFixture(t, { active: false, rows: [] });
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "false";
  const result = await getProductByIdService(productId, "en", { role: "superAdmin" });
  assert.equal(result.isActive, false);
  assert.deepEqual(result.images, images);
});

test("product detail HTTP returns both legacy images and the derived media gallery", async (t) => {
  detailFixture(t);
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "true";
  const application = express();
  application.use("/api/v1/products", productRoutes);
  application.use(globalError);
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/products/${productId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const { data } = await response.json();
    assert.deepEqual(data.images, images);
    assert.deepEqual(data.media.map((item) => item.type), ["image", "image", "video"]);
    assert.equal(data.media[2].playbackHref, `/api/v1/product-videos/${video._id}/playback`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the upload-selection counter is persisted on Product rather than each variant", () => {
  assert.ok(ProductModel.schema.path("videoNextPosition"));
  assert.equal(ProductModel.schema.path("variants").schema.path("videoNextPosition"), undefined);
  const product = new ProductModel({ videoNextPosition: 3 });
  assert.equal(product.videoNextPosition, 3);
  assert.equal(new ProductModel().videoNextPosition, 0);
  assert.equal(mongoose.isValidObjectId(product._id), true);
});
