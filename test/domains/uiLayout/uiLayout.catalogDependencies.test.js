import test from "node:test";
import assert from "node:assert/strict";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { getProductsService } from "../../../src/domains/product/product.service.js";
import { getSubcategoriesService } from "../../../src/domains/subcategory/subcategory.service.js";

const parent = "68cf1234567890abcdef1240", child = "68cf1234567890abcdef1241";
const category = "68cf1234567890abcdef1242", brand = "68cf1234567890abcdef1243";
function queryResult(value, inspect = {}) {
  const query = { populate() { return query; }, select() { return query; }, sort() { return query; },
    skip(value) { inspect.skip?.(value); return query; }, limit(value) { inspect.limit?.(value); return query; },
    lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  return query;
}

test("the existing subcategory picker returns a complete nested tree, not a paginated product list", async (t) => {
  const rows = [{ _id: parent, category, parent: null, name_en: "Food", name_ar: "طعام" },
    { _id: child, category, parent, name_en: "Treats", name_ar: "مكافآت" }];
  t.mock.method(SubcategoryModel, "find", (filter) => { assert.deepEqual(filter, { category }); return queryResult(rows); });
  const result = await getSubcategoriesService({ category }, "ar", { role: "superAdmin" });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, parent);
  assert.equal(result[0].children[0].id, child);
  assert.equal(result[0].children[0].name, "مكافآت");
  assert.equal(result[0].children[0].name_en, "Treats");
  const branch = await getSubcategoriesService({ category, subcategory: parent }, "en", { role: "superAdmin" });
  assert.deepEqual(branch.map((item) => item.id), [child]);
});

test("the existing product picker combines category/brand/subcategory filters and keeps pagination", async (t) => {
  t.mock.method(SubcategoryModel, "find", (filter) => queryResult(
    filter.parent === parent ? [{ _id: child }] : []));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, "find", () => queryResult([]));
  const inspect = (filter) => {
    assert.equal(filter.category, category);
    assert.equal(filter.brand, brand);
    assert.equal(filter.isActive, true);
    assert.deepEqual(filter.subcategory, { $in: [parent, child] });
  };
  t.mock.method(ProductModel, "countDocuments", async (filter) => { inspect(filter); return 42; });
  t.mock.method(ProductModel, "find", (filter) => {
    inspect(filter); return queryResult([], { skip: (value) => assert.equal(value, 20), limit: (value) => assert.equal(value, 20) });
  });
  const result = await getProductsService({ category, brand, subcategory: parent, page: "2", limit: "20", isActive: "true" },
    "en", { includeZeroStockInWarehouse: true, includeDetails: true, includeAllLanguages: true });
  assert.equal(result.page, 2);
  assert.equal(result.totalResults, 42);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.data, []);
});
