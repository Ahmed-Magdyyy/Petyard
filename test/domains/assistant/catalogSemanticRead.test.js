import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { readAssistantCatalog } from "../../../src/domains/assistant/products/assistant.catalog-read.js";
import { catalogOffers, bundleCatalogOffer } from "../../../src/domains/assistant/products/assistant.catalog-offers.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { BrandModel } from "../../../src/domains/brand/brand.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const W = "111111111111111111111111", W2 = "222222222222222222222222";
const PID = "aaaaaaaaaaaaaaaaaaaaaaaa", VID = "bbbbbbbbbbbbbbbbbbbbbbbb", V2 = "cccccccccccccccccccccccc";
const BID = "dddddddddddddddddddddddd", QID = "eeeeeeeeeeeeeeeeeeeeeeee";
const subject = { id: `pet:${PID}`, saved: true, profile: { chronicConditions: [], temporaryIssues: [] } };
const semanticConfig = () => testConfig({ productSearchEnabled: true, catalogSemanticEnabled: true, catalogSemanticMinimumScore: 0.7,
  catalogClassification: { version: "test-v1", foodCategoryIds: [], nonFoodCategoryIds: ["999999999999999999999999"], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] } });
const stock = (warehouse = W, quantity = 3) => ({ warehouse, quantity });
const product = (changes = {}) => ({ _id: new mongoose.Types.ObjectId(PID), slug: "semantic-item", type: "SIMPLE", isActive: true,
  name_en: "Ordinary item", name_ar: "منتج عادي", desc_en: "Description", desc_ar: "وصف", tags: [], category: "999999999999999999999999",
  subcategory: null, brand: null, price: 100, discountedPrice: null, images: [], warehouseStocks: [stock()], ...changes });
const variantProduct = (changes = {}) => product({ type: "VARIANT", warehouseStocks: [], variants: [
  { _id: new mongoose.Types.ObjectId(VID), options: [{ name: "color", value: "Blue" }], price: 100, discountedPrice: null, images: [], warehouseStocks: [stock()] },
  { _id: new mongoose.Types.ObjectId(V2), options: [{ name: "size", value: "Large" }], price: 200, discountedPrice: null, images: [], warehouseStocks: [stock()] },
], ...changes });
const descriptor = row => ({ _id: row._id, kind: row.kind, sourceId: row.sourceId, variantId: row.variantId, textHash: row.textHash });
const simpleDescriptor = row => descriptor(catalogOffers(row)[0]);
const variantDescriptor = (row, variantId = VID) => descriptor(catalogOffers(row).find(item => item.variantId === variantId));
const bundleRow = (components = [{ productId: PID, productType: "SIMPLE", quantity: 1 }], changes = {}) => ({
  _id: new mongoose.Types.ObjectId(BID), origin: "manual", status: "published", revision: 1, name_en: "Semantic set", name_ar: "مجموعة",
  desc_en: "Bundle", desc_ar: "وصف", components, pricePiastres: 5000, ...changes });

