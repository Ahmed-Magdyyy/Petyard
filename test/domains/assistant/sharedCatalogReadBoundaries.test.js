import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CategoryModel } from "../../../src/domains/category/category.model.js";
import { BrandModel } from "../../../src/domains/brand/brand.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { buildInStockFilter } from "../../../src/domains/product/product.service.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { mockSharedCatalogReadBoundaries } from "./fixtures/sharedCatalogReadBoundaries.js";

function fixture(t) {
  const manifest = createSharedMongoManifest("catalogRead"), calls = [], target = { valid: true };
  for (const Model of [ProductModel, CategoryModel, BrandModel, SubcategoryModel]) {
    for (const method of ["find", "findOne"]) t.mock.method(Model.collection, method, (filter, options) => {
      calls.push({ name: Model.collection.name, filter, options }); return { async toArray() { return []; } };
    });
  }
  const reads = mockSharedCatalogReadBoundaries(t, manifest, () => assert.ok(target.valid, "target changed"));
  return { manifest, calls, reads, target };
}

test("read boundary preserves real Mongoose casting, stock filter, projection, sort and cursor while appending exact scope", async (t) => {
  const { manifest, calls } = fixture(t), warehouse = manifest.records.warehouses[0];
  await ProductModel.find({ $and: [{ isActive: true }, buildInStockFilter(warehouse)] })
    .select("_id name_en warehouseStocks").sort({ _id: 1 }).limit(20).maxTimeMS(5000).lean();
  assert.equal(calls.length, 1);
  const { filter, options } = calls[0], scope = filter.$and[1];
  assert.equal(scope.assistantTestRun, manifest.marker); assert.deepEqual(scope._id.$in.map(String), manifest.records.products);
  const stock = filter.$and[0].$and[1].$or[0].warehouseStocks.$elemMatch;
  assert.ok(stock.warehouse instanceof mongoose.Types.ObjectId); assert.equal(String(stock.warehouse), warehouse);
  assert.equal(options.limit, 20); assert.deepEqual(options.sort, { _id: 1 }); assert.equal(options.projection.name_en, 1);
});

test("population IDs, brand search and ancestry reads remain bounded even if caller mutates its manifest", async (t) => {
  const { manifest, calls } = fixture(t), original = [...manifest.records.categories];
  manifest.records.categories.push(String(new mongoose.Types.ObjectId()));
  CategoryModel.collection.find({ _id: { $in: [original[0]] } });
  assert.deepEqual(calls[0].filter.$and[1]._id.$in.map(String), original);
  await BrandModel.find({ name_en: { $regex: "Native", $options: "i" } }).select("_id").limit(20).lean();
  await SubcategoryModel.find({}, { _id: 1, parent: 1 }).lean();
  assert.deepEqual(calls[2].filter.$and[0], {}); assert.equal(calls[2].options.maxTimeMS, 5000);
  assert.throws(() => CategoryModel.collection.find({ _id: manifest.records.categories.at(-1) }), /Foreign/);
  assert.throws(() => CategoryModel.collection.find({ _id: { $in: [original[0], new mongoose.Types.ObjectId()] } }), /Foreign/);
});

test("read boundary refuses all writes, DDL, unrelated models, unbounded product reads and changed targets", async (t) => {
  const { target, calls } = fixture(t);
  for (const call of [() => ProductModel.collection.insertOne({}), () => ProductModel.collection.updateMany({}, {}),
    () => ProductModel.collection.deleteMany({}), () => ProductModel.collection.aggregate([]),
    () => ProductModel.createCollection(), () => ProductModel.syncIndexes(), () => FavoriteModel.collection.findOne({}),
    () => ProductModel.collection.find({}, { limit: 21, sort: { _id: 1 }, maxTimeMS: 5000 }),
    () => ProductModel.collection.find({}, { limit: 20, sort: { price: 1 }, maxTimeMS: 5000 }),
    () => ProductModel.collection.find({}, { limit: 20, sort: { _id: 1 }, maxTimeMS: 5000, projection: { desc_en: 1 } })]) assert.throws(call);
  target.valid = false; assert.throws(() => CategoryModel.collection.find({}), /target changed/); assert.equal(calls.length, 0);
});
