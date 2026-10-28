import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFixedBundleComponents, previewFixedBundle } from "../../../src/domains/bundle/bundle.components.js";

const z = "a00000000000000000000001", x = "a00000000000000000000002", variant = "b00000000000000000000001";
const here = "c00000000000000000000001", elsewhere = "c00000000000000000000002";
const simple = (productId, quantity) => ({ productId, productType: "SIMPLE", quantity });
const stock = (warehouse, quantity) => ({ warehouse, quantity });
const product = (productId, quantity) => ({ _id: productId, type: "SIMPLE", isActive: true, warehouseStocks: [stock(here, quantity)] });
const preview = changes => previewFixedBundle({ components: [simple(z, 2), simple(x, 2)], pricePiastres: 12500,
  warehouseId: here, products: [product(z, 7), product(x, 12)], ...changes });

test("fixed component demands reuse inventory SKU aggregation with canonical identifiers and safe quantities", () => {
  assert.deepEqual(normalizeFixedBundleComponents([simple(z.toUpperCase(), 2), simple(z, 3)]),
    [{ productId: z, productType: "SIMPLE", variantId: null, quantity: 5 }]);
  assert.throws(() => normalizeFixedBundleComponents([simple(z, Number.MAX_SAFE_INTEGER), simple(z, 1)]), { code: "BUNDLE_INVALID_COMPONENTS" });
});

test("malformed definitions and ambiguous simple/variant choices are rejected before any stock estimate", () => {
  for (const components of [null, [], [null], [simple("bad", 1)], [simple(z, 0)], [simple(z, 1.5)],
    [simple(z, Number.MAX_SAFE_INTEGER + 1)], [{ ...simple(z, 1), stock: 50 }],
    [{ ...simple(z, 1), variantId: variant }], [{ ...simple(z, 1), productType: "VARIANT" }],
    [{ ...simple(z, 1), productType: "OTHER" }]]) {
    assert.throws(() => normalizeFixedBundleComponents(components), { code: "BUNDLE_INVALID_COMPONENTS" });
  }
});

test("bundle availability is the lowest whole component ratio in the exact warehouse", () => {
  assert.equal(preview().availableBundles, 3);
  assert.equal(preview({ products: [product(z, 1), product(x, 120)] }).availableBundles, 0);
  assert.equal(preview({ components: [simple(z, 2), simple(z, 2)], products: [product(z, 7)] }).availableBundles, 1);
  assert.equal(preview({ products: [product(z, 8)] }).availableBundles, 0);
});

test("stock in another warehouse cannot qualify a bundle or top up the selected warehouse", () => {
  const products = [product(z, 1), product(x, 12)]; products[0].warehouseStocks.push(stock(elsewhere, 100));
  assert.equal(preview({ products }).availableBundles, 0);
  assert.equal(preview({ warehouseId: elsewhere }).availableBundles, 0);
  assert.throws(() => preview({ warehouseId: null }), { code: "BUNDLE_INVALID_WAREHOUSE" });
});

test("only the exact variant supplies stock, including when the same product has other stocked variants", () => {
  const selected = { productId: z, productType: "VARIANT", variantId: variant, quantity: 2 };
  const source = { _id: z, type: "VARIANT", isActive: true, warehouseStocks: [stock(here, 1000)], variants: [
    { _id: variant, warehouseStocks: [stock(here, 5), stock(elsewhere, 100)] },
    { _id: x, warehouseStocks: [stock(here, 100)] }] };
  assert.equal(preview({ components: [selected], products: [source] }).availableBundles, 2);
  source.variants.shift(); assert.equal(preview({ components: [selected], products: [source] }).availableBundles, 0);
});

test("inactive products and changed product types do not qualify", () => {
  for (const change of [{ isActive: false }, { isActive: undefined }, { type: "VARIANT" }]) {
    assert.equal(preview({ products: [{ ...product(z, 50), ...change }, product(x, 50)] }).availableBundles, 0);
  }
});

test("duplicate or invalid stock and variant rows cannot inflate availability", () => {
  for (const rows of [[stock(here, 100), stock(here, 100)], [stock(here, -1)], [stock(here, 1.5)],
    [stock(here, Number.MAX_SAFE_INTEGER + 1)], [stock(here, "100")], null]) {
    assert.equal(preview({ products: [{ ...product(z, 50), warehouseStocks: rows }, product(x, 50)] }).availableBundles, 0);
  }
  const row = { _id: variant, warehouseStocks: [stock(here, 50)] };
  assert.equal(preview({ components: [{ productId: z, productType: "VARIANT", variantId: variant, quantity: 1 }],
    products: [{ _id: z, type: "VARIANT", isActive: true, variants: [row, row] }] }).availableBundles, 0);
});

test("ambiguous product snapshots fail rather than choosing one source", () => {
  for (const products of [null, [product(z, 10), product(z.toUpperCase(), 100)], [{ type: "SIMPLE" }]]) {
    assert.throws(() => preview({ products }), { code: "BUNDLE_INVALID_SOURCE", statusCode: 503 });
  }
});

test("explicit price is retained in integer piastres without applying component promotions", () => {
  const value = preview({ products: [{ ...product(z, 7), price: 900, discountedPrice: 1 }, product(x, 12)] });
  assert.equal(value.pricePiastres, 12500); assert.equal(value.currency, "EGP");
  for (const pricePiastres of [null, "12500", -1, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => preview({ pricePiastres }), { code: "BUNDLE_INVALID_PRICE" });
  }
});

test("the estimate does not modify supplied component quantities, stock, revisions or prices", () => {
  const input = { components: [simple(z, 2)], pricePiastres: 10000, warehouseId: here, products: [product(z, 7)] };
  const before = structuredClone(input);
  const result = previewFixedBundle(input); result.components[0].quantity = 50;
  assert.deepEqual(input, before);
});
