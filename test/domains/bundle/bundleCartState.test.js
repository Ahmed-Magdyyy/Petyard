import assert from "node:assert/strict";
import test from "node:test";
import { calculateBundleCartChange } from "../../../src/domains/bundle/bundle.cart-state.js";

const owner = "a00000000000000000000001", product = "b00000000000000000000001", warehouse = "c00000000000000000000001";
const definition = "d00000000000000000000001", group = "e00000000000000000000001", cartId = "f00000000000000000000001";
const other = "a00000000000000000000002";
function fixture() {
  return { ownerId: owner, warehouseId: warehouse, warehouse: { _id: warehouse, active: true },
    cart: { _id: cartId, user: owner, warehouse, currency: "EGP", __v: 3,
      items: [{ _id: other, product, productType: "SIMPLE", quantity: 2, itemPrice: 7 }],
      deliveryAddress: { name: "Preserved", location: { lat: 31.2, lng: 29.9 } }, checkoutKey: "unchanged" },
    products: [{ _id: product, type: "SIMPLE", isActive: true, price: 10, name_en: "Food", warehouseStocks: [{ warehouse, quantity: 30 }] }],
    definitions: [{ _id: definition, origin: "manual", status: "published", revision: 2, name_en: "Pair", pricePiastres: 1500,
      components: [{ productId: product, productType: "SIMPLE", quantity: 2 }] }],
    change: { action: "add", bundleId: definition, expectedRevision: 2, quantity: 3, newGroupId: group } };
}
const saved = (f, quantity = 3) => {
  f.cart.bundles = [{ id: group, bundleId: definition, bundleRevision: 2, quantity, unitPricePiastres: 1500 }];
  return f;
};

test("add returns a minimal bundle patch and exact combined subtotal without touching ordinary items or address", () => {
  const f = fixture(), before = structuredClone(f), quote = calculateBundleCartChange(f);
  assert.equal(quote.cartId, cartId); assert.equal(quote.expectedCartVersion, 3);
  assert.equal(quote.ordinarySubtotalPiastres, 1400); assert.equal(quote.bundleSubtotalPiastres, 4500);
  assert.equal(quote.itemsSubtotalPiastres, 5900); assert.equal(quote.patch.totalCartPrice, 59);
  assert.equal(quote.demands[0].quantity, 8); assert.deepEqual(Object.keys(quote.patch), ["bundles", "totalCartPrice"]);
  assert.deepEqual(f, before); assert.equal(quote.groupsAfter[0].quantity, 3);
});

test("missing cart can be quoted without pretending that a persistent cart/version exists", () => {
  const f = fixture(); f.cart = null;
  const quote = calculateBundleCartChange(f);
  assert.equal(quote.cartId, null); assert.equal(quote.expectedCartVersion, null);
  assert.equal(quote.ordinarySubtotalPiastres, 0); assert.equal(quote.patch.totalCartPrice, 45);
});

test("adding an existing definition increments complete bundles and retains stable group identity", () => {
  const f = saved(fixture(), 1); f.change.newGroupId = other;
  const quote = calculateBundleCartChange(f);
  assert.equal(quote.groupsAfter.length, 1); assert.equal(quote.groupsAfter[0].id, group); assert.equal(quote.groupsAfter[0].quantity, 4);
  assert.equal(quote.groupsBefore[0].quantity, 1); assert.equal(f.cart.bundles[0].quantity, 1);
});

test("quantity set is absolute and zero is rejected rather than silently becoming removal", () => {
  const f = saved(fixture()); f.change = { action: "set", groupId: group, quantity: 1 };
  assert.equal(calculateBundleCartChange(f).patch.totalCartPrice, 29);
  f.change.quantity = 0; assert.throws(() => calculateBundleCartChange(f), { statusCode: 400 });
});

test("last group can be removed even when its old definition is deleted, paused or repriced", () => {
  const f = saved(fixture()); f.change = { action: "remove", groupId: group }; f.definitions = [];
  const quote = calculateBundleCartChange(f);
  assert.deepEqual(quote.groupsAfter, []); assert.equal(quote.patch.totalCartPrice, 14);
  assert.equal(quote.demands[0].quantity, 2);
  f.cart.items = [];
  const empty = calculateBundleCartChange(f); assert.deepEqual(empty.demands, []); assert.equal(empty.patch.totalCartPrice, 0);
});

test("set/remove unknown group returns a bounded not-found error", () => {
  for (const action of ["set", "remove"]) {
    const f = saved(fixture()); f.change = { action, groupId: other, ...(action === "set" ? { quantity: 1 } : {}) };
    assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_GROUP_NOT_FOUND", statusCode: 404 });
  }
});

test("changed price or revision never silently refreshes an existing group", () => {
  const f = saved(fixture()); f.definitions[0].pricePiastres = 1600;
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  f.definitions[0].pricePiastres = 1500; f.definitions[0].revision++;
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_REVISION_CONFLICT" });
});