function fixture(t, rows = []) {
  const state = { rows, bundles: [], reads: [], warehouseReads: [], brandReads: [], collectionReads: [], bundleReads: [] };
  const query = (resolve) => {
    let limit = Infinity;
    const out = { populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return this; },
      maxTimeMS() { return this; }, limit(value) { limit = value; return this; },
      then(ok, fail) { return Promise.resolve().then(resolve).then(value => Array.isArray(value) ? value.slice(0, limit) : value).then(ok, fail); } };
    return out;
  };
  const inStock = (row, warehouse) => {
    const skus = row.type === "VARIANT" ? row.variants ?? [] : [row];
    return skus.some(sku => (sku.warehouseStocks ?? []).some(item => String(item.warehouse) === String(warehouse) && item.quantity > 0));
  };
  const matchesQuery = (row, clause) => {
    if (clause.$and) return clause.$and.every(part => matchesQuery(row, part));
    if (clause.$or) return clause.$or.some(part => matchesQuery(row, part));
    return Object.entries(clause).some(([field, match]) => {
      const regex = new RegExp(match.$regex, match.$options);
      const values = field.startsWith("variants.options.") ? (row.variants ?? []).flatMap(variant => (variant.options ?? []).map(option => option[field.split(".").at(-1)]))
        : Array.isArray(row[field]) ? row[field] : [row[field] ?? ""];
      return values.some(value => regex.test(String(value)));
    });
  };
  t.mock.method(WarehouseModel, "findById", async id => {
    state.warehouseReads.push(String(id)); return state.warehouses?.find(row => String(row._id) === String(id)) ?? { _id: id, active: true };
  });
  t.mock.method(BrandModel, "find", filter => { state.brandReads.push(filter); return query(() => []); });
  t.mock.method(ProductModel, "find", (filter) => {
    state.reads.push(filter);
    return query(() => {
      const warehouse = filter.$and ? W : (filter.$or?.[0]?.warehouseStocks?.$elemMatch?.warehouse ??
        filter.$or?.[1]?.variants?.$elemMatch?.warehouseStocks?.$elemMatch?.warehouse ?? W);
      if (filter.$and) return state.rows.filter(row => row.isActive && inStock(row, warehouse) && matchesQuery(row, filter.$and[0]));
      const ids = filter._id?.$in?.map(String) ?? [];
      return state.rows.filter(row => ids.includes(String(row._id)) && row.isActive && inStock(row, warehouse));
    });
  });
  t.mock.method(SubcategoryModel, "find", () => query(() => []));
  t.mock.method(CollectionModel, "find", filter => { state.collectionReads.push(filter); return query(() => []); });
  t.mock.method(ManualBundle, "find", filter => {
    state.bundleReads.push(filter);
    return query(() => filter._id?.$in ? state.bundles.filter(row => filter._id.$in.map(String).includes(String(row._id)) && row.status === "published") : []);
  });
  // Bundle catalog storage readiness is mocked; no MongoDB connection is made.
  const priorDb = ManualBundle.db.db;
  if (priorDb) t.mock.method(priorDb, "listCollections", () => ({ toArray: async () => [{ type: "collection", options: {} }] }));
  else {
    ManualBundle.db.db = { listCollections: () => ({ toArray: async () => [{ type: "collection", options: {} }] }) };
    t.after(() => { ManualBundle.db.db = priorDb; });
  }
  t.mock.method(ManualBundle.collection, "indexes", async () => [
    { name: "_id_", key: { _id: 1 } }, { name: "manual_bundle_catalog_v1", key: { origin: 1, status: 1, _id: -1 } },
  ]);
  state.read = (overrides = {}, options = {}, config = semanticConfig()) => readAssistantCatalog({ query: "synonym", warehouseId: W,
    language: "en", subject, warnings: [], ...overrides }, config, options);
  return state;
}

test("synonym semantic candidate appears without literal name match and is rechecked for the requested warehouse", async t => {
  const row = product({ warehouseStocks: [stock(W2), stock("333333333333333333333333"), stock("444444444444444444444444"), stock(W)] }); const state = fixture(t, [row]);
  const result = await state.read({}, { semanticCandidates: async ({ warehouseId, query }) => {
    assert.equal(warehouseId, W); assert.equal(query, "synonym"); return [simpleDescriptor(row)];
  } });
  assert.equal(result.status, "results"); assert.deepEqual(result.products.map(card => card.id), [PID]);
  assert.deepEqual(state.reads[1]._id.$in, [PID]); assert.equal(state.reads[1].isActive, true);
});

test("only a fresh exact matched variant is exposed; a stocked sibling cannot rescue a stale or unstocked match", async t => {
  const row = variantProduct({ variants: [
    { ...variantProduct().variants[0], warehouseStocks: [] }, { ...variantProduct().variants[1], warehouseStocks: [stock()] },
  ] }); const state = fixture(t, [row]);
  let result = await state.read({}, { semanticCandidates: async () => [variantDescriptor(row, VID)] });
  assert.deepEqual(result.products, []);
  row.variants[0].warehouseStocks = [stock()];
  result = await state.read({}, { semanticCandidates: async () => [variantDescriptor(row, VID)] });
  assert.equal(result.products.length, 1); assert.equal(result.products[0].price, 100);
  const stale = variantDescriptor(row, VID); stale.textHash = "f".repeat(64);
  result = await state.read({}, { semanticCandidates: async () => [stale] }); assert.deepEqual(result.products, []);
});

