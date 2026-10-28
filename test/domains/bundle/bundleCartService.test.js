import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { getBundleCartView } from "../../../src/domains/bundle/bundle.cart-service.js";

function cart(t, options) {
  const s = fixture(t, options); s.config = { bundleCartEnabled: true };
  if (s.cart) s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 2, unitPricePiastres: 1500 }];
  s.args = { warehouseId: W, language: "en" }; s.deletes = []; s.ends = 0; s.aborts = 0;
  s.view = (args = s.args, session = s.session) => getBundleCartView(s.actor, args, s.config, { session });
  s.session.withTransaction = async (callback, options) => {
    assert.deepEqual(options.readConcern, { level: "snapshot" }); assert.deepEqual(options.writeConcern, { w: "majority" });
    const before = clone({ cart: s.cart, user: s.user, receipts: s.receipts });
    try { const result = await callback(); if (s.loseResponse) throw Error("lost committed response"); return result; }
    catch (error) { if (error.message !== "lost committed response") { Object.assign(s, before); s.aborts++; } throw error; }
  };
  s.session.endSession = async () => { s.ends++; };
  t.mock.method(mongoose, "startSession", async () => s.session);
  return s;
}

test("bundle view preserves separate commercial lines and sums ordinary plus bundle prices once", async t => {
  const s = cart(t, { ordinary: true }), before = clone(s.cart), view = await s.view();
  assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []); assert.equal(view.bundles.length, 1); assert.equal(view.items.length, 1);
  assert.equal(view.bundles[0].type, "BUNDLE"); assert.equal(view.bundles[0].quantity, 2); assert.equal(view.bundles[0].components[0].quantity, 2);
  assert.equal(view.bundles[0].itemPrice, 15); assert.equal(view.bundles[0].lineTotal, 30); assert.equal(view.totalCartPrice, 50);
  assert.equal(view.bundleSubtotal, 30); assert.equal(view.ordinarySubtotal, 20); assert.equal(view.pricingScope, "items_only");
  assert.equal(view.pricingStatus, "review_required"); assert.equal(view.ordinaryRefreshRequired, true); assert.equal(view.checkoutSupported, false);
  assert.equal(view.deliveryAddress.name, "Keep address"); assert.equal(view.version, 7); assert.equal(view.id, String(s.cart._id));
});

test("view omits internal request patches, allocations, receipts and checkout authority", async t => {
  const s = cart(t); const view = await s.view();
  assert.equal(view.pricingStatus, "ready"); assert.equal(view.totalCartPrice, 30);
  for (const key of ["patch", "demands", "owner", "checkoutKey", "guestId", "shippingFee", "isPrimeLocation"]) assert.equal(Object.hasOwn(view, key), false);
  assert.equal(Object.hasOwn(view.bundles[0].components[0], "allocations"), false); assert.equal(view.userId, U);
});

test("paused, missing, revised or repriced groups remain visible for removal with no trusted total", async t => {
  const s = cart(t);
  for (const change of [() => { s.definitions[0].status = "paused"; }, () => { s.definitions[0].revision = 3; },
    () => { s.definitions[0].pricePiastres = 1400; }, () => { s.definitions = []; }]) {
    const originals = clone({ definitions: s.definitions }); change(); const view = await s.view();
    assert.equal(view.bundles[0].id, G); assert.equal(view.bundles[0].status, "unavailable"); assert.equal(view.bundles[0].lineTotal, null);
    assert.deepEqual(view.bundles[0].components, []); assert.equal(view.totalCartPrice, null); assert.equal(view.pricingStatus, "unavailable");
    assert.equal(s.cart.bundles.length, 1); s.definitions = originals.definitions;
  }
});

test("cart-level stock checks aggregate ordinary and all bundle demands in the requested warehouse", async t => {
  const s = cart(t, { ordinary: true }); s.products[0].warehouseStocks[0].quantity = 5;
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 });
  const view = await s.view(); assert.equal(view.bundles[0].status, "available");
  assert.equal(view.pricingStatus, "unavailable"); assert.equal(view.reason, "BUNDLE_STOCK_CONFLICT"); assert.equal(view.totalCartPrice, null);
  assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.cart.bundles[0].quantity, 2);
});

