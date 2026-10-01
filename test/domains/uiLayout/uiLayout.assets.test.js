import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createUiBuilderAsset, listUiBuilderAssets } from "../../../src/domains/uiLayout/uiLayout.assets.js";
import { decodePageCursor } from "../../../src/domains/uiLayout/uiLayout.pagination.js";

const ACTOR = "507f1f77bcf86cd799439011";
const ASSET_ID = "b8e793a5-dcde-49a5-b207-e79cc24b6a88";

test("uploads only verified raster images through the existing media path", async () => {
  const buffer = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: "#ffffff" } }).png().toBuffer();
  let uploadCalls = 0;
  const result = await createUiBuilderAsset({
    file: { buffer, mimetype: "image/png", size: buffer.length }, usage: "promo",
    actorId: ACTOR, uuid: () => ASSET_ID,
    upload: async (_file, options) => {
      uploadCalls += 1;
      assert.equal(options.folder, "petyard/ui-builder");
      return { public_id: "petyard/ui-builder/test", url: "https://cdn.petyardstores.com/test.webp" };
    },
    assetModel: { create: async (value) => ({ ...value, createdAt: new Date("2026-09-24T00:00:00Z") }) },
  });
  assert.equal(uploadCalls, 1);
  assert.deepEqual(result, {
    id: ASSET_ID, status: "ready", usage: "promo",
    url: "https://cdn.petyardstores.com/test.webp", width: 4, height: 3,
    byte_size: buffer.length, created_at: "2026-09-24T00:00:00.000Z",
  });
});

test("rejects MIME spoofing and SVG before upload", async () => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3,
    background: "#ffffff" } }).png().toBuffer();
  let uploaded = false;
  await assert.rejects(createUiBuilderAsset({
    file: { buffer, mimetype: "image/svg+xml", size: buffer.length },
    usage: "promo", actorId: ACTOR, upload: async () => { uploaded = true; },
  }), (error) => error.code === "UI_ASSET_INVALID_FILE");
  assert.equal(uploaded, false);
});

test("rejects and cleans up a non-public provider URL without registering an asset", async () => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3,
    background: "#ffffff" } }).png().toBuffer();
  let removed = false;
  let registered = false;
  await assert.rejects(createUiBuilderAsset({
    file: { buffer, mimetype: "image/png", size: buffer.length }, usage: "promo",
    actorId: ACTOR,
    upload: async () => ({ public_id: "petyard/ui-builder/test", url: "http://127.0.0.1/private" }),
    remove: async () => { removed = true; },
    assetModel: { create: async () => { registered = true; } },
  }), (error) => error.code === "UI_ASSET_STORAGE_INVALID");
  assert.equal(removed, true);
  assert.equal(registered, false);
});

test("asset library pages through same-timestamp images without losing older assets", async () => {
  const createdAt = new Date("2026-09-24T00:00:00.123Z");
  const assets = [1, 2, 3].map((number) => ({
    _id: number.toString(16).padStart(24, "0"), id: `asset-${number}`,
    status: "ready", usage: "promo", url: `https://cdn.petyardstores.com/${number}.webp`,
    width: 100, height: 100, byteSize: 1000, createdAt,
  }));
  const assetModel = { find(filter) {
    let rows = assets.filter((asset) => asset.status === filter.status);
    if (filter.$or) {
      const boundary = filter.$or[1]._id.$lt;
      rows = rows.filter((asset) => asset._id < boundary);
    }
    return { sort() { return { limit(value) {
      return rows.sort((a, b) => b._id.localeCompare(a._id)).slice(0, value);
    } }; } };
  } };
  const first = await listUiBuilderAssets({ limit: 1, assetModel });
  const second = await listUiBuilderAssets({ limit: 1,
    before: decodePageCursor(first.next_before), assetModel });
  const third = await listUiBuilderAssets({ limit: 1,
    before: decodePageCursor(second.next_before), assetModel });
  assert.deepEqual([first.items[0].id, second.items[0].id, third.items[0].id],
    ["asset-3", "asset-2", "asset-1"]);
  assert.deepEqual(first.items[0], {
    id: "asset-3", status: "ready", usage: "promo",
    url: "https://cdn.petyardstores.com/3.webp", width: 100, height: 100,
    byte_size: 1000, created_at: "2026-09-24T00:00:00.123Z",
  });
  assert.equal(third.next_before, null);
});
