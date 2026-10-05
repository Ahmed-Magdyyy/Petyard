import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { RestockSubscriptionModel } from "../../../src/domains/restockSubscription/restockSubscription.model.js";
import { ProductVideoModel } from "../../../src/domains/videos/productVideos/productVideo.model.js";
import { getProductsBatchService } from "../../../src/domains/product/productBatch.service.js";
import { parseProductBatchBody } from "../../../src/domains/product/productBatch.contract.js";
import { mapProductToDetailDto } from "../../../src/domains/product/product.service.js";
import productRoutes from "../../../src/domains/product/product.routes.js";
import { i18nMiddleware } from "../../../src/shared/middlewares/i18nMiddleware.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { productBatchLimiter } from "../../../src/domains/product/product.limiters.js";
import { productBatchBodyParser } from "../../../src/domains/product/productBatch.middleware.js";

const A = "68cf1234567890abcdef1234", B = "68cf1234567890abcdef1235", C = "68cf1234567890abcdef1236";
const W = "507f1f77bcf86cd799439011";
function queryResult(value) {
  const query = { populate() { return query; }, select() { return query; }, lean() { return query; },
    maxTimeMS(value) { assert.equal(value, 10000); return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
  return query;
}
function product(id, overrides = {}) {
  return { _id: id, slug: `product-${id}`, type: "SIMPLE", isActive: true,
    name_en: "Ball", name_ar: "كرة", desc_en: "Play", desc_ar: "العب", price: 100,
    images: [{ public_id: `product/${id}`, url: `https://images.example/${id}.webp`, isMain: true }],
    warehouseStocks: [{ warehouse: W, quantity: 7, revision: 4 }],
    variants: [], ratingAverage: 4.5, ratingCount: 12, ...overrides };
}
function fixture(t, products = [product(A), product(B)]) {
  const flag = process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED;
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "false";
  t.after(() => {
    if (flag === undefined) delete process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED;
    else process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = flag;
  });
  const filters = [];
  t.mock.method(ProductModel, "find", (filter) => {
    filters.push(filter);
    return queryResult(products.filter((row) => filter._id.$in.includes(row._id) &&
      (filter.isActive === undefined || row.isActive === filter.isActive)));
  });
  t.mock.method(ProductModel, "findById", () => assert.fail("Batch must not fetch product detail per ID"));
  t.mock.method(CollectionModel, "find", () => queryResult([]));
  t.mock.method(CollectionModel, "updateMany", () => assert.fail("Batch must not mutate promotions"));
  t.mock.method(SubcategoryModel, "find", () => queryResult([]));
  t.mock.method(FavoriteModel, "findOne", () => queryResult(null));
  t.mock.method(RestockSubscriptionModel, "find", () => queryResult([]));
  t.mock.method(WarehouseModel, "findById", async (_id) => ({ _id, active: true }));
  t.mock.method(ProductVideoModel, "aggregate", () => assert.fail("Disabled media must not query videos"));
  return { filters, products };
}

test("batch validates/deduplicates IDs, loads two products in one set query, and reports partial availability", async (t) => {
  const { filters, products } = fixture(t);
  const result = await getProductsBatchService([B, A.toUpperCase(), B, C], { lang: "ar" });
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0], { _id: { $in: [B, A, C] }, isActive: true });
  assert.deepEqual(result.unavailable_product_ids, [C]);
  assert.deepEqual(result.products.map((row) => row.id), [B, A]);
  const expected = mapProductToDetailDto(products[1], { lang: "ar", promotion: null });
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.products[0][key], value, key);
  assert.equal(result.products[0].name, "كرة");
  assert.equal(result.products[0].isFavorite, false);
  assert.equal(result.products[0].media[0].type, "image");
});

test("empty, malformed, oversized and maximum-count batch requests have explicit outcomes", async (t) => {
  const { filters } = fixture(t, Array.from({ length: 50 }, (_v, index) => product((index + 1).toString(16).padStart(24, "0"))));
  assert.deepEqual(await getProductsBatchService([]), { products: [], unavailable_product_ids: [] });
  assert.equal(filters.length, 0);
  for (const body of [null, {}, { ids: "text" }, { ids: [1] }, { ids: ["bad"] },
    { ids: [], extra: true }, { ids: Array(51).fill(A) }]) {
    assert.throws(() => parseProductBatchBody(body), (error) => error.statusCode === 400);
  }
  const ids = Array.from({ length: 50 }, (_v, index) => (index + 1).toString(16).padStart(24, "0"));
  const result = await getProductsBatchService(ids);
  assert.equal(result.products.length, 50); assert.deepEqual(result.unavailable_product_ids, []);
  assert.equal(filters.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024);
});

