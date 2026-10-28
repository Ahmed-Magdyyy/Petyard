import assert from "node:assert/strict";
import test from "node:test";
import { createBundleCatalogService } from "../../../src/domains/bundle/bundle.customer-service.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import * as repository from "../../../src/domains/bundle/bundle.repository.js";
import { ApiError } from "../../../src/shared/utils/ApiError.js";

const actor = { _id: "a00000000000000000000001", role: "user", active: true, phoneVerified: true, account_status: "confirmed" };
const p = "b00000000000000000000001", q = "b00000000000000000000002", w = "c00000000000000000000001", other = "c00000000000000000000002";
const id = n => "d" + String(n).padStart(23, "0");
const query = extra => ({ warehouseId: w, language: "en", ...extra });
function fixture() {
  const f = { calls: [], rows: [{ _id: id(1), origin: "manual", status: "published", revision: 2,
    name_en: "Bundle", name_ar: "باكدج", pricePiastres: 12550, createdBy: "private staff identity",
    components: [{ productId: p, productType: "SIMPLE", quantity: 2 }] }],
  warehouses: { [w]: { _id: w, active: true }, [other]: { _id: other, active: true } },
  products: [{ _id: p, type: "SIMPLE", isActive: true, price: 100, name_en: "Food", name_ar: "أكل",
    warehouseStocks: [{ warehouse: w, quantity: 7 }, { warehouse: other, quantity: 100 }] }] };
  const db = {
    async requireBundleCatalogStore() { f.calls.push(["ready"]); if (f.unready) throw new ApiError("Store unavailable", 503); },
    async findBundleWarehouse(warehouseId) { f.calls.push(["warehouse", warehouseId]); return structuredClone(f.warehouses[warehouseId]); },
    async listPublishedBundles(cursor, limit) {
      f.calls.push(["list", cursor, limit]);
      if (f.overrideRows) return structuredClone(f.overrideRows);
      return structuredClone(f.rows.filter(row => row.origin === "manual" && row.status === "published" && (!cursor || row._id < cursor))
        .sort((a, b) => b._id.localeCompare(a._id)).slice(0, limit));
    },
    async findPublishedBundle(bundleId) {
      f.calls.push(["get", bundleId]);
      return structuredClone(f.overrideOne ?? f.rows.find(row => row._id === bundleId && row.origin === "manual" && row.status === "published") ?? null);
    },
    async findBundleProducts(ids, warehouseId) { f.calls.push(["products", ids, warehouseId]); if (f.productError) throw f.productError; return structuredClone(f.products.filter(row => ids.includes(row._id))); },
  };
  f.service = createBundleCatalogService(db); return f;
}

test("catalog admits only active verified authenticated non-guest accounts before any storage read", async () => {
  for (const invalid of [null, { ...actor, _id: "bad" }, { ...actor, active: false }, { ...actor, phoneVerified: false },
    { ...actor, role: "guest" }, { ...actor, role: "unknown" }, { ...actor, deletedAt: new Date() },
    { ...actor, account_status: "banned" }, { ...actor, account_status: "deleted" }]) {
    const f = fixture();
    await assert.rejects(f.service.list(invalid, query())); await assert.rejects(f.service.get(invalid, id(1), query()));
    assert.deepEqual(f.calls, []);
  }
  for (const role of ["user", "moderator", "admin", "superAdmin"]) assert.equal((await fixture().service.list({ ...actor, role }, query())).bundles.length, 1);
});

test("catalog requires explicit warehouse/language and rejects unsupported filters before any read", async () => {
  for (const input of [{ language: "en" }, { warehouseId: w }, query({ warehouseId: "bad" }), query({ language: "ar-EG" }),
    query({ limit: ["1"] }), query({ limit: 1 }), query({ limit: "0" }), query({ limit: "51" }), query({ limit: "1.5" }),
    query({ cursor: "bad" }), query({ status: "draft" }), query({ products: [] }), query({ ownerId: actor._id })]) {
    const f = fixture(); await assert.rejects(f.service.list(actor, input), { statusCode: 400 }); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); await assert.rejects(f.service.get(actor, "bad", query()), { statusCode: 400 });
  await assert.rejects(f.service.get(actor, id(1), query({ limit: "1" })), { statusCode: 400 }); assert.deepEqual(f.calls, []);
});

