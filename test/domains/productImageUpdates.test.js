import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

import { ProductModel } from "../../src/domains/product/product.model.js";
import { updateProductService } from "../../src/domains/product/product.service.js";

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
