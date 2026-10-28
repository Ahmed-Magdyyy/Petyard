import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { AddressModel } from "../../../src/domains/address/address.model.js";
import { assertOrdinaryCart, ordinaryCartFilter } from "../../../src/domains/cart/cart.bundle-compatibility.js";
import { getCartService, upsertCartItemService, updateCartItemQuantityService, removeCartItemService, clearCartService,
  mergeGuestCartService, rebindCartToWarehouse, previewCurrentUserCartService, previewCartAdditionService,
  setCartAddressFromUserService, mapCartToResponse } from "../../../src/domains/cart/cart.service.js";
import { createOrderForUserService, reorderService } from "../../../src/domains/order/order.service.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { getCheckoutSummaryService, applyCouponAtCheckoutService } from "../../../src/domains/checkout/checkout.service.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const C = "444444444444444444444444", G = "555555555555555555555555", B = "666666666666666666666666";
const row = () => ({ id: G, bundleId: B, bundleRevision: 1, quantity: 2, unitPricePiastres: 1500 });
const raw = () => ({ _id: C, user: U, warehouse: W, currency: "EGP", __v: 2,
  items: [{ _id: P, product: P, productType: "SIMPLE", quantity: 1, itemPrice: 10 }], bundles: [row()], totalCartPrice: 40 });