test("customer list/detail return fresh product-shaped cards scoped to one exact warehouse without staff fields", async () => {
  const f = fixture(), list = await f.service.list(actor, query({ language: "ar" }));
  assert.equal(list.bundles.length, 1); assert.equal(list.nextCursor, null);
  const card = list.bundles[0]; assert.equal(card.type, "BUNDLE"); assert.equal(card.name, "باكدج");
  assert.equal(card.price, 200); assert.equal(card.discountedPrice, 125.5); assert.equal(card.stock, 3); assert.equal(card.warehouseId, w);
  assert.equal(JSON.stringify(card).includes("private staff identity"), false);
  assert.deepEqual((await f.service.get(actor, id(1), query({ language: "ar" }))).bundle, card);
  assert.deepEqual(f.calls.find(call => call[0] === "list"), ["list", null, 21]);
  assert.equal(f.calls.find(call => call[0] === "products")[2], w);
});

test("warehouse absence/maintenance/inactivity stops before bundle/product lookup and never selects fallback", async () => {
  for (const warehouse of [undefined, { _id: w, active: false }, { _id: other, active: true },
    { _id: w, active: true, fulfillment: { status: "MAINTENANCE", fallbackWarehouse: other } }]) {
    const f = fixture(); f.warehouses[w] = warehouse;
    await assert.rejects(f.service.list(actor, query()), { code: "BUNDLE_WAREHOUSE_UNAVAILABLE", statusCode: 409 });
    assert.deepEqual(f.calls, [["ready"], ["warehouse", w]]);
  }
});

test("paused, draft, AI, malformed or invalid-revision source records are not projected or product-loaded", async () => {
  for (const change of [{ status: "paused" }, { status: "draft" }, { origin: "ai" },
    { components: null }, { components: [null] }, { components: [] }, { revision: 0 }, { _id: "bad" }]) {
    const f = fixture(), bad = { ...f.rows[0], ...change }; f.overrideRows = [bad]; f.overrideOne = bad;
    assert.deepEqual(await f.service.list(actor, query()), { bundles: [], nextCursor: null });
    await assert.rejects(f.service.get(actor, id(1), query()), { statusCode: 404 });
    assert.equal(f.calls.some(call => call[0] === "products"), false);
  }
});

test("missing/depleted stock and invalid comparison prices are omitted, and detail returns the same unavailable response", async () => {
  for (const change of [f => { f.products = []; }, f => { f.products[0].warehouseStocks[0].quantity = 1; },
    f => { f.products[0].isActive = false; }, f => { f.products[0].price = undefined; },
    f => { f.products[0].price = 50; }, f => { f.rows[0].pricePiastres = 0; }, f => { f.rows[0].pricePiastres = 0.5; }]) {
    const f = fixture(); change(f); assert.deepEqual(await f.service.list(actor, query()), { bundles: [], nextCursor: null });
    await assert.rejects(f.service.get(actor, id(1), query()), { code: "BUNDLE_NOT_FOUND", statusCode: 404 });
  }
  const f = fixture(); await assert.rejects(f.service.get(actor, id(2), query()), { code: "BUNDLE_NOT_FOUND" });
  f.products[0].warehouseStocks[1].quantity = 1;
  await assert.rejects(f.service.get(actor, id(1), query({ warehouseId: other })), { code: "BUNDLE_NOT_FOUND" });
});

test("bounded candidate pagination advances through an empty filtered page without skipping eligible later records", async () => {
  const f = fixture(), original = structuredClone(f.rows[0]);
  f.rows = [1, 2, 3, 4].map(number => ({ ...structuredClone(original), _id: id(number) }));
  f.rows[3].components[0].productId = q; f.rows[2].pricePiastres = 20100;
  const first = await f.service.list(actor, query({ limit: "2" })); assert.equal(first.bundles.length, 0); assert.equal(first.nextCursor, id(3));
  const second = await f.service.list(actor, query({ limit: "2", cursor: first.nextCursor }));
  assert.deepEqual(second.bundles.map(row => row.id), [id(2), id(1)]); assert.equal(second.nextCursor, null);
  assert.deepEqual(f.calls.filter(call => call[0] === "list").map(call => call.slice(1)), [[null, 3], [id(3), 3]]);
  assert.equal(f.calls.filter(call => call[0] === "products").length, 2);
});

