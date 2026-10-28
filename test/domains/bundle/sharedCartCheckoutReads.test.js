import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { getCartService } from "../../../src/domains/cart/cart.service.js";
import { getCheckoutSummaryService, applyCouponAtCheckoutService } from "../../../src/domains/checkout/checkout.service.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CouponModel } from "../../../src/domains/coupon/coupon.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { FREE_SHIPPING_THRESHOLD } from "../../../src/shared/constants/enums.js";
import cartRouter from "../../../src/domains/cart/cart.routes.js";
import checkoutRouter from "../../../src/domains/checkout/checkout.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";

function setup(t, { ordinary = true } = {}) {
  const s = fixture(t, { ordinary });
  for (const [key, value] of Object.entries({ ASSISTANT_BUNDLE_CART_ENABLED: "true", JWT_ACCESS_SECRET: "local-shared-read-fixture", NODE_ENV: "test", REDIS_URL: "" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 2, unitPricePiastres: 1500 }];
  if (ordinary) s.cart.items[0].itemPrice = 10;
  s.cart.deliveryAddress = { userAddressId: new mongoose.Types.ObjectId(OTHER), warehouse: new mongoose.Types.ObjectId(W),
    name: "Test customer", governorate: "Alexandria", phone: "01012345678", building: "1", floor: "2", apartment: "3",
    details: "Fixture", location: { lat: 30, lng: 31 } };
  s.user.phone = "01012345678"; s.user.walletBalance = 10; s.warehouse.defaultShippingPrice = 50;
  s.coupon = { _id: new mongoose.Types.ObjectId(OTHER), code: "SAVE", discountType: "PERCENT", discountValue: 10, usageCount: 0 };
  s.active = false; s.starts = 0; s.ends = 0; s.stockReads = 0;
  const query = read => {
    let session;
    return { select() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
      session(value) { session = value; return this; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (session != null) { assert.equal(session, s.session); assert.equal(s.active, true); } return read(session); }).then(resolve, reject);
      } };
  };
  t.mock.method(CartModel, "findOne", filter => query(() => {
    assert.equal(String(filter.user), U); return clone(s.cart);
  }));
  t.mock.method(UserModel, "findById", () => query(() => clone(s.user)));
  t.mock.method(WarehouseModel, "findById", id => query(() => (s.warehouses ?? [s.warehouse]).find(row => String(row._id) === String(id)) ?? null));
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("Bundle reads must never ask for a fallback warehouse"));
  t.mock.method(ProductModel, "find", filter => query(session => {
    if (filter.$or) {
      assert.equal(session, s.session); assert.equal(filter.isActive, true); s.stockReads++;
      assert.equal(String(filter.$or[0].warehouseStocks.$elemMatch.warehouse), s.selectedWarehouse ?? W);
      assert.equal(String(filter.$or[1].variants.$elemMatch.warehouseStocks.$elemMatch.warehouse), s.selectedWarehouse ?? W);
    }
    return s.products.filter(row => filter._id.$in.some(id => String(id) === String(row._id)));
  }));
  t.mock.method(CouponModel, "findOne", () => query(() => s.coupon));
  t.mock.method(LoyaltySettingsModel, "findOne", () => query(() => ({ isActive: true, pointsEarnRate: 2 })));
  t.mock.method(LoyaltySettingsModel, "create", () => assert.fail("Fixture must not initialize settings"));
  t.mock.method(mongoose, "connect", () => assert.fail("No real database connection"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No external provider calls"));
  t.mock.method(console, "warn", () => {});
  s.session.withTransaction = async (callback, options) => {
    assert.deepEqual(options.readConcern, { level: "snapshot" }); assert.deepEqual(options.writeConcern, { w: "majority" });
    s.active = true; try { return await callback(); } finally { s.active = false; }
  };
  s.session.endSession = async () => { assert.equal(s.active, false); s.ends++; };
  t.mock.method(mongoose, "startSession", async () => { s.starts++; return s.session; });
  s.cartRead = (changes = {}) => getCartService({ userId: U, warehouseId: s.selectedWarehouse ?? W, ...changes });
  s.checkout = (changes = {}) => getCheckoutSummaryService({ userId: U, warehouseId: s.selectedWarehouse ?? W, ...changes });
  return s;
}

test("existing cart format gains one commercial bundle entry and does not save or leak private data", async t => {
  const s = setup(t), before = clone(s.cart), result = await s.cartRead();
  assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []); assert.equal(s.starts, 1); assert.equal(s.ends, 1);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].productId, P);
  assert.equal(result.bundles.length, 1); assert.equal(result.bundles[0].id, G);
  assert.equal(result.bundles[0].productName, "Pair"); assert.equal(result.bundles[0].type, "BUNDLE");
  assert.equal(result.bundles[0].quantity, 2); assert.equal(result.bundles[0].itemPrice, 15); assert.equal(result.bundles[0].lineTotal, 30);
  assert.equal(result.totalCartPrice, 50); assert.equal(result.shippingFee, 50); assert.equal(result.pricingStatus, "ready");
  assert.equal(result.checkoutSupported, true); assert.ok(s.stockReads > 0);
  for (const key of ["checkoutKey", "__v", "patch", "demands", "receipt", "walletBalance"]) assert.equal(Object.hasOwn(result, key), false);
});

