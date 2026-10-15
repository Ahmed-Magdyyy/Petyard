import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import express from "express";
import jwt from "jsonwebtoken";

import { ProductModel } from "../../src/domains/product/product.model.js";
import { updateProductService } from "../../src/domains/product/product.service.js";
import { UserModel } from "../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import { RestockSubscriptionModel } from "../../src/domains/restockSubscription/restockSubscription.model.js";
import productRoutes from "../../src/domains/product/product.routes.js";
import { globalError } from "../../src/shared/middlewares/errorMiddleware.js";

const svgBuffer = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
);

const bunnyEnvironment = {
  BUNNY_PUBLIC_STORAGE_ZONE: "petyardpublicmedia",
  BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "public-access-key",
  BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PUBLIC_CDN_BASE_URL: "https://media.petyardstores.com",
  BUNNY_PRIVATE_STORAGE_ZONE: "petyardprivatepayments",
  BUNNY_PRIVATE_STORAGE_ACCESS_KEY: "private-access-key",
  BUNNY_PRIVATE_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PRIVATE_CDN_BASE_URL: "https://proofs.petyardstores.com",
};

function withBunnyEnvironment(run) {
  const values = {
    ...bunnyEnvironment,
    PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny",
    PRIVATE_MEDIA_STORAGE_PROVIDER: "bunny",
  };
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );

  Object.assign(process.env, values);
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function bunnyUrl(publicId) {
  return `https://media.petyardstores.com/${publicId}.svg`;
}

function image(publicId, isMain = false) {
  return {
    public_id: publicId,
    url: bunnyUrl(publicId),
    isMain,
  };
}

function file() {
  return {
    buffer: svgBuffer,
    mimetype: "image/svg+xml",
    size: svgBuffer.length,
  };
}

function productWithImages(images) {
  return {
    _id: "product-image-update-test",
    type: "SIMPLE",
    slug: "product-image-update-test",
    images,
    tags: [],
    variants: [],
    async save() {
      return this;
    },
  };
}

function mockProductImageDependencies(t, product) {
  const storageRequests = [];

  t.mock.method(ProductModel, "findById", () => product);
  t.mock.method(axios, "request", async (request) => {
    storageRequests.push(request);
    return { status: request.method === "PUT" ? 201 : 204 };
  });

  return { storageRequests };
}

function uploadedImageIds(images) {
  return images
    .map((entry) => entry.public_id)
    .filter((publicId) => publicId.includes("/product_product-image-update-test_"));
}

function deleteRequests(storageRequests) {
  return storageRequests.filter((request) => request.method === "DELETE");
}

test("merge image updates append uploaded files and preserve the old main image", async (t) => {
  const oldMain = image("petyard/products/test/old-main", true);
  const oldSecondary = image("petyard/products/test/old-secondary");
  const product = productWithImages([oldMain, oldSecondary]);
  const { storageRequests } = mockProductImageDependencies(t, product);

  const updated = await withBunnyEnvironment(() =>
    updateProductService(
      product._id,
      { removedImagePublicIds: "[]" },
      [file(), file()],
    ),
  );

  assert.equal(updated.images.length, 4);
  assert.deepEqual(updated.images.slice(0, 2), [oldMain, oldSecondary]);
  assert.equal(uploadedImageIds(updated.images).length, 2);
  assert.ok(
    updated.images.slice(2).every((entry) => entry.url.startsWith("https://media.petyardstores.com/petyard/products/product-image-update-test/")),
  );
  assert.deepEqual(
    updated.images.map((entry) => entry.isMain),
    [true, false, false, false],
  );
  assert.equal(storageRequests.filter((request) => request.method === "PUT").length, 2);
  assert.deepEqual(deleteRequests(storageRequests), []);
});

