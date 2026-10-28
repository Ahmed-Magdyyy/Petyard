import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import orderRouter from "../../../src/domains/order/order.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { paymentLimiter } from "../../../src/shared/middlewares/rateLimitMiddleware.js";
import { fixture as cartFixture } from "../bundle/fixtures/bundleCartTransaction.js";
import { U, W, OTHER, clone } from "../bundle/fixtures/bundleCartTransaction.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";

function fixture(t) {
  const s = cartFixture(t); s.user.phone = "01012345678";
  s.cart.bundles = [{ id: "555555555555555555555555", bundleId: "444444444444444444444444", bundleRevision: 2, quantity: 1, unitPricePiastres: 1500 }];
  for (const [key, value] of Object.entries({ ASSISTANT_BUNDLE_CART_ENABLED: "true", JWT_ACCESS_SECRET: "synthetic-order-entry-key", REDIS_URL: "", NODE_ENV: "test" })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  s.starts = 0;
  const query = value => ({ select() { return this; }, session() { return this; }, populate() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  s.session.withTransaction = callback => callback(); s.session.endSession = () => {};
  t.mock.method(mongoose, "startSession", async () => { s.starts++; return s.session; });
  t.mock.method(UserModel, "findById", () => query(s.user));
  t.mock.method(CartModel, "findOne", () => query(s.cart));
  t.mock.method(mongoose, "connect", () => assert.fail("No database connections"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No external provider calls"));
  s.capture = () => clone({ cart: s.cart, user: s.user, writes: s.writes, receipts: s.receipts });
  s.context = { cartId: String(s.cart._id), expectedCartVersion: 7, warehouseId: W };
  s.key = "retired-checkout-test";
  s.body = { bundleCheckout: s.context, paymentMethod: "cod", couponCode: "SAVE", notes: "Call first" };
  return s;
}

async function httpFixture(t) {
  const s = fixture(t), app = express();
  paymentLimiter.resetKey("127.0.0.1");
  app.use(express.json()); app.use((req, _res, next) => { req.lang = req.get("Accept-Language") === "ar" ? "ar" : "en"; next(); });
  app.use("/api/v1/orders", orderRouter); app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET);
  s.request = ({ body = s.body, headers = {}, query = "" } = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port: server.address().port, path: `/api/v1/orders/me${query}`, method: "POST",
      headers: Object.fromEntries(Object.entries({ authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
        "Idempotency-Key": s.key, "X-Petyard-Bundle-Cart-Version": "1", ...headers }).filter(([, value]) => value != null)) }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode,
        headers: response.headers, body: JSON.parse(text) }));
    }); request.on("error", reject); request.end(payload);
  });
  return s;
}

test("route rejects retired COD input without creating an order", async t => {
  const s = await httpFixture(t), before = s.capture();
  const rejected = await s.request(); assert.equal(rejected.status, 400);
  assert.ok(rejected.body.error.some(error => error.field === "bundleCheckout"));
  assert.deepEqual(s.capture(), before); assert.equal(s.starts, 0);
});

test("retired POS request template remains disabled and rejected", async t => {
  const s = await httpFixture(t);
  const collection = JSON.parse(readFileSync(new URL("../assistant/fixtures/contracts/BundleCheckout.postman_collection.json", import.meta.url), "utf8"));
  assert.equal(collection.variable.find(row => row.key === "allowBundleOrderRequest").value, "false");
  const values = { cartId: s.context.cartId, cartVersion: 7, warehouseId: W, paymentMethod: "pos_on_delivery" };
  const body = JSON.parse(collection.item[0].request.body.raw.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key]));
  const before = s.capture(); assert.equal((await s.request({ body })).status, 400);
  assert.deepEqual(s.capture(), before); assert.equal(s.starts, 0);
});