test("batch preserves full variant detail, customer favorites, restock state and warehouse context", async (t) => {
  fixture(t, [product(A, { type: "VARIANT", variants: [{ _id: B, price: 200, discountedPrice: 150,
    sku: "LARGE", options: [{ name: "Size", value: "Large" }], images: [],
    warehouseStocks: [{ warehouse: W, quantity: 9, revision: 2 }] }], options: [{ name: "Size", values: ["Large"] }] })]);
  t.mock.method(FavoriteModel, "findOne", (filter) => {
    assert.deepEqual(filter, { guestId: "guest-one" }); return queryResult({ items: [{ product: A }] });
  });
  t.mock.method(RestockSubscriptionModel, "find", (filter) => {
    assert.equal(filter.guestId, "guest-one"); assert.equal(filter.warehouse, W);
    assert.deepEqual(filter.product.$in, [A]); return queryResult([{ product: A }]);
  });
  const result = await getProductsBatchService([A], { guestId: "guest-one", warehouseId: W });
  const dto = result.products[0];
  assert.equal(dto.price, null); assert.equal(dto.discountedPrice, null);
  assert.equal(dto.variants[0].price, 200); assert.equal(dto.variants[0].discountedPrice, 150);
  assert.equal(dto.stock, 9); assert.equal(dto.isFavorite, true);
  assert.equal(dto.isRestockNotificationRequested, true);
  assert.equal(dto.variants[0].warehouseStocks[0].revision, undefined);
});

test("active visibility and staff-only fields follow the product detail rules", async (t) => {
  fixture(t, [product(A, { isActive: false })]);
  assert.deepEqual(await getProductsBatchService([A]), { products: [], unavailable_product_ids: [A] });
  const staff = await getProductsBatchService([A], { user: { _id: W, role: "superAdmin" }, includeStockRevisions: true });
  assert.equal(staff.products[0].name_en, "Ball"); assert.equal(staff.products[0].name_ar, "كرة");
  assert.equal(staff.products[0].warehouseStocks[0].revision, 4);
});

test("batch promotion pricing, set-based gallery loading and failure propagation remain read-only", async (t) => {
  fixture(t);
  process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED = "true";
  t.mock.method(CollectionModel, "find", () => queryResult([{ _id: C, slug: "sale",
    promotion: { discountPercent: 20 }, selector: { productIds: [A] } }]));
  let mediaCalls = 0;
  t.mock.method(ProductVideoModel, "aggregate", (pipeline) => {
    mediaCalls++; assert.deepEqual(pipeline[0].$match.productId.$in.map(String), [A, B]);
    return { option(value) {
      assert.equal(value.maxTimeMS, 10000);
      return Promise.resolve([{ _id: C, productId: A, asset: { durationSeconds: 5, width: 100, height: 100 } }]);
    } };
  });
  const result = await getProductsBatchService([A, B]);
  assert.equal(result.products[0].discountedPrice, 80); assert.equal(result.products[1].price, 100);
  assert.equal(result.products[0].media.length, 2); assert.equal(result.products[1].media.length, 1);
  assert.equal(mediaCalls, 1);
  t.mock.method(ProductModel, "find", () => { throw new Error("Database unavailable"); });
  await assert.rejects(getProductsBatchService([A]), /Database unavailable/);
});

test("nested-category promotions use one category query and retain first-match pricing", async (t) => {
  const parent = "507f1f77bcf86cd799439012", child = "507f1f77bcf86cd799439013";
  const leaf = "507f1f77bcf86cd799439014";
  fixture(t, [product(A, { subcategory: leaf }), product(B, { subcategory: child })]);
  let categoryQueries = 0;
  t.mock.method(SubcategoryModel, "find", (filter) => {
    categoryQueries++;
    assert.deepEqual(filter, {}, "Promotion ancestry must use the already-loaded parent map");
    return queryResult([{ _id: parent, parent: null }, { _id: child, parent }, { _id: leaf, parent: child }]);
  });
  let promotionQueries = 0;
  t.mock.method(CollectionModel, "find", () => {
    promotionQueries++;
    return queryResult([
      { _id: C, slug: "parent-sale", promotion: { discountPercent: 10 }, selector: { subcategoryIds: [parent] } },
      { _id: W, slug: "child-sale", promotion: { discountPercent: 20 }, selector: { subcategoryIds: [child] } },
    ]);
  });
  const result = await getProductsBatchService([A, B]);
  assert.equal(categoryQueries, 1);
  assert.equal(promotionQueries, 1);
  assert.deepEqual(result.products.map((row) => row.discountedPrice), [90, 90]);
});

