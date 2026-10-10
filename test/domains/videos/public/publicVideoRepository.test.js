import assert from "node:assert/strict";
import test from "node:test";

import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";

const id = "507f1f77bcf86cd799439011";
const identity = { type: "guest", id: "guest-1" };

test("every public editorial read bulk-loads only attached active covers and verifies ownership", async () => {
  const active = "507f1f77bcf86cd799439021";
  const pending = "507f1f77bcf86cd799439022";
  const foreign = "507f1f77bcf86cd799439023";
  const rows = [{ _id: id, kind: "youtube", activeCoverId: active,
    pendingChange: { content: { coverId: pending } } },
    { _id: "507f1f77bcf86cd799439012", kind: "reel", activeCoverId: foreign },
    { _id: "507f1f77bcf86cd799439013", kind: "product", activeCoverId: pending }];
  let detail = false; let lookups = 0;
  const repository = createPublicVideoRepository({
    videos: { collection: { name: "videos" }, aggregate: async () => detail ? [rows[0]] : [{ count: [{ total: 3 }], rows }] },
    saves: { aggregate: async () => [{ count: [{ total: 3 }], rows }] },
    assets: { collection: { name: "assets" } }, sessions: { collection: { name: "sessions" } },
    placements: { collection: { name: "placements" } }, products: { collection: { name: "products" } },
    covers: { find(filter) {
      lookups++;
      assert.deepEqual(filter._id.$in, detail ? [active] : [active, foreign]);
      assert.equal(filter.state, "attached");
      assert.deepEqual(filter.uploadSettledAt, { $exists: true });
      assert.deepEqual(filter.deletionRequestedAt, { $exists: false });
      return { select() { return this; }, async lean() { return [
        { _id: active, videoId: id, descriptor: { url: "https://images.example/active.webp" } },
        { _id: foreign, videoId: "another-owner", descriptor: { url: "https://images.example/foreign.webp" } },
      ]; } };
    } },
  });
  for (const method of ["listYouTube", "listReels", "listMixed", "listSaved"]) {
    const result = await repository[method]({ page: 1, limit: 20, identity });
    assert.equal(result.data[0].cover.url, "https://images.example/active.webp");
    assert.equal(result.data[1].cover, null);
    assert.equal(result.data[2].cover, null);
    assert.equal(result.totalResults, 3);
  }
  detail = true;
  assert.equal((await repository.getPublished(id)).cover.url, "https://images.example/active.webp");
  assert.equal(lookups, 5);
});

test("public YouTube query filters publication before ordered pagination", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({
    videos: {
      aggregate: async (query) => {
        pipeline = query;
        return [{ count: [{ total: 3 }], rows: [{ _id: id, youtubeId: "dQw4w9WgXcQ" }] }];
      },
    },
  });
  const page = await repository.listYouTube({ page: 2, limit: 1 });
  assert.equal(page.totalResults, 3);
  assert.equal(page.data[0].id, id);
  assert.deepEqual(pipeline[0], { $match: { kind: "youtube", status: "published" } });
  assert.equal(pipeline[2].$facet.rows[0].$sort.sortRank, 1);
  assert.equal(pipeline[2].$facet.rows[1].$skip, 1);
});

test("Reel feed joins only current ready owned media before pagination", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({
    videos: { aggregate: async (query) => {
      pipeline = query;
      return [{ count: [{ total: 1 }], rows: [{ _id: id, kind: "reel",
        asset: { durationSeconds: 20, width: 720, height: 1280 } }] }];
    } },
    assets: { collection: { name: "videoassets" } },
    sessions: { collection: { name: "reeluploadsessions" } },
  });
  const page = await repository.listReels({ page: 2, limit: 1 });
  assert.equal(page.totalResults, 1);
  assert.equal(page.data[0].id, id);
  assert.deepEqual(pipeline[0], { $match: { kind: "reel", status: "published" } });
  assert.equal(pipeline[1].$lookup.from, "videoassets");
  assert.equal(pipeline[3].$lookup.from, "reeluploadsessions");
  assert.equal(pipeline[5].$match["asset.technicalState"], "ready");
  assert.equal(pipeline[5].$match["asset.deletionRequestedAt"].$exists, false);
  assert.deepEqual(pipeline[5].$match.$expr.$and, [
    { $eq: ["$asset.ownerId", "$_id"] },
    { $eq: ["$session.videoId", "$_id"] },
    { $eq: ["$session.assetId", "$asset._id"] },
  ]);
  assert.deepEqual(pipeline[6].$facet.rows[0], { $addFields: { sortRank: { $cond: [
    { $ne: [{ $ifNull: ["$position", null] }, null] }, 0, 1,
  ] } } });
  assert.deepEqual(pipeline[6].$facet.rows[1], {
    $sort: { sortRank: 1, position: 1, publishedAt: -1, _id: -1 },
  });
  assert.equal(pipeline[6].$facet.rows.at(-2).$skip, 1);
});

test("product feed requires active product, opted-in placement, and its current ready asset", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({
    placements: { aggregate: async (query) => {
      pipeline = query;
      return [{ count: [{ total: 1 }], rows: [{ _id: id, kind: "product",
        productId: "507f1f77bcf86cd799439012" }] }];
    } },
    products: { collection: { name: "products" } },
    assets: { collection: { name: "videoassets" } },
  });
  const result = await repository.listProducts({ page: 1, limit: 20 });
  assert.equal(result.totalResults, 1);
  assert.equal(result.data[0].id, id);
  assert.equal(pipeline[0].$match.showInReelsFeed, true);
  assert.equal(pipeline[1].$lookup.from, "products");
  assert.equal(pipeline[3].$match["product.isActive"], true);
  assert.equal(pipeline[4].$lookup.from, "videoassets");
  assert.deepEqual(pipeline[6].$match.$expr, { $eq: ["$asset.ownerId", "$_id"] });
  assert.equal(pipeline[7].$addFields.feedAt, "$asset.readyAt");
  assert.deepEqual(pipeline[8].$facet.rows[0].$sort,
    { feedAt: -1, _id: -1 });
});

