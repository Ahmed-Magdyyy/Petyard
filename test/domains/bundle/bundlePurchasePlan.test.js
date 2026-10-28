import assert from "node:assert/strict";
import test from "node:test";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";

const x = "a00000000000000000000001", y = "a00000000000000000000002", v = "b00000000000000000000001";
const here = "c00000000000000000000001", elsewhere = "c00000000000000000000002";
const bid = "d00000000000000000000001", group = "e00000000000000000000001", second = "e00000000000000000000002";
const simple = (product, quantity) => ({ product, productType: "SIMPLE", quantity });
function fixture() {
  const bundle = { _id: bid, origin: "manual", status: "published", revision: 1, name_en: "X/Y", pricePiastres: 1000,
    components: [{ productId: x, productType: "SIMPLE", quantity: 2 }, { productId: y, productType: "VARIANT", variantId: v, quantity: 1 }] };
  return { warehouseId: here, warehouse: { _id: here, active: true }, ordinaryItems: [simple(x, 3)],
    bundles: [{ groupId: group, bundle, expectedRevision: 1, quantity: 2 }],
    products: [{ _id: x, type: "SIMPLE", isActive: true, price: 10, name_en: "X", warehouseStocks: [{ warehouse: here, quantity: 9 }] },
      { _id: y, type: "VARIANT", isActive: true, name_en: "Y", variants: [{ _id: v, price: 10, warehouseStocks: [{ warehouse: here, quantity: 6 }] }] }] };
}

test("mixed plans combine physical SKU demand while preserving separate bundle groups and ordinary inputs", () => {
  const f = fixture(), before = structuredClone(f), result = buildBundleCartPurchasePlan(f);
  assert.equal(result.warehouseId, here); assert.equal(result.bundleSubtotalPiastres, 2000);
  assert.deepEqual(result.demands, [{ productId: x, productType: "SIMPLE", variantId: null, quantity: 7 },
    { productId: y, productType: "VARIANT", variantId: v, quantity: 2 }]);
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].id, group);
  assert.ok(result.itemDrafts.every(row => row.bundleGroupId === group));
  assert.deepEqual(f, before);
});

test("standalone and bundle lines cannot independently spend the same warehouse stock", () => {
  const f = fixture(); f.ordinaryItems = [simple(x, 6)];
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_STOCK_CONFLICT" });
  f.products[0].warehouseStocks.push({ warehouse: elsewhere, quantity: 1000 });
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_STOCK_CONFLICT" });
  f.ordinaryItems = [simple(x, 5)]; assert.equal(buildBundleCartPurchasePlan(f).demands[0].quantity, 9);
});

test("different bundle groups also contend for shared exact SKUs", () => {
  const f = fixture(); f.ordinaryItems = [];
  f.bundles.push({ ...structuredClone(f.bundles[0]), groupId: second, quantity: 3 });
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_STOCK_CONFLICT" });
  f.bundles[1].quantity = 2; const result = buildBundleCartPurchasePlan(f);
  assert.equal(result.groups.length, 2); assert.equal(result.bundleSubtotalPiastres, 4000);
  assert.equal(result.demands[0].quantity, 8);
});

test("standalone exact variants combine with bundle variants without accepting other-variant stock", () => {
  const f = fixture(); f.ordinaryItems = [{ product: y, productType: "VARIANT", variantId: v, quantity: 5 }];
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_STOCK_CONFLICT" });
  f.products[1].variants.push({ _id: x, price: 1, warehouseStocks: [{ warehouse: here, quantity: 1000 }] });
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_STOCK_CONFLICT" });
  f.ordinaryItems[0].quantity = 4;
  assert.equal(buildBundleCartPurchasePlan(f).demands.find(row => row.variantId === v).quantity, 6);
});

test("bundle-only carts work but this planner does not replace ordinary-only cart behavior", () => {
  const f = fixture(); delete f.ordinaryItems;
  assert.equal(buildBundleCartPurchasePlan(f).bundleSubtotalPiastres, 2000);
  for (const bundles of [undefined, null, [], [null]]) {
    assert.throws(() => buildBundleCartPurchasePlan({ ...f, bundles }), { code: "BUNDLE_PURCHASE_INVALID" });
  }
});

test("duplicate group identity and malformed ordinary items are rejected without mutating inputs", () => {
  const f = fixture(); f.bundles.push(structuredClone(f.bundles[0]));
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_PURCHASE_INVALID" });
  for (const ordinaryItems of [null, [null], [simple(x, 0)], [{ ...simple(x, 1), variantId: v }]]) {
    assert.throws(() => buildBundleCartPurchasePlan({ ...fixture(), ordinaryItems }));
  }
});

test("combined quantity and bundle subtotal overflow fail before any inventory operation", () => {
  const f = fixture(); f.ordinaryItems = [simple(x, Number.MAX_SAFE_INTEGER)];
  assert.throws(() => buildBundleCartPurchasePlan(f), { code: "BUNDLE_INVALID_COMPONENTS" });
  const large = fixture(); large.ordinaryItems = []; large.products[0].price = 40000000000000;
  large.bundles[0].bundle.components = [{ productId: x, productType: "SIMPLE", quantity: 1 }];
  large.bundles[0].bundle.pricePiastres = 4000000000000000; large.bundles[0].quantity = 2;
  large.bundles.push({ ...structuredClone(large.bundles[0]), groupId: second, quantity: 1 });
  assert.throws(() => buildBundleCartPurchasePlan(large), { code: "BUNDLE_PURCHASE_OVERFLOW" });
});

test("ordinary items are still checked for active exact-SKU availability in the selected warehouse", () => {
  for (const item of [simple(bid, 1), { product: y, productType: "VARIANT", variantId: bid, quantity: 1 }]) {
    assert.throws(() => buildBundleCartPurchasePlan({ ...fixture(), ordinaryItems: [item] }), { code: "BUNDLE_STOCK_CONFLICT" });
  }
});