test("merge image updates remove selected images after saving and append new files", async (t) => {
  const oldMain = image("petyard/products/test/old-main", true);
  const oldSecondary = image("petyard/products/test/old-secondary");
  const product = productWithImages([oldMain, oldSecondary]);
  const { storageRequests } = mockProductImageDependencies(t, product);

  const updated = await withBunnyEnvironment(() =>
    updateProductService(
      product._id,
      { removedImagePublicIds: JSON.stringify([oldMain.public_id]) },
      [file()],
    ),
  );

  assert.equal(updated.images[0].public_id, oldSecondary.public_id);
  assert.equal(uploadedImageIds(updated.images).length, 1);
  assert.deepEqual(
    updated.images.map((entry) => entry.isMain),
    [false, true],
  );
  const deletes = deleteRequests(storageRequests);
  assert.equal(deletes.length, 1);
  assert.match(
    deletes[0].url,
    /petyardpublicmedia\/petyard\/products\/test\/old-main\.svg$/,
  );
});

test("legacy image updates still replace the gallery when merge field is omitted", async (t) => {
  const oldMain = image("petyard/products/test/old-main", true);
  const oldSecondary = image("petyard/products/test/old-secondary");
  const product = productWithImages([oldMain, oldSecondary]);
  const { storageRequests } = mockProductImageDependencies(t, product);

  const updated = await withBunnyEnvironment(() =>
    updateProductService(product._id, {}, [file()]),
  );

  assert.equal(updated.images.length, 1);
  assert.equal(uploadedImageIds(updated.images).length, 1);
  const deletes = deleteRequests(storageRequests);
  assert.equal(deletes.length, 2);
  assert.deepEqual(
    deletes.map((request) => request.url),
    [
      "https://storage.bunnycdn.com/petyardpublicmedia/petyard/products/test/old-main.svg",
      "https://storage.bunnycdn.com/petyardpublicmedia/petyard/products/test/old-secondary.svg",
    ],
  );
});

test("main-image-only merge edits use the final retained gallery without a new upload", async (t) => {
  const product = productWithImages([image("petyard/products/test/a", true), image("petyard/products/test/b")]);
  const { storageRequests } = mockProductImageDependencies(t, product);
  const updated = await withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [], mainImageIndex: 1 }));
  assert.deepEqual(updated.images.map((entry) => entry.isMain), [false, true]);
  assert.deepEqual(storageRequests, []);
});

test("mainImageIndex uses retained-existing-then-new order rather than the upload-only index", async (t) => {
  const product = productWithImages([image("petyard/products/test/a", true), image("petyard/products/test/b")]);
  mockProductImageDependencies(t, product);
  const updated = await withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: "[]", mainImageIndex: 1 }, [file()]));
  assert.equal(updated.images[1].public_id, "petyard/products/test/b");
  assert.deepEqual(updated.images.map((entry) => entry.isMain), [false, true, false]);
});

test("unrelated removal IDs and invalid final indexes are rejected before upload or save", async (t) => {
  const product = productWithImages([image("petyard/products/test/a", true)]);
  const { storageRequests } = mockProductImageDependencies(t, product);
  for (const body of [
    { removedImagePublicIds: ["petyard/products/someone-else/image"] },
    { removedImagePublicIds: [""] },
    { removedImagePublicIds: [], mainImageIndex: 4 },
    { removedImagePublicIds: [], mainImageIndex: -1 },
    { removedImagePublicIds: [], mainImageIndex: 0.5 },
  ]) await assert.rejects(withBunnyEnvironment(() => updateProductService(product._id, body, [file()])),
    (error) => error.statusCode === 400);
  assert.deepEqual(storageRequests, []);
});

test("the ten-image bound counts retained images and rejects eleven before uploading", async (t) => {
  const product = productWithImages(Array.from({ length: 10 }, (_, i) => image(`petyard/products/test/image-${i}`, i === 0)));
  const { storageRequests } = mockProductImageDependencies(t, product);
  await assert.rejects(withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [] }, [file()])), (error) => error.statusCode === 400);
  assert.deepEqual(storageRequests, []);
  const removed = product.images[4].public_id;
  const updated = await withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [removed], mainImageIndex: 9 }, [file()]));
  assert.equal(updated.images.length, 10);
  assert.equal(updated.images.some((entry) => entry.public_id === removed), false);
  assert.equal(updated.images[9].isMain, true);
});