test("unknown semantic labels do not satisfy exact filters and dietary review still withholds food", async t => {
  const row = variantProduct({ variants: [{ ...variantProduct().variants[0], options: [{ name: "unreviewed", value: "Blue" }] }] });
  const state = fixture(t, [row]);
  let result = await state.read({ filters: { minimumPackageWeightGrams: null, maximumPriceMinor: null, options: [{ name: "color", value: "Blue" }] } },
    { semanticCandidates: async () => [variantDescriptor(row, VID)] });
  assert.equal(result.status, "needs_verified_filters"); assert.deepEqual(result.products, []); assert.equal(result.unverifiedOfferCount, 1);
  row.category = "999999999999999999999998";
  result = await state.read({ warnings: [{ subjectId: subject.id, state: "active", text: "allergy" }] },
    { semanticCandidates: async () => [variantDescriptor(row, VID)] });
  assert.equal(result.status, "food_review_required"); assert.equal(result.withheldCount, 1);
});

test("semantic failures fall back, while disabled, missing-location, and changed-location reads do not call candidates", async t => {
  const row = product({ name_en: "Synonym" }); const state = fixture(t, [row]); let calls = 0;
  const semanticCandidates = async () => { calls++; throw new Error("retriever unavailable"); };
  let result = await state.read({}, { semanticCandidates }); assert.equal(result.products.length, 1);
  await state.read({}, { semanticCandidates }, testConfig()); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await state.read({}, { semanticCandidates, signal: controller.signal }); assert.equal(calls, 1);
  await state.read({ warehouseId: null }, { semanticCandidates }); assert.equal(calls, 1);
  state.warehouses = [{ _id: W, active: true, fulfillment: { status: "MAINTENANCE", fallbackWarehouse: W2 } }, { _id: W2, active: true }];
  await assert.rejects(state.read({}, { semanticCandidates }), { code: "catalog_warehouse_changed" }); assert.equal(calls, 1);
});

test("malformed, duplicate, stale, and over-limit descriptors cannot expand product reads", async t => {
  const row = product(); const state = fixture(t, [row]);
  const candidate = simpleDescriptor(row); const malformed = { ...candidate, sourceId: "bad" };
  const result = await state.read({}, { semanticCandidates: async () => [malformed, candidate, candidate,
    ...Array.from({ length: 30 }, () => ({ ...candidate, _id: `product:${QID}:simple`, sourceId: QID }))] });
  assert.equal(result.products.length, 1);
  const exactIdReads = state.reads.filter(filter => filter._id?.$in);
  assert.equal(exactIdReads.length, 1); assert.ok(exactIdReads[0]._id.$in.length <= 20);
  assert.equal(new Set(exactIdReads[0]._id.$in).size, exactIdReads[0]._id.$in.length);
});

test("semantic bundle candidates use fresh published definitions and the real bundle card builder", async t => {
  const source = product({ _id: new mongoose.Types.ObjectId(PID), price: 100 });
  const bundle = bundleRow(); const projected = bundleCatalogOffer(bundle, [source]);
  const state = fixture(t, [source]); state.bundles = [bundle];
  const bundleConfig = { ...semanticConfig(), bundleCartEnabled: true };
  const result = await state.read({}, { semanticCandidates: async () => [descriptor(projected)] }, bundleConfig);
  assert.equal(result.status, "results"); assert.equal(result.products[0].type, "BUNDLE");
  assert.equal(result.products[0].id, String(bundle._id)); assert.equal(result.products[0].priceDisplay, "exact");
  const stale = descriptor(projected); stale.textHash = "a".repeat(64);
  const staleResult = await state.read({}, { semanticCandidates: async () => [stale] }, bundleConfig);
  assert.notEqual(staleResult.products[0]?.type, "BUNDLE");
  source.name_en = "Changed component";
  const changedComponent = await state.read({}, { semanticCandidates: async () => [descriptor(projected)] }, bundleConfig);
  assert.notEqual(changedComponent.products[0]?.type, "BUNDLE");
  source.name_en = "Ordinary item";
  state.bundles = [{ ...bundle, status: "draft" }];
  const unpublished = await state.read({}, { semanticCandidates: async () => [descriptor(projected)] }, bundleConfig);
  assert.notEqual(unpublished.products[0]?.type, "BUNDLE");
});

