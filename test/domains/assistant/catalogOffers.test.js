import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { bundleCatalogOffer, catalogOffers } from "../../../src/domains/assistant/products/assistant.catalog-offers.js";

const p = "a00000000000000000000001", q = "a00000000000000000000002";
const v1 = "b00000000000000000000001", v2 = "b00000000000000000000002";
const w1 = "c00000000000000000000001", w2 = "c00000000000000000000002";
const w3 = "c00000000000000000000003", w4 = "c00000000000000000000004";
const stock = (warehouse, quantity) => ({ warehouse, quantity });
const simple = (id, stocks = []) => ({ _id: id, type: "SIMPLE", isActive: true, name_en: `Product ${String(id).slice(-2)}`,
  desc_en: "English", desc_ar: "عربي", price: 100, warehouseStocks: stocks });
const variantProduct = () => ({ _id: p, type: "VARIANT", isActive: true, name_en: "Food", desc_en: "Dry food", variants: [
  { _id: v1, options: [{ name: "pattern", value: "Blue" }], price: 100, warehouseStocks: [stock(w1, 1)] },
  { _id: v2, options: [{ name: "size", value: "2 kg" }], price: 200, warehouseStocks: [stock(w2, 1)] }] });
const bundle = components => ({ _id: "d00000000000000000000001", origin: "manual", status: "published", name_en: "Travel set",
  desc_en: "Bundle description", pricePiastres: 100, components });
const comp = (productId, quantity = 1) => ({ productId, productType: "SIMPLE", quantity });

test("simple offer projects only valid positive-stock warehouse ids and stable semantic hash", () => {
  const row = catalogOffers(simple(p, [stock(w1, 1), stock(w2, 2), stock(w3, 0), stock("bad", 9), stock(w4, -1), stock(w1, 8)]))[0];
  assert.deepEqual(row.warehouseIds, [w2]);
  assert.equal(row._id, `product:${p}:simple`);
  assert.match(row.sourceId, /^[a-f\d]{24}$/); assert.match(row.textHash, /^[a-f\d]{64}$/);
  const before = catalogOffers(simple(p, [stock(w1, 1)]))[0];
  const changedInventoryPrice = simple(p, [stock(w2, 40)]); changedInventoryPrice.price = 500;
  assert.equal(catalogOffers(changedInventoryPrice)[0].textHash, before.textHash);
  assert.notEqual(catalogOffers({ ...simple(p), name_en: "Changed" })[0].textHash, before.textHash);
});

test("variant offers stay exact and retain raw labels without treating them as verified facts", () => {
  const offers = catalogOffers(variantProduct());
  assert.deepEqual(offers.map(row => row.variantId), [v1, v2]);
  assert.deepEqual(offers.map(row => row.warehouseIds), [[w1], [w2]]);
  assert.ok(offers[0].text.includes("Option (unverified): pattern: Blue"));
  assert.ok(!offers[0].text.includes("Verified pattern"));
  const before = offers[1].textHash;
  const changed = variantProduct(); changed.variants[1].options[0].value = "3 kg";
  assert.notEqual(catalogOffers(changed)[1].textHash, before);
  const bad = variantProduct(); bad.variants[0].warehouseStocks = [stock(w1, 1), stock(w1, 2)];
  assert.deepEqual(catalogOffers(bad)[0].warehouseIds, []);
});

test("bundle availability requires the intersection of exact component stock warehouses", () => {
  const x = simple(p, [stock(w1, 1), stock(w2, 2), stock(w4, 1)]);
  const y = simple(q, [stock(w2, 3), stock(w3, 4), stock(w4, 1)]);
  assert.deepEqual(bundleCatalogOffer(bundle([comp(p), comp(q)]), [x, y]).warehouseIds, [w2, w4]);
});

test("BSON bundle component product and variant IDs preserve the same exact projection", () => {
  const x = variantProduct();
  const y = simple(q, [stock(w1, 5), stock(w2, 5)]);
  const components = [{ productId: p, productType: "VARIANT", variantId: v1, quantity: 1 }, comp(q)];
  const expected = bundleCatalogOffer(bundle(components), [x, y]); assert.ok(expected);
  const bson = bundle(components.map(row => ({ ...row, productId: new mongoose.Types.ObjectId(row.productId),
    ...(row.variantId ? { variantId: new mongoose.Types.ObjectId(row.variantId) } : {}) })));
  assert.deepEqual(bundleCatalogOffer(bson, [x, y]), expected);
});

test("bundle text uses exact component variants and quantities; required quantities are enforced", () => {
  const x = { _id: p, type: "VARIANT", isActive: true, name_en: "Food", warehouseStocks: [], variants: [
    { _id: v1, options: [{ name: "size", value: "Small" }], warehouseStocks: [stock(w1, 1)] },
    { _id: v2, options: [{ name: "size", value: "Large" }], warehouseStocks: [stock(w1, 100)] }] };
  const y = simple(q, [stock(w1, 1)]);
  assert.equal(bundleCatalogOffer(bundle([{ productId: p, productType: "VARIANT", variantId: v1, quantity: 2 }, comp(q)]), [x, y]), null);
  x.variants[0].warehouseStocks[0].quantity = 2;
  const result = bundleCatalogOffer(bundle([{ productId: p, productType: "VARIANT", variantId: v1, quantity: 2 }, comp(q)]), [x, y]);
  assert.ok(result.text.includes("2 × Food — option (unverified) size: Small"));
  assert.ok(!result.text.includes("Large"));
  assert.notEqual(result.textHash, bundleCatalogOffer(bundle([{ productId: p, productType: "VARIANT", variantId: v2, quantity: 2 }, comp(q)]), [x, y]).textHash);
});

test("unpublished, unsupported, stale, inactive, duplicate and malformed bundle sources fail closed", () => {
  const products = [simple(p, [stock(w1, 5)]), simple(q, [stock(w1, 5)])];
  const row = bundle([comp(p), comp(q)]);
  for (const value of [{ ...row, status: "draft" }, { ...row, origin: "mystery" },
    { ...row, origin: "ai", aiEvidenceJson: "{}" }]) assert.equal(bundleCatalogOffer(value, products), null);
  assert.equal(bundleCatalogOffer(row, [products[0]]), null);
  assert.equal(bundleCatalogOffer(row, [{ ...products[0], isActive: false }, products[1]]), null);
  assert.equal(bundleCatalogOffer(bundle([{ ...comp(p), quantity: 9 }, comp(q)]), products), null);
  assert.equal(bundleCatalogOffer(bundle([comp(p), comp(q)]), [products[0], products[0], products[1]]), null);
  const duplicate = simple(p, [stock(w1, 5), stock(w1, 6)]);
  assert.equal(bundleCatalogOffer(row, [duplicate, products[1]]), null);
});

test("text stays within 2000 UTF-8 bytes, hashes only text, and accepts Mongoose ObjectIds", () => {
  const product = simple(new mongoose.Types.ObjectId(), []);
  product.name_en = "Long"; product.desc_en = "🐈".repeat(2000); product.desc_ar = "تفاصيل".repeat(500);
  const [result] = catalogOffers(product);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 2000);
  assert.equal(result.sourceId, String(product._id));
  assert.equal(result.textHash, catalogOffers(product)[0].textHash);
  assert.equal(catalogOffers({ ...product, name_ar: "اسم" })[0].textHash === result.textHash, false);
});
