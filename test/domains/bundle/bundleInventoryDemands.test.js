import assert from "node:assert/strict";
import test from "node:test";
import { buildFixedBundleInventoryDemands } from "../../../src/domains/bundle/bundle.inventory-demands.js";
import { aggregateInventoryDemands } from "../../../src/domains/inventory/inventory.service.js";

const x = "a00000000000000000000001", y = "a00000000000000000000002";
const firstVariant = "b00000000000000000000001", secondVariant = "b00000000000000000000002";
const here = "c00000000000000000000001", elsewhere = "c00000000000000000000002";
const simple = (productId, quantity) => ({ productId, productType: "SIMPLE", quantity });
const input = () => ({ warehouseId: here, quantity: 3, components: [simple(x, 2), simple(y, 3)] });

test("complete bundle counts expand every fixed component using the existing inventory demand shape", () => {
  assert.deepEqual(buildFixedBundleInventoryDemands(input()), { warehouseId: here, demands: [
    { productId: x, productType: "SIMPLE", variantId: null, quantity: 6 },
    { productId: y, productType: "SIMPLE", variantId: null, quantity: 9 },
  ] });
});

test("duplicate exact SKUs combine before expansion without combining different variants", () => {
  const components = [simple(x.toUpperCase(), 1), simple(x, 2),
    { productId: y, productType: "VARIANT", variantId: firstVariant, quantity: 2 },
    { productId: y, productType: "VARIANT", variantId: secondVariant, quantity: 1 }];
  const { demands } = buildFixedBundleInventoryDemands({ warehouseId: here.toUpperCase(), quantity: 2, components });
  assert.deepEqual(demands.map(row => [row.productId, row.variantId, row.quantity]), [
    [x, null, 6], [y, firstVariant, 4], [y, secondVariant, 2],
  ]);
});

test("an explicit warehouse is retained independently for every demand set", () => {
  const first = buildFixedBundleInventoryDemands(input());
  const second = buildFixedBundleInventoryDemands({ ...input(), warehouseId: elsewhere.toUpperCase() });
  assert.equal(first.warehouseId, here); assert.equal(second.warehouseId, elsewhere);
  for (const warehouseId of [undefined, null, "", "all", [here, elsewhere], { warehouseId: here }, here + " "]) {
    assert.throws(() => buildFixedBundleInventoryDemands({ ...input(), warehouseId }), { code: "BUNDLE_INVALID_WAREHOUSE" });
  }
});

test("zero, fractional, coerced, negative and unsafe complete-bundle quantities are rejected", () => {
  for (const quantity of [undefined, null, 0, -1, 1.5, "3", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildFixedBundleInventoryDemands({ ...input(), quantity }), { code: "BUNDLE_INVALID_QUANTITY" });
  }
});

test("unsafe expanded or combined component quantities cannot reach inventory mutation", () => {
  assert.equal(buildFixedBundleInventoryDemands({ warehouseId: here, quantity: Number.MAX_SAFE_INTEGER,
    components: [simple(x, 1)] }).demands[0].quantity, Number.MAX_SAFE_INTEGER);
  assert.throws(() => buildFixedBundleInventoryDemands({ warehouseId: here, quantity: 2,
    components: [simple(x, Number.MAX_SAFE_INTEGER)] }), { code: "BUNDLE_INVALID_QUANTITY" });
  assert.throws(() => buildFixedBundleInventoryDemands({ warehouseId: here, quantity: 1,
    components: [simple(x, Number.MAX_SAFE_INTEGER), simple(x, 1)] }), { code: "BUNDLE_INVALID_COMPONENTS" });
});

test("malformed definitions retain the existing exact product and variant validation", () => {
  for (const components of [null, [], [simple("bad", 1)], [{ ...simple(x, 1), variantId: firstVariant }],
    [{ productId: y, productType: "VARIANT", quantity: 1 }], [{ ...simple(x, 1), warehouseId: elsewhere }]]) {
    assert.throws(() => buildFixedBundleInventoryDemands({ ...input(), components }), { code: "BUNDLE_INVALID_COMPONENTS" });
  }
});

test("bundle and standalone SKU demands aggregate together without losing exact variant identity", () => {
  const one = buildFixedBundleInventoryDemands(input());
  const two = buildFixedBundleInventoryDemands({ warehouseId: here, quantity: 2, components: [simple(x, 1),
    { productId: y, productType: "VARIANT", variantId: firstVariant, quantity: 2 }] });
  const combined = aggregateInventoryDemands([...one.demands, ...two.demands, simple(x, 4)]);
  assert.deepEqual(combined.map(({ productId, variantId, quantity }) => [productId, variantId, quantity]), [
    [x, null, 12], [y, null, 9], [y, firstVariant, 4],
  ]);
});

test("expansion does not mutate definitions and returned arrays do not alias later calls", () => {
  const source = input(), before = structuredClone(source);
  const expanded = buildFixedBundleInventoryDemands(source); expanded.demands[0].quantity = 99;
  assert.deepEqual(source, before);
  assert.equal(buildFixedBundleInventoryDemands(source).demands[0].quantity, 6);
});
