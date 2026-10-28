import assert from "node:assert/strict";
import test from "node:test";
import { bundleOriginalPricePiastres, buildBundleProductCard } from "../../../src/domains/bundle/bundle.product-card.js";

const p = "b00000000000000000000001", q = "b00000000000000000000002", v = "b00000000000000000000003";
const w = "c00000000000000000000001", other = "c00000000000000000000002", id = "d00000000000000000000001";
function fixture() {
  return { warehouse: { _id: w, active: true }, bundle: { _id: id, origin: "manual", status: "published", revision: 2,
    name_en: "Cat essentials", name_ar: "أساسيات القطط", pricePiastres: 23000,
    components: [{ productId: p, productType: "SIMPLE", quantity: 2 }, { productId: q, productType: "VARIANT", variantId: v, quantity: 1 }] },
  products: [{ _id: p, type: "SIMPLE", isActive: true, price: 100, discountedPrice: 50, name_en: "Food", name_ar: "أكل",
    images: [{ url: "https://example.invalid/food.jpg", isMain: true }], warehouseStocks: [{ warehouse: w, quantity: 7 }] },
  { _id: q, type: "VARIANT", isActive: true, name_en: "Litter", name_ar: "رمل", price: 1, variants: [
    { _id: v, price: 80, discountedPrice: 20, options: [{ name: "Weight", value: "5kg" }], images: [{ url: "https://example.invalid/litter.jpg" }], warehouseStocks: [{ warehouse: w, quantity: 4 }] },
    { _id: p, price: 1, warehouseStocks: [{ warehouse: w, quantity: 100 }] }] }] };
}

test("original bundle price sums exact regular component prices and quantities, ignoring individual discounts", () => {
  const f = fixture(), before = structuredClone(f);
  assert.equal(bundleOriginalPricePiastres(f.bundle.components, f.products), 28000);
  const card = buildBundleProductCard(f);
  assert.equal(card.price, 280); assert.equal(card.discountedPrice, 230);
  assert.equal(card.originalPricePiastres, 28000); assert.equal(card.sellingPricePiastres, 23000);
  assert.equal(card.promotion, null); assert.deepEqual(f, before);
});

test("customer card follows existing product display fields with an explicit BUNDLE type and exact component details", () => {
  const f = fixture(), card = buildBundleProductCard({ ...f, lang: "ar" });
  assert.equal(card.type, "BUNDLE"); assert.equal(card.name, "أساسيات القطط"); assert.equal(card.id, id);
  assert.equal(card.stock, 3); assert.equal(card.inStock, true); assert.equal(card.warehouseId, w);
  assert.equal(card.hasVariants, false); assert.equal(card.revision, 2); assert.equal(card.currency, "EGP");
  assert.equal(card.image, f.products[0].images[0].url); assert.equal(card.components[0].name, "أكل");
  assert.equal(card.components[1].variantId, v); assert.deepEqual(card.components[1].variantOptions, [{ name: "Weight", value: "5kg" }]);
  for (const key of ["slug", "category", "subcategory", "brand"]) assert.equal(card[key], null);
  assert.equal(card.ratingAverage, 0); assert.equal(card.ratingCount, 0);
});

test("paused, unpublished, wrong-warehouse, unavailable and invalid discount cards are omitted", () => {
  for (const mutate of [f => { f.bundle.status = "paused"; }, f => { f.bundle.status = "draft"; },
    f => { f.bundle.origin = "ai"; }, f => { f.warehouse._id = other; }, f => { f.warehouse.active = false; },
    f => { f.warehouse.fulfillment = { status: "MAINTENANCE" }; }, f => { f.products[0].isActive = false; },
    f => { f.products[0].warehouseStocks[0].quantity = 1; }, f => { f.bundle.pricePiastres = 0; },
    f => { f.bundle.pricePiastres = 28001; }]) {
    const f = fixture(); mutate(f); assert.equal(buildBundleProductCard(f), null);
  }
});

test("other warehouses and variants never supply missing bundle stock or lower its comparison price", () => {
  const f = fixture(); f.products[1].variants[0].warehouseStocks = [{ warehouse: other, quantity: 100 }];
  assert.equal(buildBundleProductCard(f), null);
  assert.equal(bundleOriginalPricePiastres(f.bundle.components, f.products), 28000);
});

test("missing, ambiguous, changed-type or invalid component prices cannot establish an original price", () => {
  for (const mutate of [f => { f.products = []; }, f => { f.products.push(structuredClone(f.products[0])); },
    f => { f.products[0].type = "VARIANT"; }, f => { f.products[1].variants = []; },
    ...[undefined, "100", -1, NaN, Infinity, Number.MAX_SAFE_INTEGER].map(price => f => { f.products[0].price = price; })]) {
    const f = fixture(); mutate(f); assert.throws(() => bundleOriginalPricePiastres(f.bundle.components, f.products), { statusCode: 409 });
  }
});

test("canonical duplicate quantities and decimal prices use safe integer piastres without cumulative rounding", () => {
  const f = fixture(); f.products[0].price = 11.37;
  assert.equal(bundleOriginalPricePiastres([{ productId: p.toUpperCase(), productType: "SIMPLE", quantity: 1 },
    { productId: p, productType: "SIMPLE", quantity: 2 }], f.products), 3411);
  f.products[0].price = 1;
  assert.throws(() => bundleOriginalPricePiastres([{ productId: p, productType: "SIMPLE", quantity: Number.MAX_SAFE_INTEGER }], f.products), { code: "BUNDLE_COMPONENT_PRICE_INVALID" });
});

test("component metadata and bundle display do not expose staff fields or invent category, review or promotion data", () => {
  const f = fixture(); f.bundle.createdBy = "private staff identity"; f.products[0].cost = "private cost";
  const card = buildBundleProductCard(f), serialized = JSON.stringify(card);
  assert.equal(serialized.includes("private"), false); assert.equal(card.category, null); assert.equal(card.promotion, null);
  assert.equal(card.components[0].image, f.products[0].images[0].url);
  assert.equal(card.components[1].image, f.products[1].variants[0].images[0].url);
});

test("a drop in regular component prices never silently changes the fixed selling price or yields an invalid discount", () => {
  const f = fixture(); f.products[0].price = 50;
  assert.equal(buildBundleProductCard(f), null); assert.equal(f.bundle.pricePiastres, 23000);
  f.products[0].price = 75;
  const card = buildBundleProductCard(f); assert.equal(card.price, 230); assert.equal(card.discountedPrice, 230);
});