test("foreign/guest ownership, changed warehouse, invalid currency or exhausted version fail closed", () => {
  for (const changes of [{ user: other }, { guestId: "guest" }]) {
    const f = fixture(); Object.assign(f.cart, changes);
    assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_NOT_FOUND" });
  }
  for (const changes of [{ warehouse: other }, { currency: "USD" }, { __v: -1 }, { __v: Number.MAX_SAFE_INTEGER }, { items: null }]) {
    const f = fixture(); Object.assign(f.cart, changes);
    assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  }
});

test("aggregate stock includes ordinary quantity and prior bundles, without silently pruning either", () => {
  const f = fixture(); f.products[0].warehouseStocks[0].quantity = 7;
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_STOCK_CONFLICT" });
  assert.equal(f.cart.items[0].quantity, 2);
  f.products[0].warehouseStocks.push({ warehouse: other, quantity: 1000 });
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_STOCK_CONFLICT" });
});

test("ambiguous definitions, duplicate saved group identities and malformed quantities do not select arbitrary sources", () => {
  const f = fixture(); f.definitions.push(structuredClone(f.definitions[0]));
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  const duplicate = saved(fixture()); duplicate.cart.bundles.push({ ...duplicate.cart.bundles[0], id: other });
  assert.throws(() => calculateBundleCartChange(duplicate), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  for (const value of [null, {}, "bad"]) {
    const invalid = fixture(); invalid.cart.bundles = value;
    assert.throws(() => calculateBundleCartChange(invalid), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  }
});

test("unknown action/input fields, unsafe combined quantities and unsafe full-cart amounts are rejected", () => {
  for (const change of [null, { action: "clear" }, { ...fixture().change, price: 1 }, { ...fixture().change, quantity: "3" }]) {
    assert.throws(() => calculateBundleCartChange({ ...fixture(), change }), { statusCode: 400 });
  }
  const huge = saved(fixture(), Number.MAX_SAFE_INTEGER);
  assert.throws(() => calculateBundleCartChange(huge), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  const expensive = fixture(); expensive.cart.items[0].itemPrice = 90000000000000;
  expensive.cart.items[0].quantity = 2;
  assert.throws(() => calculateBundleCartChange(expensive), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
});

test("return arrays and patch are independent copies and language remains explicit", () => {
  const f = fixture(), quote = calculateBundleCartChange(f);
  quote.patch.bundles[0].quantity = 100; assert.equal(quote.groupsAfter[0].quantity, 3);
  quote.groups[0].components[0].quantity = 99; assert.equal(f.definitions[0].components[0].quantity, 2);
  assert.throws(() => calculateBundleCartChange({ ...f, language: "arabizi" }), { statusCode: 400 });
});

test("removal validates surviving groups without requiring the removed definition", () => {
  const f = saved(fixture());
  f.cart.bundles.push({ id: other, bundleId: other, bundleRevision: 1, quantity: 1, unitPricePiastres: 1000 });
  f.definitions = [{ ...f.definitions[0], _id: other, revision: 1, pricePiastres: 1000 }];
  f.change = { action: "remove", groupId: group };
  const result = calculateBundleCartChange(f);
  assert.equal(result.groupsAfter.length, 1); assert.equal(result.groupsAfter[0].id, other);
  assert.equal(result.patch.totalCartPrice, 24);
  f.definitions[0].status = "paused";
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_PURCHASE_UNAVAILABLE" });
});

test("ordinary item material remains part of the review even when its subtotal does not change", () => {
  const first = fixture(), second = fixture();
  second.cart.items[0].quantity = 1; second.cart.items[0].itemPrice = 14;
  const one = calculateBundleCartChange(first), two = calculateBundleCartChange(second);
  assert.equal(one.itemsSubtotalPiastres, two.itemsSubtotalPiastres);
  assert.notDeepEqual(one.ordinaryItems, two.ordinaryItems);
  assert.deepEqual(one.ordinaryItems[0], { id: other, productId: product, productType: "SIMPLE", variantId: null, quantity: 2, unitPricePiastres: 700 });
});

test("removal does not waive ordinary stock or malformed item validation", () => {
  const f = saved(fixture()); f.change = { action: "remove", groupId: group };
  f.products[0].warehouseStocks[0].quantity = 1;
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  const duplicate = saved(fixture()); duplicate.cart.items.push(structuredClone(duplicate.cart.items[0]));
  assert.throws(() => calculateBundleCartChange(duplicate), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  const invalid = fixture(); invalid.cart.items[0].itemPrice = NaN;
  assert.throws(() => calculateBundleCartChange(invalid), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
});

test("maintenance fallback and mismatched resolved warehouse never reroute a bundle cart change", () => {
  const f = fixture(); f.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse: other };
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  f.warehouse.fulfillment.status = "OPERATIONAL"; f.warehouse._id = other;
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
});

test("paused current definition cannot be added and saved price is mandatory", () => {
  const f = fixture(); f.definitions[0].status = "paused";
  assert.throws(() => calculateBundleCartChange(f), { code: "BUNDLE_PURCHASE_UNAVAILABLE" });
  const invalid = saved(fixture()); delete invalid.cart.bundles[0].unitPricePiastres;
  assert.throws(() => calculateBundleCartChange(invalid), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
});