test("all feed unions only enabled types before one newest-first pagination", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({
    videos: { aggregate: async (query) => { pipeline = query; return [{ count: [{ total: 0 }], rows: [] }]; } },
    placements: { collection: { name: "productvideos" } },
    products: { collection: { name: "products" } },
    assets: { collection: { name: "videoassets" } },
    sessions: { collection: { name: "reeluploadsessions" } },
  });
  await repository.listMixed({ page: 2, limit: 10, includeReels: true, includeProducts: true });
  assert.equal(pipeline[0].$match.kind, "reel");
  assert.equal(pipeline[7].$unionWith.coll, "productvideos");
  assert.equal(pipeline[7].$unionWith.pipeline[0].$match.showInReelsFeed, true);
  assert.deepEqual(pipeline[8].$facet.rows[0].$sort,
    { feedAt: -1, kind: 1, _id: -1 });
  assert.equal(pipeline[8].$facet.rows[1].$skip, 10);
  await repository.listMixed({ page: 1, limit: 10, includeReels: false, includeProducts: true });
  assert.deepEqual(pipeline[0], { $match: { _id: { $exists: false } } });
  assert.equal(pipeline[1].$unionWith.coll, "productvideos");
  await repository.listMixed({ page: 1, limit: 10, includeReels: true, includeProducts: false });
  assert.equal(pipeline.some((stage) => stage.$unionWith), false);
});

test("saved listing counts only published editorial Videos before pagination", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({
    videos: { collection: { name: "videos" } },
    saves: {
      aggregate: async (query) => {
        pipeline = query;
        return [{ count: [{ total: 1 }], rows: [{ _id: id }] }];
      },
    },
  });
  const page = await repository.listSaved({ identity, kind: "all", page: 1, limit: 20 });
  assert.equal(page.totalResults, 1);
  assert.equal(page.data[0].id, id);
  assert.deepEqual(pipeline[0].$match, { identityType: "guest", identityId: "guest-1" });
  assert.equal(pipeline[1].$lookup.from, "videos");
  assert.deepEqual(pipeline[3].$match, { "video.kind": { $in: ["youtube", "reel"] },
    "video.status": "published" });
  assert.equal(pipeline[6].$lookup.from, "videoassets");
  assert.equal(pipeline[10].$match.$or[1].kind, "reel");
  assert.deepEqual(pipeline[11].$facet.count, [{ $count: "total" }]);
  assert.deepEqual(pipeline[11].$facet.rows[0], { $sort: { _savedAt: -1, _saveId: -1 } });
});

test("public detail filters unavailable Reel media but allows published YouTube", async () => {
  let pipeline;
  const repository = createPublicVideoRepository({ videos: { aggregate: async (query) => {
    pipeline = query;
    return [];
  } } });
  assert.equal(await repository.getPublished(id), null);
  assert.equal(pipeline[0].$match.status, "published");
  assert.deepEqual(pipeline.at(-2).$match.$or[0], { kind: "youtube" });
  assert.equal(pipeline.at(-2).$match.$or[1]["session.status"], "issued");
  assert.equal(await repository.getPublished("bad-id"), null);
});

test("save and unsave target one typed identity and use an upsert", async () => {
  const calls = [];
  const db = replacementDatabase({ placements: [{ _id: id, kind: "youtube", status: "published", revision: 3 }] });
  const repository = createPublicVideoRepository({ videos: db.placements, connection: db.connection, saves: {
    ...db.saves,
    async updateOne(...args) { calls.push(["update", ...args]); return db.saves.updateOne(...args); },
    async deleteOne(...args) { calls.push(["delete", ...args]); return db.saves.deleteOne(...args); },
  } });
  assert.equal(await repository.save({ identity, videoId: id }), true);
  assert.equal(await repository.save({ identity, videoId: id }), true);
  assert.equal(calls.length, 1);
  assert.equal((await db.placements.findById(id)).revision, 3);
  await repository.unsave({ identity, videoId: id });
  assert.deepEqual(calls[0][1], { identityType: "guest", identityId: "guest-1", videoId: id });
  assert.equal(calls[0][3].upsert, true);
  assert.deepEqual(calls[1][1], { identityType: "guest", identityId: "guest-1", videoId: id });
});

test("a duplicate-key race is idempotent only when the identical save exists", async () => {
  let exists = true, reads = 0;
  const db = replacementDatabase({ placements: [{ _id: id, kind: "youtube", status: "published" }] });
  const repository = createPublicVideoRepository({ videos: db.placements, connection: db.connection, saves: {
    async updateOne() { throw Object.assign(new Error("duplicate"), { code: 11000 }); },
    findOne(filter) {
      assert.deepEqual(filter, { identityType: "guest", identityId: "guest-1", videoId: id });
      return { session() { return Promise.resolve(++reads % 2 === 0 && exists ? { videoId: id } : null); } };
    },
  } });
  assert.equal(await repository.save({ identity, videoId: id }), true);
  exists = false;
  await assert.rejects(repository.save({ identity, videoId: id }), /duplicate/);
  assert.equal(reads, 4);
});