test("existing checkout keeps bundle price final and applies wallet, coupon and loyalty only once", async t => {
  const s = setup(t), before = clone(s.cart), result = await s.checkout({ couponCode: "SAVE" });
  assert.equal(result.items.length, 1); assert.equal(result.bundles.length, 1); assert.equal(result.pricing.subtotal, 50);
  assert.equal(result.pricing.discountAmount, 2); assert.equal(result.pricing.shippingFee, 50);
  assert.equal(result.pricing.walletUsed, 10); assert.equal(result.pricing.finalTotal, 88); assert.equal(result.pricing.loyaltyPoints, 96);
  assert.equal(result.checkoutSupported, true); assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []);
});

test("bundle-only checkout is not an empty cart and shipping coupons retain the existing rules", async t => {
  const s = setup(t, { ordinary: false });
  const summary = await s.checkout(); assert.deepEqual(summary.items, []); assert.equal(summary.bundles.length, 1);
  assert.equal(summary.pricing.subtotal, 30); assert.equal(summary.pricing.finalTotal, 70);
  await assert.rejects(s.checkout({ couponCode: "SAVE" }), { statusCode: 400 });
  s.coupon = { ...s.coupon, code: "SHIP", discountType: null, freeShipping: true };
  const shipping = await s.checkout({ couponCode: "SHIP" }); assert.equal(shipping.pricing.shippingDiscount, 50); assert.equal(shipping.pricing.finalTotal, 20);
  const coupon = await applyCouponAtCheckoutService({ userId: U, warehouseId: W, couponCode: "SHIP" });
  assert.equal(coupon.pricing.subtotal, 30); assert.equal(coupon.pricing.discountAmount, 0); assert.equal(coupon.pricing.shippingAfter, 0);
  assert.equal(coupon.checkoutSupported, true); assert.deepEqual(s.writes, []);
});

test("bundle selling amount counts toward the existing free-shipping threshold", async t => {
  const s = setup(t, { ordinary: false }); s.cart.bundles[0].quantity = Math.ceil(FREE_SHIPPING_THRESHOLD / 15);
  s.products[0].warehouseStocks[0].quantity = s.cart.bundles[0].quantity * 2;
  assert.equal((await s.checkout()).pricing.shippingFee, 0); assert.deepEqual(s.writes, []);
});

test("checkout requires the app's current warehouse for bundles and rejects a changed area without rebinding", async t => {
  const s = setup(t), before = clone(s.cart);
  await assert.rejects(s.checkout({ warehouseId: undefined }), { statusCode: 400 });
  s.warehouses = [s.warehouse, { ...s.warehouse, _id: OTHER }]; s.selectedWarehouse = OTHER;
  const changed = await s.cartRead(); assert.equal(changed.warehouseChangeRequired, true); assert.equal(changed.totalCartPrice, null);
  assert.equal(changed.bundles[0].status, "unavailable"); assert.equal(changed.shippingFee, null);
  await assert.rejects(s.checkout(), { statusCode: 409 }); assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []);
});

test("four independent warehouses qualify only where every exact component is stocked", async t => {
  const s = setup(t, { ordinary: false }); const ids = [W, "888888888888888888888888", "999999999999999999999999", "aaaaaaaaaaaaaaaaaaaaaaaa"];
  s.warehouses = ids.map(_id => ({ ...s.warehouse, _id }));
  s.products = [{ ...s.products[0], warehouseStocks: [0,1,3].map(i => ({ warehouse: ids[i], quantity: 10 })) },
    { ...s.products[0], _id: OTHER, warehouseStocks: [1,2,3].map(i => ({ warehouse: ids[i], quantity: 10 })) }];
  s.definitions[0].components = [{ productId: P, productType: "SIMPLE", quantity: 1 }, { productId: OTHER, productType: "SIMPLE", quantity: 1 }];
  for (const [i, id] of ids.entries()) {
    s.selectedWarehouse = id; s.cart.warehouse = new mongoose.Types.ObjectId(id);
    const result = await s.cartRead(); assert.equal(result.bundles[0].status, [1,3].includes(i) ? "available" : "unavailable", id);
    assert.equal(result.totalCartPrice, [1,3].includes(i) ? 30 : null, id);
  }
  assert.deepEqual(s.writes, []);
});