test("each request re-reads prices, stock and publication status instead of reusing an old card", async () => {
  const f = fixture(); assert.equal((await f.service.get(actor, id(1), query())).bundle.price, 200);
  f.products[0].price = 90; assert.equal((await f.service.get(actor, id(1), query())).bundle.price, 180);
  f.products[0].warehouseStocks[0].quantity = 1; await assert.rejects(f.service.get(actor, id(1), query()), { statusCode: 404 });
  f.products[0].warehouseStocks[0].quantity = 7; f.rows[0].status = "paused";
  await assert.rejects(f.service.get(actor, id(1), query()), { statusCode: 404 });
});

test("store/product failures and ambiguous backend snapshots are not disguised as a successful empty catalog", async () => {
  const f = fixture(); f.unready = true;
  await assert.rejects(f.service.list(actor, query()), { statusCode: 503 }); assert.deepEqual(f.calls, [["ready"]]);
  f.unready = false; f.productError = new ApiError("Backend unavailable", 503);
  await assert.rejects(f.service.list(actor, query()), { statusCode: 503 });
  f.productError = null; f.products.push(structuredClone(f.products[0]));
  await assert.rejects(f.service.list(actor, query()), { code: "BUNDLE_INVALID_SOURCE", statusCode: 503 });
});

test("repository bundle reads admit published manual/AI definitions, bounded and timed while product lookup explicitly uses the selected warehouse", async t => {
  const calls = [], chain = { select(value) { calls.push(["select", value]); return this; }, sort(value) { calls.push(["sort", value]); return this; },
    limit(value) { calls.push(["limit", value]); return this; }, maxTimeMS(value) { calls.push(["timeout", value]); return this; }, lean: async () => [] };
  t.mock.method(ManualBundle, "find", filter => { calls.push(["find", filter]); return chain; });
  t.mock.method(ManualBundle, "findOne", filter => { calls.push(["findOne", filter]); return chain; });
  t.mock.method(ProductModel, "find", filter => { calls.push(["productFind", filter]); return chain; });
  await repository.listPublishedBundles(id(3), 21); await repository.findPublishedBundle(id(1));
  assert.deepEqual(calls.find(call => call[0] === "find")[1], { origin: { $in: ["manual", "ai"] }, status: "published", _id: { $lt: id(3) } });
  assert.deepEqual(calls.find(call => call[0] === "findOne")[1], { _id: id(1), origin: { $in: ["manual", "ai"] }, status: "published" });
  assert.deepEqual(calls.find(call => call[0] === "sort")[1], { _id: -1 }); assert.equal(calls.find(call => call[0] === "limit")[1], 21);
  assert.equal(calls.filter(call => call[0] === "timeout" && call[1] === 5000).length, 2);
  assert.equal(calls.find(call => call[0] === "select")[1].includes("createdBy"), false);
  await repository.findBundleProducts([p], w);
  const productQuery = calls.find(call => call[0] === "productFind")[1];
  assert.deepEqual(productQuery._id, { $in: [p] }); assert.equal(productQuery.isActive, true);
  assert.equal(productQuery.$or[0].warehouseStocks.$elemMatch.warehouse, w);
  assert.equal(productQuery.$or[1].variants.$elemMatch.warehouseStocks.$elemMatch.warehouse, w);
});

test("catalog requires its declared nonautomatic compound index and refuses incompatible index metadata without DDL", async t => {
  const connection = ManualBundle.db, previous = connection.db;
  connection.db = { listCollections: () => ({ toArray: async () => [{ type: "collection", options: {} }] }) };
  t.after(() => { connection.db = previous; });
  const idIndex = { name: "_id_", key: { _id: 1 } }, catalog = { name: "manual_bundle_catalog_v1", key: { origin: 1, status: 1, _id: -1 } };
  let indexes = [idIndex]; t.mock.method(ManualBundle.collection, "indexes", async () => indexes);
  await assert.rejects(repository.requireBundleCatalogStore(), { code: "BUNDLE_STORE_UNAVAILABLE", statusCode: 503 });
  indexes = [idIndex, catalog]; await repository.requireBundleCatalogStore();
  for (const change of [{ hidden: true }, { sparse: true }, { unique: true }, { partialFilterExpression: { status: "published" } },
    { collation: { locale: "en" } }, { key: { warehouse: 1, status: 1 } }]) {
    indexes = [idIndex, { ...catalog, ...change }]; await assert.rejects(repository.requireBundleCatalogStore(), { code: "BUNDLE_STORE_UNAVAILABLE" });
  }
  assert.equal(ManualBundle.schema.options.autoIndex, false); assert.equal(ManualBundle.schema.options.autoCreate, false);
  assert.ok(ManualBundle.schema.indexes().some(([key, options]) => options.name === catalog.name && JSON.stringify(key) === JSON.stringify(catalog.key)));
});

