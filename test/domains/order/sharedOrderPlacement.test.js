import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import orderRouter from "../../../src/domains/order/order.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { paymentLimiter } from "../../../src/shared/middlewares/rateLimitMiddleware.js";
import { SavedCardModel } from "../../../src/domains/payment/savedCard.model.js";
const nativeFetch = globalThis.fetch;
import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "../bundle/fixtures/bundleCartTransaction.js";
import { processOrderCreationWithCart } from "../../../src/domains/order/order.service.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CouponModel } from "../../../src/domains/coupon/coupon.model.js";
import { WalletTransactionModel } from "../../../src/domains/wallet/walletTransaction.model.js";
import { presentOrder } from "../../../src/domains/order/order.presenter.js";

function setup(t, { ordinary = true, guest = false } = {}) {
  const s = fixture(t, { ordinary, guest });
  const previous = process.env.ASSISTANT_BUNDLE_CART_ENABLED;
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.ASSISTANT_BUNDLE_CART_ENABLED; else process.env.ASSISTANT_BUNDLE_CART_ENABLED = previous; });
  s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 2, unitPricePiastres: 1500 }];
  if (ordinary) s.cart.items[0].itemPrice = 10;
  Object.assign(s.user, { name: "Customer", phone: "01012345678", walletBalance: 10 });
  s.warehouse.defaultShippingPrice = 50;
  s.cart.deliveryAddress = { name: "Customer", governorate: "Alexandria", phone: s.user.phone,
    building: "1", floor: "2", apartment: "3", details: "Fixture", warehouse: new mongoose.Types.ObjectId(W), location: { lat: 30, lng: 31 } };
  s.orders = []; s.ledger = []; s.stockSaves = 0; s.couponUses = 0;
  s.coupon = { _id: new mongoose.Types.ObjectId(OTHER), code: "SAVE", isActive: true, discountType: "PERCENT", discountValue: 10 };
  const query = read => { let session; return { select() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
    session(value) { session = value; return this; }, then(resolve, reject) { return Promise.resolve().then(() => read(session)).then(resolve, reject); } }; };
  t.mock.method(ProductModel, "find", filter => query(session => {
    assert.equal(session, s.session);
    return s.products.filter(row => filter._id.$in.some(id => String(id) === String(row._id))).map(row => {
      row.save = async options => { assert.equal(options.session, s.session); s.stockSaves++; }; return row;
    });
  }));
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("A bundle purchase must not select a fallback warehouse"));
  t.mock.method(OrderModel, "create", async ([row], { session }) => {
    assert.equal(session, s.session); const doc = new OrderModel({ ...row, createdAt: new Date() }); await doc.validate(); s.orders.push(doc.toObject()); return [doc];
  });
  t.mock.method(OrderModel, "findOne", filter => query(() => s.orders.find(row => row.checkoutKey === filter.checkoutKey && row.status === filter.status) ?? null));
  t.mock.method(UserModel, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter._id), U);
    assert.equal(filter.walletBalance.$gte, -update.$inc.walletBalance);
    s.user.walletBalance += update.$inc.walletBalance; return { matchedCount: 1 };
  });
  t.mock.method(WalletTransactionModel, "create", async ([row], { session }) => {
    assert.equal(session, s.session); const doc = new WalletTransactionModel(row); await doc.validate(); s.ledger.push(doc.toObject()); return [doc];
  });
  t.mock.method(CouponModel, "findOne", () => query(() => s.coupon));
  t.mock.method(CouponModel, "updateOne", async (_filter, _update, { session }) => { assert.equal(session, s.session); s.couponUses++; return { matchedCount: 1 }; });
  t.mock.method(CartModel.prototype, "save", () => assert.fail("The unchanged model guard must not save a document containing bundles"));
  t.mock.method(mongoose, "connect", () => assert.fail("No database connections"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider calls"));
  t.mock.method(console, "log", () => {});
  s.snapshot = () => clone({ cart: s.cart, user: s.user, products: s.products, orders: s.orders, ledger: s.ledger, couponUses: s.couponUses });
  // Fixture-only caller transaction; native MongoDB rollback remains a separate check.
  s.place = async changes => {
    const before = s.snapshot();
    try { return await processOrderCreationWithCart({ session: s.session, cart: CartModel.hydrate(s.cart),
      orderUserId: guest ? null : U, orderGuestId: guest ? s.guestId : null, couponUserId: guest ? null : U,
      paymentMethod: "cod", lang: "en", addressUser: guest ? null : s.user, historyByUserId: guest ? undefined : U, ...changes }); }
    catch (error) { Object.assign(s, before); throw error; }
  };
  return s;
}

function assertPendingCartPreserved(cart, before) {
  assert.equal(cart.__v, before.__v + 1);
  assert.deepEqual({ ...cart, __v: before.__v }, before);
}

for (const guest of [false, true]) test(`${guest ? "guest" : "user"} bundle card preparation rechecks pending orders inside the transaction`, async t => {
  const s = setup(t, { guest });
  await s.place({ paymentMethod: "card" });
  const before = s.snapshot();
  await assert.rejects(s.place({ paymentMethod: "card" }), { statusCode: 409 });
  assert.equal(s.orders.length, 1); assert.equal(s.stockSaves, 0);
  assert.deepEqual(s.cart, before.cart); assert.deepEqual(s.ledger, []);
});

for (const method of ["cod", "pos_on_delivery", "instapay"]) test(`existing ${method} assembly prices mixed merchandise, decrements shared stock and clears one cart`, async t => {
  const s = setup(t), key = s.cart.checkoutKey;
  const order = await s.place({ paymentMethod: method, ...(method === "instapay" ? { instapayScreenshotUrls: ["https://proof.invalid/fixture.webp"] } : {}) });
  assert.equal(order.paymentMethod, method); assert.equal(order.subtotal, 50); assert.equal(order.shippingFee, 50);
  assert.equal(order.walletUsed, 10); assert.equal(order.total, 90); assert.equal(s.user.walletBalance, 0);
  assert.equal(s.products[0].warehouseStocks[0].quantity, 24); assert.equal(s.stockSaves, 1);
  assert.equal(s.ledger.length, 1); assert.equal(s.ledger[0].amount, -10);
  assert.deepEqual(s.cart.items, []); assert.equal(s.cart.bundles, undefined); assert.equal(s.cart.__v, 8);
  assert.equal(s.cart.checkoutKey, key); assert.equal(s.cart.deliveryAddress.details, "Fixture");
  const response = presentOrder(order); assert.equal(response.items.length, 1); assert.equal(response.bundles.length, 1);
  assert.equal(order.toObject().sourceCart, undefined); assert.equal(order.toObject().checkoutCart, undefined);
});

test("the existing assembler accepts a bundle as the only merchandise", async t => {
  const s = setup(t, { ordinary: false }), order = await s.place();
  assert.equal(order.subtotal, 30); assert.equal(order.total, 70); assert.equal(s.products[0].warehouseStocks[0].quantity, 26);
  assert.deepEqual(presentOrder(order).items, []); assert.equal(presentOrder(order).bundles.length, 1);
});

for (const method of ["cod", "pos_on_delivery", "instapay", "card"]) {
  for (const ordinary of [true, false]) test(`guest ${method} uses shared ${ordinary ? "mixed" : "bundle-only"} order assembly`, async t => {
    const s = setup(t, { guest: true, ordinary }), before = s.snapshot();
    const order = await s.place({ paymentMethod: method,
      ...(method === "instapay" ? { instapayScreenshotUrls: ["https://proof.invalid/fixture.webp"] } : {}) });
    assert.equal(order.guestId, s.guestId); assert.equal(order.user, null);
    assert.equal(order.walletUsed, 0); assert.equal(order.total, ordinary ? 100 : 80);
    assert.equal(presentOrder(order).bundles.length, 1); assert.equal(presentOrder(order).items.length, ordinary ? 1 : 0);
    assert.deepEqual(s.ledger, []); assert.equal(s.user.walletBalance, 10);
    if (method === "card") {
      assert.equal(order.status, "awaiting_payment"); assert.equal(order.sideEffectsCommitted, false);
      assert.deepEqual({ ...s.cart, __v: before.cart.__v }, before.cart);
      assert.equal(s.cart.__v, before.cart.__v + 1);
      assert.deepEqual(s.snapshot().products, before.products); assert.equal(s.stockSaves, 0);
    } else {
      assert.equal(s.products[0].warehouseStocks[0].quantity, ordinary ? 24 : 26);
      assert.deepEqual(s.cart.items, []); assert.equal(s.cart.bundles, undefined); assert.equal(s.cart.__v, 8);
    }
  });
}

for (const ordinary of [true, false]) test(`existing card skeleton assembly leaves stock, money and cart unchanged (${ordinary ? "mixed" : "bundle only"})`, async t => {
  const s = setup(t, { ordinary }), before = s.snapshot(), order = await s.place({ paymentMethod: "card" });
  assert.equal(order.status, "awaiting_payment"); assert.equal(order.sideEffectsCommitted, false);
  assert.equal(order.total, ordinary ? 90 : 70); assert.equal(order.settlement.cardDuePiastres, order.total * 100);
  assert.deepEqual({ ...s.cart, __v: before.cart.__v }, before.cart); assert.equal(s.cart.__v, before.cart.__v + 1);
  assert.deepEqual(s.snapshot().products, before.products); assert.equal(s.user.walletBalance, 10);
  assert.deepEqual(s.ledger, []); assert.equal(s.stockSaves, 0); assert.equal(s.orders.length, 1);
});

test("the existing item coupon discounts only ordinary merchandise", async t => {
  const s = setup(t), order = await s.place({ couponCode: "SAVE" });
  assert.equal(order.discountAmount, 2); assert.equal(order.total, 88); assert.equal(s.couponUses, 1);
  assert.equal(order.bundleGroups[0].unitPricePiastres, 1500);
});

test("an item coupon cannot discount a bundle-only purchase", async t => {
  const s = setup(t, { ordinary: false }), before = s.snapshot();
  await assert.rejects(s.place({ couponCode: "SAVE" }), { statusCode: 400 }); assert.deepEqual(s.snapshot(), before);
});

test("stock decrease uses the selected variant and warehouse only", async t => {
  const s = setup(t, { ordinary: false });
  Object.assign(s.products[0], { type: "VARIANT", variants: [{ _id: OTHER, price: 10, options: [], images: [],
    warehouseStocks: [{ warehouse: W, quantity: 30 }, { warehouse: B, quantity: 1000 }] }] });
  s.definitions[0].components = [{ productId: P, productType: "VARIANT", variantId: OTHER, quantity: 2 }];
  await s.place(); assert.equal(s.products[0].variants[0].warehouseStocks[0].quantity, 26);
  assert.equal(s.products[0].variants[0].warehouseStocks[1].quantity, 1000);
});

test("unavailable selected stock or warehouse cannot borrow a fallback", async t => {
  const s = setup(t); s.products[0].warehouseStocks[0].quantity = 5;
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 });
  await assert.rejects(s.place(), { statusCode: 409 }); assert.equal(s.orders.length, 0);
  s.products[0].warehouseStocks[0].quantity = 30; s.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse: OTHER };
  await assert.rejects(s.place(), { statusCode: 409 }); assert.equal(s.orders.length, 0);
});