test("malformed persisted component definitions remain visible for removal without weakening purchase guards", async t => {
  const s = cart(t);
  for (const components of [null, {}, [null], [], [{ productId: "bad", productType: "SIMPLE", quantity: 2 }],
    [{ productId: P, productType: "SIMPLE", quantity: 0 }], [{ productId: P, productType: "VARIANT", quantity: 2 }]]) {
    s.definitions[0].components = components;
    const view = await s.view(); assert.equal(view.bundles[0].id, G); assert.equal(view.bundles[0].status, "unavailable");
    assert.equal(view.totalCartPrice, null); assert.equal(s.cart.bundles.length, 1);
  }
});

test("unavailable ordinary items are reported in the private view and never pruned from storage", async t => {
  const s = cart(t, { ordinary: true }); s.cart.items[0].product = new mongoose.Types.ObjectId(OTHER);
  const view = await s.view(); assert.deepEqual(view.items, []); assert.equal(view.removedItems.length, 1);
  assert.equal(view.ordinaryRefreshRequired, true); assert.equal(s.cart.items.length, 1); assert.deepEqual(s.writes, []);
});

test("empty and ordinary-only views create no cart and invent no bundle field in stored carts", async t => {
  const s = cart(t, { existing: false }); let view = await s.view();
  assert.equal(view.id, null); assert.equal(view.version, null); assert.deepEqual(view.bundles, []); assert.equal(view.totalCartPrice, 0);
  assert.equal(s.cart, null); assert.deepEqual(s.writes, []);
  s.cart = new CartModel({ user: U, warehouse: W, __v: 0, items: [], currency: "EGP" }).toObject();
  view = await s.view(); assert.deepEqual(view.bundles, []); assert.equal(Object.hasOwn(s.cart, "bundles"), false);
});

test("a changed delivery warehouse produces a blocked view without rebinding or falling back", async t => {
  const s = cart(t); s.cart.warehouse = new mongoose.Types.ObjectId(OTHER);
  const view = await s.view(); assert.equal(view.warehouseId, W); assert.equal(view.storedWarehouseId, OTHER);
  assert.equal(view.warehouseChangeRequired, true); assert.equal(view.reason, "BUNDLE_CART_WAREHOUSE_CHANGED");
  assert.equal(view.totalCartPrice, null); assert.equal(view.checkoutSupported, false); assert.equal(String(s.cart.warehouse), OTHER);
});

test("corrupt cart versions, currency or group identities fail without returning guessed prices", async t => {
  const s = cart(t);
  for (const value of [undefined, -1, Number.MAX_SAFE_INTEGER]) {
    s.cart.__v = value; await assert.rejects(s.view(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  }
  s.cart.__v = 7; s.cart.currency = "USD"; await assert.rejects(s.view(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.cart.currency = "EGP"; s.cart.bundles.push({ ...s.cart.bundles[0] }); await assert.rejects(s.view(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
});

test("feature gate, account and input validation protect the shared view", async t => {
  const s = cart(t); s.config.bundleCartEnabled = false;
  await assert.rejects(s.view(), { code: "BUNDLE_CART_UNAVAILABLE" }); s.config.bundleCartEnabled = true;
  s.user.active = false; await assert.rejects(s.view(), { code: "BUNDLE_ACCESS_DENIED" }); s.user.active = true;
  await assert.rejects(s.view({ ...s.args, stock: 100 }), { code: "BUNDLE_INVALID_REQUEST" });
});

test("owned sessions always end and supplied inactive sessions fail before source reads", async t => {
  const s = cart(t); await s.view(s.args, null); assert.equal(s.ends, 1);
  await assert.rejects(s.view(s.args, { inTransaction: () => false }), { code: "BUNDLE_CART_TRANSACTION_REQUIRED" });
  s.user.active = false; await assert.rejects(s.view(s.args, null), { code: "BUNDLE_ACCESS_DENIED" }); assert.equal(s.ends, 2);
});