test("variant indexes use the final gallery; omitted selections survive and null clears them", async (t) => {
  const a = image("petyard/products/test/a", true), b = image("petyard/products/test/b");
  const product = productWithImages([a, b]); product.type = "VARIANT";
  product.options = [{ name: "size", values: ["small"] }];
  const variant = { _id: "68cf1234567890abcdef1234", sku: "small", price: 12,
    options: [{ name: "size", value: "small" }], warehouseStocks: [], isDefault: true };
  product.variants = [{ ...variant, images: [a] }];
  mockProductImageDependencies(t, product);
  t.mock.method(WarehouseModel, "find", () => ({ select() { return this; }, sort() { return this; }, lean: async () => [{ _id: "68cf1234567890abcdef1235" }] }));
  await withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [], variants: [{ ...variant, imageIndex: 2 }] }, [file()]));
  assert.deepEqual(product.variants[0].images, [product.images[2]]);
  assert.equal(product.variants[0]._id, variant._id);
  await withBunnyEnvironment(() => updateProductService(product._id, { variants: [variant] }));
  assert.deepEqual(product.variants[0].images, [product.images[2]]);
  await withBunnyEnvironment(() => updateProductService(product._id, { variants: [{ ...variant, imageIndex: null }] }));
  assert.equal(product.variants[0].images?.length ?? 0, 0);
  await assert.rejects(withBunnyEnvironment(() => updateProductService(product._id,
    { variants: [{ ...variant, imageIndex: 99 }] }, [file()])), (error) => error.statusCode === 400);
});

test("removing a variant-assigned gallery image clears that reference instead of keeping a deleted URL", async (t) => {
  const a = image("petyard/products/test/a", true), b = image("petyard/products/test/b");
  const product = productWithImages([a, b]); product.type = "VARIANT";
  product.variants = [{ _id: "68cf1234567890abcdef1234", images: [b], options: [], warehouseStocks: [] }];
  mockProductImageDependencies(t, product);
  const updated = await withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [b.public_id] }));
  assert.deepEqual(updated.variants[0].images, []);
});

test("partial provider failures keep the old gallery and only clean newly uploaded media", async (t) => {
  const old = image("petyard/products/test/old", true);
  const product = productWithImages([old]);
  mockProductImageDependencies(t, product);
  let saves = 0; const requests = [];
  product.save = async () => { saves++; return product; };
  t.mock.method(axios, "request", async (request) => {
    requests.push(request);
    if (request.method === "PUT" && request.url.includes("_1_")) throw new Error("simulated provider unavailable");
    return { status: request.method === "PUT" ? 201 : 204 };
  });
  await assert.rejects(withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [] }, [file(), file()])), (error) => error.statusCode >= 500);
  assert.equal(saves, 0); assert.deepEqual(product.images, [old]);
  assert.equal(deleteRequests(requests).length, 1);
  assert.ok(!deleteRequests(requests)[0].url.endsWith("/test/old.svg"));
});

test("lost database-save acknowledgement does not delete media already referenced by the committed product", async (t) => {
  const product = productWithImages([image("petyard/products/test/old", true)]);
  const { storageRequests } = mockProductImageDependencies(t, product);
  let persisted;
  t.mock.method(ProductModel, "findById", () => persisted ?? product);
  product.save = async () => { persisted = { images: product.images.map((image) => ({ ...image })) }; throw new Error("save acknowledgement lost"); };
  await assert.rejects(withBunnyEnvironment(() => updateProductService(product._id,
    { removedImagePublicIds: [] }, [file()])), /save acknowledgement lost/);
  assert.equal(persisted.images.length, 2);
  assert.deepEqual(deleteRequests(storageRequests), []);
});