test("batched promotions preserve product/category/brand priority and exclude unrelated descendants", async (t) => {
  const parent = "507f1f77bcf86cd799439012", leaf = "507f1f77bcf86cd799439013";
  const unrelated = "507f1f77bcf86cd799439014", brand = "507f1f77bcf86cd799439015";
  fixture(t, [product(A, { subcategory: leaf, brand }), product(B, { subcategory: leaf, brand }),
    product(C, { subcategory: unrelated, brand }), product(W, { subcategory: unrelated })]);
  t.mock.method(SubcategoryModel, "find", (filter) => {
    assert.deepEqual(filter, {});
    return queryResult([{ _id: parent, parent: null }, { _id: leaf, parent }, { _id: unrelated, parent: null }]);
  });
  t.mock.method(CollectionModel, "find", () => queryResult([
    { _id: parent, slug: "category-sale", promotion: { discountPercent: 10 }, selector: { subcategoryIds: [parent] } },
    { _id: leaf, slug: "direct-sale", promotion: { discountPercent: 30 }, selector: { productIds: [A] } },
    { _id: brand, slug: "brand-sale", promotion: { discountPercent: 5 }, selector: { brandIds: [brand] } },
  ]));
  const result = await getProductsBatchService([A, B, C, W]);
  assert.deepEqual(result.products.map((row) => row.discountedPrice), [70, 90, 95, null]);
});

test("response bounds reject huge complete DTOs without truncating their fields", async (t) => {
  fixture(t, [product(A, { desc_en: "a".repeat(2 * 1024 * 1024) })]);
  await assert.rejects(getProductsBatchService([A]), (error) => error.statusCode === 413);
});

test("batch HTTP uses the real route, accepts guests, validates input and respects authentication/staff scope", async (t) => {
  const { filters } = fixture(t);
  const secret = process.env.JWT_ACCESS_SECRET;
  const environment = process.env.NODE_ENV;
  process.env.JWT_ACCESS_SECRET = "product-batch-test-secret";
  process.env.NODE_ENV = "production";
  t.after(() => {
    if (secret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = secret;
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  });
  t.mock.method(UserModel, "findById", async (_id) => ({ _id, role: "moderator", active: true, phoneVerified: true, account_status: "active" }));
  t.mock.method(WarehouseModel, "find", () => queryResult([{ _id: W }]));
  const app = express();
  app.use("/api/v1/products/batch", productBatchBodyParser);
  app.use(express.json({ limit: "5mb" })); app.use(i18nMiddleware);
  app.use("/api/v1/products", productRoutes); app.use(globalError);
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/products/batch`;
  const headers = { "Content-Type": "application/json", "Accept-Language": "ar" };
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ids: [A, B, C] }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json(); assert.equal(body.data.products.length, 2);
    assert.deepEqual(body.data.unavailable_product_ids, [C]); assert.equal(filters.length, 1);
    const empty = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ids: [] }) });
    assert.deepEqual(await empty.json(), { data: { products: [], unavailable_product_ids: [] } });
    assert.equal(empty.status, 200); assert.equal(filters.length, 1);
    const malformed = await fetch(url, { method: "POST", headers, body: '{"ids":' });
    assert.equal(malformed.status, 400); assert.equal(filters.length, 1);
    const wrongType = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ ids: [A] }) });
    assert.equal(wrongType.status, 415); assert.equal(filters.length, 1);
    for (const [suffix, payload] of [["", { ids: ["bad"] }], ["?warehouse=bad", { ids: [A] }], ["?limit=1", { ids: [A] }]]) {
      const invalid = await fetch(url + suffix, { method: "POST", headers, body: JSON.stringify(payload) });
      assert.equal(invalid.status, 400);
    }
    const badToken = await fetch(url, { method: "POST", headers: { ...headers, Authorization: "Bearer invalid" }, body: JSON.stringify({ ids: [A] }) });
    assert.equal(badToken.status, 401);
    const tooLarge = await fetch(url, { method: "POST", headers, body: " ".repeat(2048) + JSON.stringify({ ids: [A] }) });
    assert.equal(tooLarge.status, 413); assert.equal(filters.length, 1);
    const token = jwt.sign({ userId: W }, process.env.JWT_ACCESS_SECRET);
    const forbidden = await fetch(url + `?warehouse=${B}`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify({ ids: [A] }) });
    assert.equal(forbidden.status, 403); assert.equal(filters.length, 1);
  } finally {
    productBatchLimiter.resetKey("127.0.0.1");
    await new Promise((resolve) => server.close(resolve));
  }
});

test("batch results are isolated across identities, locales and warehouses without a shared cache", async (t) => {
  fixture(t);
  const secondWarehouse = C;
  t.mock.method(FavoriteModel, "findOne", (filter) => queryResult({ items: filter.guestId === "one" ? [{ product: A }] : [] }));
  const first = await getProductsBatchService([A], { guestId: "one", lang: "ar", warehouseId: W });
  const second = await getProductsBatchService([A], { guestId: "two", lang: "en", warehouseId: secondWarehouse });
  assert.equal(first.products[0].isFavorite, true); assert.equal(first.products[0].name, "كرة");
  assert.equal(first.products[0].stock, 7);
  assert.equal(second.products[0].isFavorite, false); assert.equal(second.products[0].name, "Ball");
  assert.equal(second.products[0].stock, 0);
});
