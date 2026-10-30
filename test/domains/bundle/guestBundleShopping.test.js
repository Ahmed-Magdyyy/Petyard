import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import mongoose from "mongoose";
import { fixture, W, P, B, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { AddressModel } from "../../../src/domains/address/address.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { getCartService, upsertCartBundleService, updateCartBundleService, removeCartBundleService,
  upsertCartItemService, updateCartItemQuantityService, removeCartItemService, clearCartService,
  rebindCartWithBundlesService, setCartAddressForGuestService } from "../../../src/domains/cart/cart.service.js";
import { getCheckoutSummaryService } from "../../../src/domains/checkout/checkout.service.js";
import { stageBundleCartChangeWithReceipt } from "../../../src/domains/bundle/bundle.cart-transaction.js";
import cartRouter from "../../../src/domains/cart/cart.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";

function setup(t, options = {}) {
  const s = fixture(t, { ordinary: true, ...options, guest: true });
  for (const [key, value] of Object.entries({ ASSISTANT_BUNDLE_CART_ENABLED: "true", NODE_ENV: "test", REDIS_URL: "" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  s.warehouse.defaultShippingPrice = 50;
  s.address = { _id: new mongoose.Types.ObjectId(OTHER), user: null, guestId: s.guestId,
    warehouse: new mongoose.Types.ObjectId(W), name: "Guest", governorate: "Alexandria", phone: "01012345678",
    building: "1", floor: "2", apartment: "3", details: "Fixture", location: { lat: 30, lng: 31 } };
  if (s.cart) s.cart.deliveryAddress = undefined;
  const query = read => { let session; return { select() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
    session(value) { session = value; return this; }, then(resolve, reject) {
      if (session != null) assert.equal(session, s.session);
      return Promise.resolve().then(() => read(session)).then(resolve, reject);
    } }; };
  t.mock.method(CartModel, "findOne", filter => query(() => {
    if (filter.user != null || filter.guestId !== s.guestId) return null;
    return s.cart && (filter._id == null || String(filter._id) === String(s.cart._id)) ? clone(s.cart) : null;
  }));
  t.mock.method(WarehouseModel, "findById", id => query(() => (s.warehouses ?? [s.warehouse]).find(row => String(row._id) === String(id)) ?? null));
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("Guest bundles must not choose a fallback warehouse"));
  t.mock.method(ProductModel, "find", filter => query(() => {
    if (filter.$or) assert.equal(String(filter.$or[0].warehouseStocks.$elemMatch.warehouse), s.selectedWarehouse ?? W);
    return s.products.filter(row => filter._id.$in.some(id => String(row._id) === String(id)));
  }));
  t.mock.method(UserModel, "findById", () => assert.fail("Guest shopping must not load a user account"));
  t.mock.method(UserModel, "updateOne", () => assert.fail("Guest shopping must not debit a user wallet"));
  t.mock.method(AddressModel, "findOne", filter => query(() => {
    assert.equal(filter.user, null); assert.equal(filter.guestId, s.guestId);
    return String(filter._id) === String(s.address._id) && s.address.guestId === s.guestId ? clone(s.address) : null;
  }));
  t.mock.method(AddressModel.collection, "updateOne", async filter => {
    assert.equal(filter.user, null); assert.equal(filter.guestId, s.guestId);
    s.addressWrites = (s.addressWrites ?? 0) + 1; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "deleteOne", async (filter, { session }) => {
    assert.equal(session, s.session); s.assertOwnerFilter(filter);
    if (!s.cart || !mongoose.mongo.BSON.serialize(s.cart).equals(mongoose.mongo.BSON.serialize(filter.$expr.$eq[1].$literal))) return { deletedCount: 0 };
    s.cart = null; return { deletedCount: 1 };
  });
  s.session.withTransaction = fn => fn();
  s.session.endSession = async () => {};
  t.mock.method(mongoose, "startSession", async () => s.session);
  s.run = fn => { s.expectedCartVersion = s.cart?.__v; return fn(); };
  s.input = changes => ({ guestId: s.guestId, warehouseId: W, lang: "en", ...changes });
  s.add = changes => s.run(() => upsertCartBundleService(s.input({ bundleId: B, expectedRevision: 2, quantity: 2, ...changes })));
  return s;
}

test("guest add, increment, set, ordinary edits, remove and clear use one existing cart without reserving stock", async t => {
  const s = setup(t), stock = clone({ products: s.products }).products;
  let view = await s.add(); assert.equal(view.guestId, s.guestId); assert.equal(view.userId, null);
  assert.equal(view.totalCartPrice, 50); assert.equal(view.bundles[0].quantity, 2);
  view = await s.add({ quantity: 1 }); assert.equal(view.bundles[0].quantity, 3);
  const groupId = view.bundles[0].id;
  view = await s.run(() => updateCartBundleService(s.input({ groupId, quantity: 1 })));
  assert.equal(view.totalCartPrice, 35);
  view = await s.run(() => upsertCartItemService(s.input({ productId: P, productType: "SIMPLE", quantity: 1 })));
  assert.equal(view.items[0].quantity, 3);
  const itemId = view.items[0].id;
  view = await s.run(() => updateCartItemQuantityService(s.input({ itemId, quantity: 1 })));
  assert.equal(view.totalCartPrice, 25);
  view = await s.run(() => removeCartItemService(s.input({ itemId })));
  assert.equal(view.items.length, 0); assert.equal(view.bundles.length, 1);
  view = await getCartService(s.input()); assert.equal(view.checkoutSupported, true);
  view = await s.run(() => removeCartBundleService(s.input({ groupId })));
  assert.equal(view.totalCartPrice, 0); assert.equal(view.bundles.length, 0);
  await s.add({ quantity: 1 });
  await clearCartService(s.input()); assert.equal(s.cart, null);
  assert.deepEqual(s.products, stock); assert.deepEqual(s.receipts, []);
});

test("first guest bundle addition creates a guest-owned cart with the existing checkout key", async t => {
  const s = setup(t, { existing: false, ordinary: false });
  const view = await s.add();
  assert.equal(view.userId, null); assert.equal(view.guestId, s.guestId);
  assert.equal(view.items.length, 0); assert.equal(view.bundles.length, 1);
  assert.ok(s.cart.checkoutKey); assert.equal(s.cart.user, null);
});

test("guest cart writes require unique guest ownership and reject other guests without any write", async t => {
  const s = setup(t);
  s.cartIndexes = s.cartIndexes.filter(row => !row.key.guestId);
  await assert.rejects(s.add(), { statusCode: 503 }); assert.deepEqual(s.writes, []);
  s.cartIndexes.push({ key: { guestId: 1 }, unique: true, partialFilterExpression: { guestId: { $type: "string" }, user: null } });
  const view = await s.add(), before = clone(s.cart), writes = s.writes.length;
  await assert.rejects(updateCartBundleService(s.input({ guestId: "another-guest", groupId: view.bundles[0].id, quantity: 1 })), { statusCode: 404 });
  assert.deepEqual(s.cart, before); assert.equal(s.writes.length, writes);
  await assert.rejects(upsertCartBundleService(s.input({ userId: OTHER, bundleId: B, expectedRevision: 2, quantity: 1 })), { statusCode: 400 });
});

test("guest combined demand and warehouse changes cannot use another warehouse's stock", async t => {
  const s = setup(t); s.products[0].warehouseStocks = [{ warehouse: W, quantity: 4 }, { warehouse: OTHER, quantity: 1000 }];
  await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.writes, []);
  s.products[0].warehouseStocks[0].quantity = 30; await s.add();
  s.warehouses = [s.warehouse, { _id: OTHER, active: true }]; s.selectedWarehouse = OTHER;
  s.products[0].warehouseStocks[1].quantity = 0;
  await assert.rejects(rebindCartWithBundlesService(s.input({ warehouseId: OTHER })), { statusCode: 409 });
  assert.equal(String(s.cart.warehouse), W);
});

test("guest bundle address and checkout keep ownership, selected warehouse, price and zero wallet benefits", async t => {
  const s = setup(t); await s.add();
  await assert.rejects(setCartAddressForGuestService({ guestId: s.guestId, guestAddressId: OTHER }), { statusCode: 400 });
  await s.run(() => setCartAddressForGuestService({ guestId: s.guestId, guestAddressId: OTHER, warehouseId: W }));
  assert.equal(s.addressWrites, 1); assert.equal(String(s.cart.deliveryAddress.guestAddressId), OTHER);
  const view = await getCheckoutSummaryService(s.input());
  assert.equal(view.bundles.length, 1); assert.equal(view.checkoutSupported, true);
  assert.equal(view.pricing.subtotal, 50); assert.equal(view.pricing.walletUsed, 0);
  assert.equal(view.pricing.finalTotal, 100);
  s.address.guestId = "another-guest";
  await assert.rejects(s.run(() => setCartAddressForGuestService({ guestId: s.guestId, guestAddressId: OTHER, warehouseId: W })), { statusCode: 404 });
});

test("guest direct shopping cannot invoke assistant confirmation receipts", async t => {
  const s = setup(t);
  await assert.rejects(stageBundleCartChangeWithReceipt({ guestId: s.guestId }, {}, {}, { session: s.session }), { statusCode: 401 });
  assert.deepEqual(s.writes, []); assert.deepEqual(s.receipts, []);
});

test("guest bundle HTTP mutations use x-guest-id without a bearer token and retain strict validation", async t => {
  const s = setup(t), app = express(); app.use(express.json()); app.use("/cart", cartRouter); app.use(globalError);
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/cart/guest/${W}/bundles`;
  const send = async (body, guestId = s.guestId) => {
    s.expectedCartVersion = s.cart.__v;
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...(guestId ? { "x-guest-id": guestId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const body = { bundleId: B, expectedRevision: 2, quantity: 1 };
  assert.equal((await send(body, "")).status, 400);
  assert.equal((await send({ ...body, quantity: "1" })).status, 400);
  assert.equal((await send({ ...body, guestId: "another-guest" })).status, 400);
  const result = await send(body); assert.equal(result.status, 200); assert.equal(result.body.data.bundles.length, 1);
});