const predicate = { $or: [{ bundles: { $exists: false } }, { bundles: { $size: 0 } }] };
const query = value => ({ select() { return this; }, lean() { return this; }, session() { return this; }, populate() { return this; },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

function fixture(t) {
  const state = { cart: CartModel.hydrate(raw()), writes: 0 };
  t.mock.method(CartModel, "findOne", () => query(state.cart));
  t.mock.method(ProductModel, "findById", () => query({ _id: P, type: "SIMPLE", isActive: true, price: 10, warehouseStocks: [{ warehouse: W, quantity: 100 }] }));
  t.mock.method(WarehouseModel, "findById", () => query({ _id: W, active: true }));
  t.mock.method(AddressModel, "findOne", () => query({ _id: P, user: U, warehouse: W, name: "New" }));
  for (const method of ["insertOne", "updateOne", "deleteOne"]) t.mock.method(CartModel.collection, method, () => { state.writes++; assert.fail("unsupported bundle flow must not write"); });
  return state;
}

test("schema adds no default bundle field or index to ordinary historical carts", async () => {
  const data = raw(); delete data.bundles;
  const doc = CartModel.hydrate(data);
  assert.equal(doc.bundles, undefined); assert.equal(doc.toObject().bundles, undefined);
  await doc.validate();
  assert.equal(CartModel.schema.indexes().some(([keys]) => Object.keys(keys).some(key => key.includes("bundle"))), false);
  const stored = CartModel.hydrate(raw()); await stored.validate();
  assert.deepEqual(stored.bundles[0].toObject(), row());
});

test("stored group schema rejects duplicate identities, unknown properties and unsafe required values", async () => {
  for (const modify of [data => { data.bundles.push(row()); }, data => { data.bundles[0].quantity = 0; },
    data => { data.bundles[0].bundleRevision = 1.5; }, data => { data.bundles[0].unitPricePiastres = Number.MAX_SAFE_INTEGER + 1; },
    data => { delete data.bundles[0].bundleId; }, data => { data.bundles[0].price = 1; }]) {
    const data = raw(); modify(data); const doc = new CartModel(data);
    await assert.rejects(doc.validate());
  }
});

test("ordinary guard allows absent or empty arrays and rejects groups or malformed state", () => {
  for (const value of [null, {}, { bundles: [] }]) assertOrdinaryCart(value);
  for (const bundles of [[row()], null, {}, "bad"]) assert.throws(() => assertOrdinaryCart({ bundles }), { code: "BUNDLE_CART_FLOW_REQUIRED", statusCode: 409 });
});

test("query filter retains ownership and existing clauses without mutating its input", () => {
  const original = { user: U, $and: [{ __v: 2 }] }, before = structuredClone(original);
  assert.deepEqual(ordinaryCartFilter(original), { user: U, $and: [{ __v: 2 }, predicate] });
  assert.deepEqual(original, before);
});

test("ordinary read/add/edit/remove/clear/merge/preview refuse before cart writes or key backfill", async t => {
  const state = fixture(t), args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 1, itemId: P };
  for (const action of [() => getCartService(args), () => upsertCartItemService(args), () => updateCartItemQuantityService(args),
    () => removeCartItemService(args), () => clearCartService(args), () => mergeGuestCartService({ ...args, guestId: "legacy-guest" }),
    () => previewCurrentUserCartService(args), () => previewCartAdditionService(args), () => rebindCartToWarehouse(state.cart, W)]) {
    await assert.rejects(action(), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  }
  assert.equal(state.writes, 0); assert.equal(state.cart.checkoutKey, undefined); assert.equal(state.cart.bundles[0].quantity, 2);
});

test("address selection cannot save or rebind a bundle-containing cart through the ordinary flow", async t => {
  const state = fixture(t);
  await assert.rejects(setCartAddressFromUserService({ userId: U, userAddressId: P }), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  assert.equal(state.writes, 0);
});

test("normal checkout and coupon application do not turn bundle state into an ordinary summary", async t => {
  const state = fixture(t);
  await assert.rejects(getCheckoutSummaryService({ userId: U }), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  await assert.rejects(applyCouponAtCheckoutService({ userId: U, couponCode: "TEST" }), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  assert.equal(state.writes, 0);
});

test("card checkout and reorder refuse unsupported bundle carts before ordinary processing", async t => {
  const state = fixture(t);
  await assert.rejects(createOrderForUserService({ userId: U, paymentMethod: "card" }), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  t.mock.method(OrderModel, "findById", () => query({ _id: P, user: U, items: [] }));
  await assert.rejects(reorderService({ userId: U, orderId: P }), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  assert.equal(state.writes, 0);
});

test("ordinary presenter refuses incomplete bundle totals instead of silently hiding groups", () => {
  assert.throws(() => mapCartToResponse(CartModel.hydrate(raw())), { code: "BUNDLE_CART_FLOW_REQUIRED" });
});

test("real Mongoose save middleware refuses existing and new bundle documents", async t => {
  for (const method of ["insertOne", "updateOne"]) t.mock.method(CartModel.collection, method, () => assert.fail("save must not reach driver"));
  for (const doc of [new CartModel(raw()), CartModel.hydrate(raw())]) await assert.rejects(doc.save(), { code: "BUNDLE_CART_FLOW_REQUIRED" });
});

test("a stale ordinary scalar save carries the no-bundles predicate to the actual driver path", async t => {
  const data = raw(); delete data.bundles;
  const doc = CartModel.hydrate(data); doc.checkoutKey = "new-key"; let captured;
  t.mock.method(CartModel.collection, "updateOne", async filter => {
    captured = filter; return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  });
  await assert.rejects(doc.save(), mongoose.Error.DocumentNotFoundError);
  assert.equal(String(captured._id), C); assert.deepEqual(captured.$and.at(-1), predicate);
});

test("ordinary bulk/query writes add an atomic no-groups filter, including payment clearing and address sync", async t => {
  const calls = [];
  for (const method of ["updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "replaceOne", "findOneAndReplace"]) {
    t.mock.method(CartModel.collection, method, async filter => { calls.push({ method, filter }); return { acknowledged: true, matchedCount: 0, deletedCount: 0 }; });
    if (["deleteOne", "deleteMany", "findOneAndDelete"].includes(method)) await CartModel[method]({ user: U });
    else if (["replaceOne", "findOneAndReplace"].includes(method)) await CartModel[method]({ user: U }, { user: U, warehouse: W, items: [] });
    else await CartModel[method]({ user: U }, { $set: { items: [], totalCartPrice: 0 } });
    const last = calls.at(-1); assert.equal(last.method, method); assert.equal(String(last.filter.user), U);
    assert.deepEqual(last.filter.$and.at(-1), predicate);
  }
});

test("clear reports a race conflict instead of success when its atomic deletion refuses the cart", async t => {
  const data = raw(); delete data.bundles;
  t.mock.method(CartModel, "findOne", () => query(CartModel.hydrate(data)));
  let writes = 0;
  t.mock.method(CartModel.collection, "deleteOne", async filter => {
    writes++; assert.deepEqual(filter.$and.at(-1), predicate); return { acknowledged: true, deletedCount: 0 };
  });
  await assert.rejects(clearCartService({ userId: U, warehouseId: W }), { statusCode: 409 });
  assert.equal(writes, 1);
});