test("semantic similarity cannot relax exact quoted brand or SKU constraints", async t => {
  const row = product({ brand: { _id: QID, name_en: "Royal Canin", name_ar: "رويال كانين" }, sku: "RC-123" });
  const state = fixture(t, [row]), options = { semanticCandidates: async () => [simpleDescriptor(row)] };
  const filter = (name, value) => ({ minimumPackageWeightGrams: null, maximumPriceMinor: null, options: [{ name, value, sourceQuote: value }] });
  for (const [name, value] of [["brand", "Royal Canin"], ["ماركة", "رويال كانين"], ["sku", "RC-123"]]) {
    const result = await state.read({ filters: filter(name, value) }, options);
    assert.equal(result.products.length, 1); assert.equal(result.products[0].matchingOfferCount, 1);
  }
  assert.equal((await state.read({ filters: filter("brand", "Different brand") }, options)).products.length, 0);
  assert.equal((await state.read({ filters: filter("sku", "RC-999") }, options)).products.length, 0);
  assert.equal((await state.read({ filters: filter("sku", "rc-123") }, options)).products.length, 0, "SKU case must not silently select a different identifier");
  row.brand = QID;
  const unknown = await state.read({ filters: filter("brand", "Royal Canin") }, { semanticCandidates: async () => [simpleDescriptor(row)] });
  assert.equal(unknown.status, "needs_verified_filters"); assert.equal(unknown.products.length, 0);
});

test("exact SKU filtering cannot switch from the semantic variant to its stocked sibling", async t => {
  const row = variantProduct(); row.variants[0].sku = "SKU-A"; row.variants[1].sku = "SKU-B";
  const state = fixture(t, [row]);
  const result = await state.read({ filters: { minimumPackageWeightGrams: null, maximumPriceMinor: null,
    options: [{ name: "sku", value: "SKU-B", sourceQuote: "SKU-B" }] } }, { semanticCandidates: async () => [variantDescriptor(row)] });
  assert.equal(result.products.length, 0);
});

test("a top-ranked semantic bundle is not crowded out by three lower-ranked ordinary products", async t => {
  const rows = [product(), product({ _id: new mongoose.Types.ObjectId(QID), name_en: "Another item" }),
    product({ _id: new mongoose.Types.ObjectId("ffffffffffffffffffffffff"), name_en: "Third item" })];
  const bundle = bundleRow(), projected = bundleCatalogOffer(bundle, rows), state = fixture(t, rows);
  state.bundles = [bundle];
  const result = await state.read({}, { semanticCandidates: async () => [descriptor(projected), ...rows.map(simpleDescriptor)] },
    { ...semanticConfig(), bundleCartEnabled: true });
  assert.deepEqual(result.products.map(row => row.id), [BID, PID, QID]);
  assert.equal(result.products[0].type, "BUNDLE"); assert.equal(result.products.length, 3);
});

test("three surviving keyword cards do not acquire a dependency on bundle-store availability", async t => {
  const rows = [product({ name_en: "Ordinary first" }), product({ _id: new mongoose.Types.ObjectId(QID), name_en: "Ordinary second" }),
    product({ _id: new mongoose.Types.ObjectId("ffffffffffffffffffffffff"), name_en: "Ordinary third" })];
  const state = fixture(t, rows);
  t.mock.method(ManualBundle.collection, "indexes", () => assert.fail("These keyword cards do not need bundles"));
  const result = await state.read({ query: "Ordinary" }, { semanticCandidates: async () => rows.map(simpleDescriptor) },
    { ...semanticConfig(), bundleCartEnabled: true });
  assert.equal(result.products.length, 3); assert.equal(state.bundleReads.length, 0);
});

test("semantic cards use fresh prices and the existing promotion owner with populated brand data", async t => {
  const row = product({ brand: { _id: QID, name_en: "Brand", name_ar: "ماركة" } }), saved = simpleDescriptor(row);
  const state = fixture(t, [row]); row.price = 150;
  t.mock.method(CollectionModel, "find", filter => {
    assert.ok(filter.$or.some(item => item["selector.brandIds"]?.$in.map(String).includes(QID)));
    return { async lean() { return [{ _id: BID, slug: "current-promotion", promotion: { discountPercent: 20 }, selector: { brandIds: [QID] } }]; } };
  });
  const result = await state.read({}, { semanticCandidates: async () => [saved] });
  assert.equal(result.products[0].price, 150); assert.equal(result.products[0].discountedPrice, 120);
});