test("a lost cart comparison rejects the transaction rather than leaving a partially consumed purchase", async t => {
  const s = setup(t), before = s.snapshot(); s.forceMismatch = true;
  await assert.rejects(s.place(), { statusCode: 409 }); assert.deepEqual(s.snapshot(), before);
});

test("feature gate, owner and active transaction remain required", async t => {
  const s = setup(t), before = s.snapshot();
  await assert.rejects(s.place({ orderUserId: OTHER }), { statusCode: 409 });
  await assert.rejects(s.place({ orderGuestId: "guest" }), { statusCode: 409 });
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false"; await assert.rejects(s.place(), { statusCode: 409 });
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true"; s.active = false; await assert.rejects(s.place(), { statusCode: 503 });
  assert.deepEqual(s.snapshot(), before);
});


async function publicFixture(t, options) {
  const s = setup(t, options);
  for (const [key, value] of Object.entries({ JWT_ACCESS_SECRET: "public-order-fixture-key", NODE_ENV: "test", REDIS_URL: "",
    PAYMOB_SECRET_KEY: "fixture-only-secret", PAYMOB_PUBLIC_KEY: "fixture-only-public", PAYMOB_INTEGRATION_ID: "99", PAYMOB_WEBHOOK_URL: "" })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const query = read => { let session, populated = false; return { select() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
    populate() { populated = true; return this; }, session(value) { session = value; return this; },
    then(resolve, reject) { return Promise.resolve().then(() => read(session, populated)).then(resolve, reject); } }; };
  s.starts = 0; s.pending = null; s.providerCalls = [];
  s.session.endSession = () => {};
  s.session.withTransaction = async callback => {
    const before = s.snapshot(); s.active = true;
    try { return await callback(); } catch (error) { Object.assign(s, before); throw error; } finally { s.active = false; }
  };
  t.mock.method(mongoose, "startSession", async () => { s.starts++; return s.session; });
  t.mock.method(UserModel, "findById", () => { if (options?.guest) assert.fail("Guest checkout must not load an account"); return query(() => clone(s.user)); });
  t.mock.method(UserModel, "find", () => query(() => []));
  t.mock.method(CartModel, "findOne", filter => query((session, populated) => {
    if (options?.guest && (filter.user != null || filter.guestId !== s.guestId)) return null;
    return populated ? CartModel.hydrate(s.cart) : clone(s.cart);
  }));
  const clearCart = CartModel.collection.updateOne;
  s.keyWrites = 0;
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, options) => {
    if (update.$set?.checkoutKey) {
      assert.equal(options, undefined); s.assertOwnerFilter(filter); assert.equal(filter.__v, s.cart.__v);
      assert.deepEqual(filter.$expr.$eq[1].$literal, s.cart);
      if (s.keyConflict) return { matchedCount: 0, modifiedCount: 0 };
      s.keyWrites++; Object.assign(s.cart, update.$set); s.cart.__v += update.$inc.__v;
      return { matchedCount: 1, modifiedCount: 1 };
    }
    return clearCart(filter, update, options);
  });
  t.mock.method(OrderModel, "findOne", filter => query(() => {
    assert.equal(filter.checkoutKey, s.cart.checkoutKey); assert.equal(filter.status, "awaiting_payment");
    return s.pending ?? s.orders.find(row => row.checkoutKey === filter.checkoutKey && row.status === filter.status) ?? null;
  }));
  t.mock.method(OrderModel, "updateOne", async (filter, update) => {
    const order = s.orders.find(row => String(row._id) === String(filter._id)); assert.ok(order); Object.assign(order, update); return { matchedCount: 1 };
  });
  t.mock.method(SavedCardModel, "find", () => query(() => []));
  s.errors = []; t.mock.method(console, "error", (...values) => s.errors.push(values));
  paymentLimiter.resetKey("127.0.0.1");
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.lang = "en"; next(); });
  app.use("/api/v1/orders", orderRouter); app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET);
  s.request = (body = { paymentMethod: "cod", notes: "Call first" }, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const identityHeaders = options?.guest ? { "x-guest-id": s.guestId } : { authorization: `Bearer ${token}` };
    const req = http.request({ host: "127.0.0.1", port: server.address().port,
      path: options?.guest ? "/api/v1/orders/guest" : "/api/v1/orders/me", method: "POST",
      headers: Object.fromEntries(Object.entries({ ...identityHeaders, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers }).filter(([, value]) => value != null)) }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }); req.on("error", reject); req.end(payload);
  });
  s.usePaymentSimulation = () => {
    const url = new URL(process.env.PETYARD_TEST_PAYMENT_SIM_URL);
    assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
    t.mock.method(globalThis, "fetch", async (target, options) => {
      assert.equal(target, "https://accept.paymob.com/v1/intention/");
      const body = JSON.parse(options.body); s.providerCalls.push(body);
      return nativeFetch(new URL("paymob/v1/intention/", url), options);
    });
  };
  return s;
}