test("ordinary and bundle units compete for the same warehouse stock", async t => {
  const s = setup(t); s.products[0].warehouseStocks[0].quantity = 5;
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 });
  const cart = await s.cartRead(); assert.equal(cart.pricingStatus, "unavailable"); assert.equal(cart.totalCartPrice, null);
  await assert.rejects(s.checkout(), { statusCode: 409 }); assert.deepEqual(s.writes, []);
});

test("another variant's large stock cannot qualify the exact selected variant", async t => {
  const s = setup(t, { ordinary: false }); const wanted = "bbbbbbbbbbbbbbbbbbbbbbbb", other = "cccccccccccccccccccccccc";
  s.products[0].type = "VARIANT"; s.products[0].variants = [
    { _id: wanted, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 0 }] },
    { _id: other, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 1000 }] }];
  s.definitions[0].components = [{ productId: P, productType: "VARIANT", variantId: wanted, quantity: 2 }];
  assert.equal((await s.cartRead()).bundles[0].status, "unavailable");
  await assert.rejects(s.checkout(), { statusCode: 409 }); assert.deepEqual(s.writes, []);
});

test("closed warehouse, paused offers and stale ordinary prices do not produce checkout totals", async t => {
  const s = setup(t), warehouse = clone(s.warehouse);
  s.warehouse.fulfillment = { status: "maintenance", fallbackWarehouse: OTHER };
  await assert.rejects(s.cartRead(), { statusCode: 409 }); s.warehouse = warehouse;
  s.definitions[0].status = "paused"; assert.equal((await s.cartRead()).bundles[0].status, "unavailable");
  await assert.rejects(s.checkout(), { statusCode: 409 }); s.definitions[0].status = "published";
  s.cart.items[0].itemPrice = 7; assert.equal((await s.cartRead()).pricingStatus, "review_required");
  await assert.rejects(s.checkout(), { statusCode: 409 }); assert.deepEqual(s.writes, []);
});

test("missing delivery address stays an existing checkout error and never yields a guessed payable total", async t => {
  const s = setup(t); delete s.cart.deliveryAddress;
  await assert.rejects(s.checkout(), { statusCode: 400, message: "Delivery address is not set for this cart" });
  assert.deepEqual(s.writes, []);
});

test("disabled gate preserves existing bundle guards and ineligible accounts cannot use the shared read", async t => {
  const s = setup(t); process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  await assert.rejects(s.cartRead(), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  await assert.rejects(s.checkout(), { code: "BUNDLE_CART_FLOW_REQUIRED" });
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true"; s.user.phoneVerified = false;
  await assert.rejects(s.cartRead(), { statusCode: 403 }); assert.deepEqual(s.writes, []);
});

test("existing HTTP cart/checkout paths require no new headers and validate the selected warehouse", async t => {
  const s = setup(t), app = express(); app.use(express.json()); app.use((req, _res, next) => { req.lang = "en"; next(); });
  app.use("/api/v1/cart", cartRouter); app.use("/api/v1/checkout", checkoutRouter); app.use(globalError);
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET);
  const request = (route, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.address().port, path: route, headers: authenticated ? { authorization: `Bearer ${token}` } : {} }, res => {
      let body = ""; res.on("data", data => { body += data; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }); req.on("error", reject);
  });
  const cart = await request(`/api/v1/cart/me/${W}`); assert.equal(cart.status, 200); assert.equal(cart.body.data.bundles.length, 1);
  const checkout = await request(`/api/v1/checkout/me/summary?warehouseId=${W}`); assert.equal(checkout.status, 200);
  assert.equal(checkout.body.data.pricing.finalTotal, 90); assert.equal(checkout.body.data.checkoutSupported, true);
  assert.equal((await request("/api/v1/checkout/me/summary?warehouseId=bad")).status, 400);
  assert.equal((await request("/api/v1/checkout/me/summary")).status, 400);
  assert.equal((await request(`/api/v1/cart/me/${W}`, false)).status, 401);
  assert.deepEqual(s.writes, []);
});