test("real JSON and multipart routes normalize removal arrays and preserve final main-image selections", async (t) => {
  const product = productWithImages([image("petyard/products/test/a", true), image("petyard/products/test/b")]);
  product._id = "68cf1234567890abcdef1234";
  mockProductImageDependencies(t, product);
  const beforeSecret = process.env.JWT_ACCESS_SECRET, beforeMode = process.env.NODE_ENV;
  process.env.JWT_ACCESS_SECRET = "product-image-http-test-key"; process.env.NODE_ENV = "production";
  t.after(() => {
    if (beforeSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = beforeSecret;
    if (beforeMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = beforeMode;
  });
  const userId = "68cf1234567890abcdef1235";
  t.mock.method(UserModel, "findById", async () => ({ _id: userId, role: "superAdmin", active: true, phoneVerified: true, account_status: "active" }));
  t.mock.method(RestockSubscriptionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(RestockSubscriptionModel, "find", () => ({ sort() { return this; }, lean: async () => [] }));
  const app = express(); app.use(express.json()); app.use("/api/v1/products", productRoutes); app.use(globalError);
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/products/${product._id}`;
  const authorization = `Bearer ${jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" })}`;
  try {
    const json = await fetch(url, { method: "PATCH", headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ removedImagePublicIds: [], mainImageIndex: 1 }) });
    assert.equal(json.status, 200); assert.equal((await json.json()).data.images[1].isMain, true);
    const form = new FormData(); form.append("removedImagePublicIds", "[]"); form.append("mainImageIndex", "2");
    form.append("images", new Blob([svgBuffer], { type: "image/svg+xml" }), "new.svg");
    const upload = await withBunnyEnvironment(() => fetch(url, { method: "PATCH", headers: { Authorization: authorization }, body: form }));
    assert.equal(upload.status, 200);
    const gallery = (await upload.json()).data.images;
    assert.equal(gallery.length, 3); assert.equal(gallery[2].isMain, true); assert.ok(gallery[2].url.endsWith(".webp"));
    const remove = new FormData(); remove.append("removedImagePublicIds[0]", gallery[1].public_id); remove.append("mainImageIndex", "1");
    const deletion = await withBunnyEnvironment(() => fetch(url, { method: "PATCH", headers: { Authorization: authorization }, body: remove }));
    assert.equal(deletion.status, 200); assert.equal((await deletion.json()).data.images.length, 2);
    const later = new FormData(); later.append("removedImagePublicIds", "[]");
    later.append("images", new Blob([svgBuffer], { type: "image/svg+xml" }), "later.svg");
    const addition = await withBunnyEnvironment(() => fetch(url, { method: "PATCH", headers: { Authorization: authorization }, body: later }));
    assert.equal(addition.status, 200);
    const laterGallery = (await addition.json()).data.images;
    assert.equal(laterGallery.length, 3);
    assert.deepEqual(laterGallery.slice(0, 2).map((entry) => entry.public_id), [gallery[0].public_id, gallery[2].public_id]);
    assert.equal(new Set(laterGallery.map((entry) => entry.public_id)).size, 3);
    const bad = await fetch(url, { method: "PATCH", headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ removedImagePublicIds: [], mainImageIndex: 99 }) });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error[0].path, "mainImageIndex");
    const oversized = new FormData(); oversized.append("desc_en", "a".repeat(16 * 1024 + 1));
    const tooLarge = await fetch(url, { method: "PATCH", headers: { Authorization: authorization }, body: oversized });
    assert.equal(tooLarge.status, 400);
    const tooMany = new FormData(); for (let i = 0; i < 1001; i++) tooMany.append(`tag${i}`, "x");
    const overParts = await fetch(url, { method: "PATCH", headers: { Authorization: authorization }, body: tooMany });
    assert.equal(overParts.status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