for (const method of ["cod", "pos_on_delivery"]) for (const ordinary of [true, false]) test(`existing HTTP order route purchases ${ordinary ? "mixed" : "bundle-only"} merchandise with ${method}`, async t => {
  const s = await publicFixture(t, { ordinary }), result = await s.request({ paymentMethod: method, notes: "Call first" });
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.data.total, ordinary ? 90 : 70);
  assert.equal(result.body.data.paymentMethod, method); assert.equal(result.body.data.notes, "Call first");
  assert.equal(result.body.data.items.length, ordinary ? 1 : 0); assert.equal(result.body.data.bundles.length, 1);
  assert.equal(s.orders.length, 1); assert.equal(s.stockSaves, 1); assert.equal(s.ledger.length, 1); assert.equal(s.user.walletBalance, 0);
  assert.deepEqual(s.cart.items, []); assert.equal(s.cart.bundles, undefined);
  for (const field of ["bundleCheckout", "bundleGroups", "sourceCart", "checkoutKey"]) assert.equal(result.body.data[field], undefined);
});

for (const ordinary of [true, false]) test(`guest HTTP order route buys ${ordinary ? "mixed" : "bundle-only"} merchandise without signing in`, async t => {
  const s = await publicFixture(t, { guest: true, ordinary });
  const result = await s.request({ paymentMethod: "cod" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.total, ordinary ? 100 : 80);
  assert.equal(result.body.data.bundles.length, 1); assert.equal(s.stockSaves, 1);
  assert.deepEqual(s.ledger, []);
});

test("guest card checkout key backfill uses the owned cart and retains the existing retry window", async t => {
  const s = await publicFixture(t, { guest: true }); delete s.cart.checkoutKey;
  s.pending = { _id: OTHER, createdAt: new Date(), orderNumber: "PENDING" };
  const result = await s.request({ paymentMethod: "card" });
  assert.equal(result.status, 409); assert.match(result.body.message, /payment in progress/);
  assert.equal(s.keyWrites, 1); assert.equal(s.starts, 0); assert.equal(s.stockSaves, 0);
  assert.deepEqual(s.ledger, []); assert.deepEqual(s.providerCalls, []);
});

test("a guest pending order appearing after the initial lookup stops before provider initialization", async t => {
  const s = await publicFixture(t, { guest: true }), before = s.snapshot();
  t.mock.method(OrderModel, "findOne", filter => {
    let session;
    return { session(value) { session = value; return this; }, select() { return this; },
      then(resolve, reject) { return Promise.resolve(session ? { _id: OTHER } : null).then(resolve, reject); } };
  });
  const result = await s.request({ paymentMethod: "card" });
  assert.equal(result.status, 409); assert.match(result.body.message, /payment in progress/);
  assert.equal(s.orders.length, 0); assert.deepEqual(s.cart, before.cart); assert.deepEqual(s.providerCalls, []);
});

for (const ordinary of [true, false]) test(`guest card initialization charges only the shared ${ordinary ? "mixed" : "bundle-only"} total`, async t => {
  if (!process.env.PETYARD_TEST_PAYMENT_SIM_URL) { t.skip("Run with the local Postman payment simulation"); return; }
  const s = await publicFixture(t, { guest: true, ordinary }); s.usePaymentSimulation();
  const before = s.snapshot(), result = await s.request({ paymentMethod: "card" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.action, "requires_payment"); assert.equal(s.providerCalls.length, 1);
  const call = s.providerCalls[0]; assert.equal(call.amount, ordinary ? 10000 : 8000);
  assert.equal(call.items.length, 1); assert.equal(call.items[0].amount, call.amount);
  assertPendingCartPreserved(s.cart, before.cart); assert.equal(s.stockSaves, 0); assert.deepEqual(s.ledger, []);
});

for (const ordinary of [true, false]) test(`existing HTTP card initialization sends one order total for ${ordinary ? "mixed" : "bundle-only"} merchandise`, async t => {
  if (!process.env.PETYARD_TEST_PAYMENT_SIM_URL) { t.skip("Run with the local Postman payment simulation; no external provider requests are allowed"); return; }
  const s = await publicFixture(t, { ordinary }), before = s.snapshot(); s.usePaymentSimulation();
  const result = await s.request({ paymentMethod: "card" }); assert.equal(result.status, 200, JSON.stringify({ body: result.body, errors: s.errors, calls: s.providerCalls }));
  assert.equal(result.body.action, "requires_payment"); assert.equal(result.body.clientSecret, "fixture-client-secret"); assert.equal(result.body.publicKey, "fixture-only-public");
  assert.equal(result.body.data.status, "awaiting_payment"); assert.equal(result.body.data.sideEffectsCommitted, false);
  assert.equal(result.body.data.bundles.length, 1); assert.equal(result.body.data.items.length, ordinary ? 1 : 0);
  assert.equal(s.providerCalls.length, 1); const call = s.providerCalls[0]; assert.equal(call.amount, ordinary ? 9000 : 7000);
  assert.equal(call.items.length, 1); assert.equal(call.items[0].quantity, 1); assert.equal(call.items[0].amount, call.amount);
  assertPendingCartPreserved(s.cart, before.cart); assert.equal(s.stockSaves, 0); assert.equal(s.user.walletBalance, 10); assert.deepEqual(s.ledger, []);
  assert.equal(s.orders[0].paymobOrderId, "fixture-provider-order"); assert.equal(s.orders[0].checkoutKey, before.cart.checkoutKey);
});

test("existing HTTP card retry window remains in force without client idempotency metadata", async t => {
  const s = await publicFixture(t), before = s.snapshot(); s.pending = { _id: OTHER, createdAt: new Date(), orderNumber: "PENDING" };
  const result = await s.request({ paymentMethod: "card" }); assert.equal(result.status, 409); assert.match(result.body.message, /payment in progress/);
  assert.equal(s.starts, 0); assert.deepEqual(s.snapshot(), before); assert.deepEqual(s.providerCalls, []);
});

test("existing card initialization failure keeps stock, money and cart unchanged", async t => {
  const s = await publicFixture(t), before = s.snapshot(); delete process.env.PAYMOB_SECRET_KEY;
  const result = await s.request({ paymentMethod: "card" }); assert.equal(result.status, 502); assert.equal(s.orders.length, 1);
  assert.equal(s.orders[0].status, "cancelled"); assert.equal(s.orders[0].paymentStatus, "failed");
  assertPendingCartPreserved(s.cart, before.cart); assert.equal(s.stockSaves, 0); assert.equal(s.user.walletBalance, 10); assert.deepEqual(s.ledger, []);
});

test("disabled or missing gate rejects a saved bundle purchase without changing data", async t => {
  const s = await publicFixture(t), before = s.snapshot();
  for (const value of ["false", undefined]) { if (value === undefined) delete process.env.ASSISTANT_BUNDLE_CART_ENABLED; else process.env.ASSISTANT_BUNDLE_CART_ENABLED = value;
    paymentLimiter.resetKey("127.0.0.1"); const result = await s.request(); assert.equal(result.status, 409); assert.deepEqual(s.snapshot(), before); }
});

test("bundle order placement reuses checkout address validation before stock or wallet effects", async t => {
  const s = await publicFixture(t); delete s.cart.deliveryAddress;
  let result = await s.request(); assert.equal(result.status, 400); assert.match(result.body.message, /Delivery address/); assert.equal(s.orders.length, 0);
  s.cart.deliveryAddress = { name: "Incomplete" }; paymentLimiter.resetKey("127.0.0.1"); result = await s.request(); assert.equal(result.status, 400);
  assert.equal(s.stockSaves, 0); assert.equal(s.user.walletBalance, 10); assert.deepEqual(s.ledger, []);
});

test("public order endpoint keeps the existing auth, phone and request validators", async t => {
  const s = await publicFixture(t);
  assert.equal((await s.request(undefined, { authorization: null, "x-guest-id": "guest" })).status, 401);
  s.user.phoneVerified = false; assert.equal((await s.request()).status, 403); s.user.phoneVerified = true;
  for (const body of [{ paymentMethod: "bad" }, { paymentMethod: "instapay" }, { paymentMethod: "cod", bundleCheckout: {} }]) {
    paymentLimiter.resetKey("127.0.0.1"); assert.equal((await s.request(body)).status, 400);
  }
  assert.equal(s.starts, 0); assert.equal(s.orders.length, 0); assert.deepEqual(s.ledger, []);
});


test("existing card checkout initializes a missing internal key without changing cart contents", async t => {
  if (!process.env.PETYARD_TEST_PAYMENT_SIM_URL) { t.skip("Run with the local Postman payment simulation"); return; }
  const s = await publicFixture(t); delete s.cart.checkoutKey; const before = s.snapshot(); s.usePaymentSimulation();
  const result = await s.request({ paymentMethod: "card" }); assert.equal(result.status, 200, JSON.stringify({ body: result.body, errors: s.errors }));
  assert.equal(s.keyWrites, 1); assert.equal(typeof s.cart.checkoutKey, "string"); assert.ok(s.cart.checkoutKey);
  assert.deepEqual(s.cart.items, before.cart.items); assert.deepEqual(s.cart.bundles, before.cart.bundles);
  assert.equal(s.cart.__v, before.cart.__v + 2); assert.equal(s.orders[0].checkoutKey, s.cart.checkoutKey);
  assert.equal(s.user.walletBalance, 10); assert.equal(s.stockSaves, 0); assert.equal(s.providerCalls.length, 1);
});

test("a lost key-initialization comparison returns a retry without creating or charging an order", async t => {
  const s = await publicFixture(t); delete s.cart.checkoutKey; s.keyConflict = true; const before = s.snapshot();
  const result = await s.request({ paymentMethod: "card" }); assert.equal(result.status, 409);
  assert.equal(s.orders.length, 0); assert.equal(s.providerCalls.length, 0); assert.equal(s.keyWrites, 0); assert.deepEqual(s.snapshot(), before);
});