test("X in warehouses 1/2/4 and Y in 2/3/4 make the same bundle visible only in 2 and 4 with their own stock limits", async () => {
  const f = fixture(), warehouse = n => "c" + String(n).padStart(23, "0");
  for (const number of [1, 2, 3, 4]) f.warehouses[warehouse(number)] = { _id: warehouse(number), active: true };
  f.rows[0].components.push({ productId: q, productType: "SIMPLE", quantity: 1 });
  f.products[0].warehouseStocks = [1, 2, 4].map(n => ({ warehouse: warehouse(n), quantity: n === 4 ? 8 : 5 }));
  f.products.push({ _id: q, type: "SIMPLE", price: 50, isActive: true, name_en: "Y", warehouseStocks: [2, 3, 4].map(n => ({ warehouse: warehouse(n), quantity: n === 4 ? 1 : 3 })) });
  for (const number of [1, 3]) assert.equal((await f.service.list(actor, query({ warehouseId: warehouse(number) }))).bundles.length, 0);
  const two = (await f.service.get(actor, id(1), query({ warehouseId: warehouse(2) }))).bundle;
  const four = (await f.service.get(actor, id(1), query({ warehouseId: warehouse(4) }))).bundle;
  assert.equal(two.id, four.id); assert.equal(two.warehouseId, warehouse(2)); assert.equal(four.warehouseId, warehouse(4));
  assert.equal(two.stock, 2); assert.equal(four.stock, 1); assert.equal(two.discountedPrice, four.discountedPrice);
  f.products[1].warehouseStocks.find(row => row.warehouse === warehouse(2)).quantity = 0;
  await assert.rejects(f.service.get(actor, id(1), query({ warehouseId: warehouse(2) })), { statusCode: 404 });
  assert.equal((await f.service.get(actor, id(1), query({ warehouseId: warehouse(4) }))).bundle.stock, 1);
});

test("four separate stock rows stay isolated when stock changes, quantities differ or one warehouse has duplicate rows", async () => {
  const f = fixture(), warehouse = n => "c" + String(n).padStart(23, "0");
  for (const n of [1, 2, 3, 4]) f.warehouses[warehouse(n)] = { _id: warehouse(n), active: true };
  f.rows[0].components = [{ productId: p, productType: "SIMPLE", quantity: 2 }, { productId: q, productType: "SIMPLE", quantity: 3 }];
  f.products[0].warehouseStocks = [10, 9, 0, 20].map((quantity, i) => ({ warehouse: warehouse(i + 1), quantity }));
  f.products.push({ _id: q, type: "SIMPLE", price: 50, isActive: true,
    warehouseStocks: [0, 12, 30, 6].map((quantity, i) => ({ warehouse: warehouse(i + 1), quantity })) });
  const availability = async () => {
    const snapshot = structuredClone(f.products), results = [];
    for (const n of [1, 2, 3, 4]) results.push((await f.service.list(actor, query({ warehouseId: warehouse(n) }))).bundles[0]?.stock ?? 0);
    assert.deepEqual(f.products, snapshot, "catalog reads must never mutate stock"); return results;
  };
  assert.deepEqual(await availability(), [0, 4, 0, 2]);
  f.products[0].warehouseStocks[1].quantity = 0;
  assert.deepEqual(await availability(), [0, 0, 0, 2], "depleting warehouse 2 cannot alter warehouse 4");
  f.products[1].warehouseStocks[0].quantity = 6;
  assert.deepEqual(await availability(), [2, 0, 0, 2]);
  f.products[1].warehouseStocks[3].quantity = 2;
  assert.deepEqual(await availability(), [2, 0, 0, 0], "warehouse 3 stock cannot top up warehouse 4's insufficient quantity");
  f.products[0].warehouseStocks[1].quantity = 9;
  f.products[0].warehouseStocks.push({ warehouse: warehouse(2), quantity: 9 });
  assert.deepEqual(await availability(), [2, 0, 0, 0], "ambiguous rows fail closed only for their own warehouse");
});
