import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { BrandModel } from "../../src/domains/brand/brand.model.js";
import {
  getBrandsService,
  updateBrandPositionsService,
} from "../../src/domains/brand/brand.service.js";

test("brand position defaults to zero and rejects non-integers", () => {
  const brand = new BrandModel({ slug: "royal-canin", name_en: "Royal Canin" });
  assert.equal(brand.position, 0);
  assert.equal(brand.validateSync(), undefined);

  brand.position = -1;
  assert.ok(brand.validateSync()?.errors.position);
  brand.position = 1.5;
  assert.ok(brand.validateSync()?.errors.position);
});

test("brand lists are ordered by position and expose fallback positions", async (t) => {
  const sort = t.mock.fn(async () => [
    { _id: new mongoose.Types.ObjectId(), slug: "first", name_en: "First", position: 0, updatedAt: new Date() },
    { _id: new mongoose.Types.ObjectId(), slug: "legacy", name_en: "Legacy", updatedAt: new Date() },
  ]);
  t.mock.method(BrandModel, "find", () => ({ sort }));

  const brands = await getBrandsService();
  await getBrandsService({ sort: "alphabet" });

  assert.deepEqual(sort.mock.calls[0].arguments, [{ position: 1, slug: 1 }]);
  assert.deepEqual(sort.mock.calls[1].arguments, [{ slug: 1 }]);
  assert.deepEqual(brands.map((brand) => brand.position), [0, 0]);
});

test("brand positions are persisted in bulk", async (t) => {
  const ids = [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()];
  t.mock.method(BrandModel, "bulkWrite", async (operations, options) => {
    assert.deepEqual(options, { ordered: false });
    assert.deepEqual(operations, ids.map((id, position) => ({
      updateOne: { filter: { _id: id }, update: { $set: { position } } },
    })));
    return { matchedCount: 2, modifiedCount: 2 };
  });

  const result = await updateBrandPositionsService(ids.map((id, position) => ({ id, position })));
  assert.deepEqual(result, { requested: 2, matched: 2, modified: 2 });
});