test("disabled gate keeps normal bundle purchase requests blocked", async t => {
  const s = await httpFixture(t), before = s.capture();
  s.ordinary = true;
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  // The ordinary service loads a document with populate(); it must fail on its existing guard.
  t.mock.method(CartModel, "findOne", () => ({ session() { return this; }, populate() { return this; },
    then(resolve, reject) { return Promise.resolve(s.cart).then(resolve, reject); } }));
  const result = await s.request({ body: { paymentMethod: "cod" }, headers: { "Idempotency-Key": null, "X-Petyard-Bundle-Cart-Version": null } });
  assert.equal(result.status, 409); assert.match(result.body.message, /contains bundles/); assert.equal(result.body.code, undefined);
  assert.deepEqual(s.capture(), before); assert.equal(s.starts, 1);
});

test("auth and phone verification precede bundle order placement", async t => {
  const s = await httpFixture(t);
  assert.equal((await s.request({ headers: { authorization: null, "x-guest-id": "guest" } })).status, 401);
  s.user.phoneVerified = false; assert.equal((await s.request()).status, 403);
  assert.equal(s.starts, 0); assert.deepEqual(s.writes, []);
});

test("retired context is rejected by the existing validator pipeline before transactional service reads", async t => {
  const s = await httpFixture(t);
  for (const request of [
    { body: { ...s.body, bundleCheckout: null } }, { body: { ...s.body, bundleCheckout: [] } },
    { body: { ...s.body, bundleCheckout: { ...s.context, cartId: "bad" } } },
    { body: { ...s.body, bundleCheckout: { ...s.context, expectedCartVersion: "7" } } },
    { body: { ...s.body, bundleCheckout: { ...s.context, expectedCartVersion: -1 } } },
    { body: { ...s.body, bundleCheckout: { ...s.context, warehouseId: "bad" } } },
    { body: { ...s.body, bundleCheckout: { ...s.context, price: 1 } } },
    { body: { ...s.body, walletBalance: 500 } }, { body: { ...s.body, notes: "x".repeat(2001) } },
    { body: { ...s.body, couponCode: " " } }, { headers: { "Idempotency-Key": null } },
    { headers: { "Idempotency-Key": "bad key" } }, { headers: { "X-Petyard-Bundle-Cart-Version": null } },
    { headers: { "X-Petyard-Bundle-Cart-Version": "2" } }, { query: "?userId=" + OTHER },
  ]) {
    paymentLimiter.resetKey("127.0.0.1");
    const result = await s.request(request); assert.equal(result.status, 400, JSON.stringify(request));
    assert.ok(result.body.error.some(error => error.field === "bundleCheckout"));
  }
  assert.equal(s.starts, 0); assert.deepEqual(s.writes, []);
});

test("retired bundle input cannot be enabled by old gates or payment methods", async t => {
  const s = await httpFixture(t);
  delete process.env.ASSISTANT_BUNDLE_CHECKOUT_ENABLED;
  let result = await s.request(); assert.equal(result.status, 400);
  process.env.ASSISTANT_BUNDLE_CHECKOUT_ENABLED = "true";
  for (const paymentMethod of ["cod", "pos_on_delivery", "card", "instapay"]) {
    paymentLimiter.resetKey("127.0.0.1");
    result = await s.request({ body: { ...s.body, paymentMethod } });
    assert.equal(result.status, 400);
    assert.ok(result.body.error.some(error => error.field === "bundleCheckout"));
  }
  result = await s.request({ body: { paymentMethod: "instapay" } });
  assert.equal(result.status, 400, "Ordinary InstaPay still requires its existing screenshot");
  assert.equal(s.starts, 0); assert.deepEqual(s.writes, []);
});

test("existing payment limiter remains active on the connected order route", async t => {
  const s = await httpFixture(t); delete process.env.ASSISTANT_BUNDLE_CHECKOUT_ENABLED;
  for (let count = 0; count < 5; count++) assert.equal((await s.request()).status, 400);
  const limited = await s.request(); assert.equal(limited.status, 429); assert.ok(limited.headers["ratelimit-limit"]);
  assert.equal(s.starts, 0);
});

test("retired input is rejected regardless of stock in other warehouses", async t => {
  const s = await httpFixture(t);
  s.products[0].warehouseStocks[0].quantity = 5; s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 });
  const before = s.capture(); assert.equal((await s.request()).status, 400);
  assert.deepEqual(s.capture(), before); assert.equal(s.starts, 0);
});
