import assert from "node:assert/strict";
import test from "node:test";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { RestockSubscriptionModel } from "../../../src/domains/restockSubscription/restockSubscription.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { getProducts, getProductsForAdmin } from "../../../src/domains/product/product.controller.js";

const warehouse = "507f1f77bcf86cd799439011";
const ids = [1, 2, 3, 4, 5].map((value) => value.toString(16).padStart(24, "0"));
const products = [
  [0, 1, 0, "2026-11-11"], [1, 20, 4, "2026-11-10"],
  [2, 10, 2, "2026-11-09"], [3, 5, 0, "2026-11-08"], [4, 15, 1, "2026-11-07"],
].map(([index, price, quantity, date]) => ({
  _id: ids[index], slug: `product-${index}`, type: "SIMPLE", isActive: true,
  name_en: String.fromCharCode(65 + index), name_ar: `منتج ${index}`, price,
  createdAt: new Date(date), images: [], variants: [],
  warehouseStocks: [{ warehouse, quantity }],
}));

function queryResult(value) {
  let sortFields;
  let skip = 0;
  let limit;
  const query = {
    populate() { return query; }, select() { return query; }, lean() { return query; },
    sort(fields) { sortFields = fields; return query; },
    skip(count) { skip = count; return query; },
    limit(count) { limit = count; return query; },
    then(resolve, reject) {
      let rows = value;
      if (Array.isArray(value)) {
        rows = [...value];
        if (sortFields) rows.sort((first, second) => {
          for (const [field, direction] of Object.entries(sortFields)) {
            if (first[field] < second[field]) return -direction;
            if (first[field] > second[field]) return direction;
          }
          return 0;
        });
        rows = rows.slice(skip, limit === undefined ? undefined : skip + limit);
      }
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return query;
}

function fixture(t) {
  // This database fixture models the public list's availability partitions.
  const matching = (filter) => {
    const serialized = JSON.stringify(filter);
    if (serialized.includes('"$nor"')) return products.filter((row) => row.warehouseStocks[0].quantity === 0);
    if (serialized.includes('"$gt":0')) return products.filter((row) => row.warehouseStocks[0].quantity > 0);
    return products;
  };
  t.mock.method(ProductModel, "find", (filter) => queryResult(matching(filter)));
  t.mock.method(ProductModel, "countDocuments", async (filter) => matching(filter).length);
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CollectionModel, "find", () => queryResult([]));
  t.mock.method(SubcategoryModel, "find", () => queryResult([]));
  t.mock.method(FavoriteModel, "findOne", () => queryResult(null));
  t.mock.method(RestockSubscriptionModel, "find", () => queryResult([]));
  t.mock.method(OrderModel, "aggregate", async () => []);
}

async function readList(controller, query, user) {
  let result;
  const res = {
    status(code) { assert.equal(code, 200); return res; },
    json(body) { result = body; return res; },
  };
  await controller({ query, lang: "en", headers: {}, user }, res, (error) => { throw error; });
  return result;
}

test("customer stock priority beats each requested sort across pagination", async (t) => {
  fixture(t);
  for (const [sort, expected] of [
    [{}, [1, 2, 4, 0, 3]],
    [{ sortKey: "price_asc" }, [2, 4, 1, 0, 3]],
    [{ sortKey: "price_desc" }, [1, 4, 2, 3, 0]],
    [{ sortKey: "date_asc" }, [4, 2, 1, 3, 0]],
    [{ sortKey: "date_desc" }, [1, 2, 4, 0, 3]],
    [{ sortKey: "alpha_asc" }, [1, 2, 4, 0, 3]],
    [{ sortKey: "alpha_desc" }, [4, 2, 1, 3, 0]],
    [{ sortKey: "featured" }, [1, 2, 4, 0, 3]],
    [{ sortKey: "best_seller" }, [1, 2, 4, 0, 3]],
    [{ sort: "-price" }, [1, 4, 2, 3, 0]],
    [{ sort: "createdAt" }, [4, 2, 1, 3, 0]],
  ]) {
    const combined = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await readList(getProducts, { ...sort, page: String(page), limit: "2" });
      assert.equal(result.totalResults, 5);
      assert.equal(result.totalPages, 3);
      combined.push(...result.data);
    }
    assert.deepEqual(combined.map((row) => row.id), expected.map((index) => ids[index]), JSON.stringify(sort));
    assert.deepEqual(combined.map((row) => row.inStock), [true, true, true, false, false]);
  }
});

test("admin list keeps the requested sort without stock prioritization", async (t) => {
  fixture(t);
  const result = await readList(getProductsForAdmin, { sortKey: "price_asc", limit: "5" },
    { _id: warehouse, role: "superAdmin" });
  assert.deepEqual(result.data.map((row) => row.id), [ids[0], ids[3], ids[2], ids[4], ids[1]]);
  assert.deepEqual(result.data.map((row) => row.inStock), [false, false, true, true, true]);
});
