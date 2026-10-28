import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { upsertCartBundleService, updateCartBundleService, removeCartBundleService,
  upsertCartItemService, updateCartItemQuantityService, removeCartItemService,
  rebindCartWithBundlesService, setCartAddressFromUserService, clearCartService } from "../../../src/domains/cart/cart.service.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { AddressModel } from "../../../src/domains/address/address.model.js";
import { AssistantCartProposal } from "../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { AssistantCartReceipt } from "../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import cartRouter from "../../../src/domains/cart/cart.routes.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";

function cart(t, options) {
  const s = fixture(t, options);
  for (const [key, value] of Object.entries({ ASSISTANT_BUNDLE_CART_ENABLED: "true", JWT_ACCESS_SECRET: "shared-cart-write-fixture", NODE_ENV: "test", REDIS_URL: "" })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  s.user.phone = "01012345678"; s.warehouse.defaultShippingPrice = 50;
  if (s.cart?.items.length) s.cart.items[0].itemPrice = 10;
  s.active = false; s.starts = 0; s.ends = 0; s.deletes = 0;
  const query = read => { let session; return { select() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
    session(value) { session = value; return this; }, then(resolve, reject) { return Promise.resolve().then(() => {
      if (session != null) { assert.equal(session, s.session); assert.equal(s.active, true); } return read(session);
    }).then(resolve, reject); } }; };
  t.mock.method(CartModel, "findOne", filter => query(() => {
    assert.equal(String(filter.user), U); return s.cart && (filter._id == null || String(filter._id) === String(s.cart._id)) ? clone(s.cart) : null;
  }));
  t.mock.method(UserModel, "findById", () => query(() => clone(s.user)));
  t.mock.method(WarehouseModel, "findById", id => query(() => (s.warehouses ?? [s.warehouse]).find(row => String(row._id) === String(id)) ?? null));
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("Direct bundle changes must not load a fallback warehouse"));
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(s.active, true); assert.equal(String(filter.user), U);
    assert.equal(filter.__v, filter.$expr.$eq[1].$literal.__v); s.onWrite?.();
    if (s.forceMismatch || !s.cart || !mongoose.mongo.BSON.serialize(s.cart).equals(mongoose.mongo.BSON.serialize(filter.$expr.$eq[1].$literal))) return { matchedCount: 0, modifiedCount: 0 };
    s.writes.push("cart"); Object.assign(s.cart, update.$set); for (const key of Object.keys(update.$unset)) delete s.cart[key];
    s.cart.__v += update.$inc.__v; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "insertOne", async (row, { session }) => {
    assert.equal(session, s.session); assert.equal(s.active, true);
    if (s.creationRace) throw Object.assign(Error("another cart won"), { code: 11000, keyPattern: { user: 1 } });
    assert.equal(new CartModel(row).validateSync(), undefined); assert.equal(s.cart, null);
    s.writes.push("insert"); s.cart = clone(row); return { insertedId: row._id };
  });
  t.mock.method(CartModel.collection, "deleteOne", async (filter, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter.user), U); s.deletes++;
    if (s.forceMismatch || !s.cart || !mongoose.mongo.BSON.serialize(s.cart).equals(mongoose.mongo.BSON.serialize(filter.$expr.$eq[1].$literal))) return { deletedCount: 0 };
    s.cart = null; return { deletedCount: 1 };
  });
  t.mock.method(ProductModel, "updateOne", () => assert.fail("Cart changes never reserve stock"));
  t.mock.method(AssistantCartProposal, "create", () => assert.fail("Direct app changes need no proposal"));
  t.mock.method(AssistantCartReceipt, "create", () => assert.fail("Direct app changes need no AI receipt"));
  t.mock.method(mongoose, "connect", () => assert.fail("No real database connection"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider calls"));
  t.mock.method(console, "warn", () => {});
  s.capture = () => clone({ cart: s.cart, user: s.user, receipts: s.receipts });
  s.session.withTransaction = async (callback, options) => {
    assert.deepEqual(options.readConcern, { level: "snapshot" }); assert.deepEqual(options.writeConcern, { w: "majority" });
    const before = s.capture(); s.active = true;
    try {
      let result = await callback();
      if (s.callbackRetry) { Object.assign(s, clone(before)); s.callbackRetry = false; result = await callback(); }
      if (s.commitError) throw s.commitError;
      return result;
    } catch (error) { if (!error.hasErrorLabel?.("UnknownTransactionCommitResult")) Object.assign(s, before); throw error; }
    finally { s.active = false; }
  };
  s.session.endSession = async () => { assert.equal(s.active, false); s.ends++; };
  t.mock.method(mongoose, "startSession", async () => { s.starts++; return s.session; });
  s.add = changes => upsertCartBundleService({ userId: U, warehouseId: W, bundleId: B, expectedRevision: 2, quantity: 2, ...changes });
  s.group = () => s.cart.bundles[0].id;
  s.set = quantity => updateCartBundleService({ userId: U, warehouseId: W, groupId: s.group(), quantity });
  s.remove = () => removeCartBundleService({ userId: U, warehouseId: W, groupId: s.group() });
  return s;
}

test("bundle add/increment/set/remove share the existing cart and never change component stock", async t => {
  const s = cart(t, { ordinary: true }), stock = clone({ products: s.products }).products, key = s.cart.checkoutKey;
  let result = await s.add(); assert.equal(result.bundles.length, 1); assert.equal(result.items.length, 1);
  assert.equal(result.bundles[0].quantity, 2); assert.equal(result.totalCartPrice, 50); assert.equal(s.cart.__v, 8);
  result = await s.add({ quantity: 1 }); assert.equal(result.bundles.length, 1); assert.equal(result.bundles[0].quantity, 3);
  result = await s.set(1); assert.equal(result.bundles[0].quantity, 1); assert.equal(result.totalCartPrice, 35);
  result = await s.remove(); assert.deepEqual(result.bundles, []); assert.equal(result.totalCartPrice, 20);
  assert.equal(s.cart.bundles, undefined); assert.equal(s.cart.checkoutKey, key); assert.deepEqual(s.products, stock);
  assert.equal(s.receipts.length, 0); assert.equal(s.starts, 4); assert.equal(s.ends, 4);
});

test("first bundle addition creates a normal uniquely-owned cart with a server checkout key", async t => {
  const s = cart(t, { existing: false }); const result = await s.add();
  assert.equal(result.userId.toString(), U); assert.match(String(result.id), /^[a-f\d]{24}$/);
  assert.equal(s.cart.__v, 0); assert.equal(s.cart.bundles[0].quantity, 2); assert.equal(s.cart.totalCartPrice, 30);
  assert.equal(typeof s.cart.checkoutKey, "string"); assert.ok(s.cart.checkoutKey.length); assert.deepEqual(result.items, []);
});

test("existing ordinary-item actions edit a mixed cart without flattening bundle components", async t => {
  const s = cart(t, { ordinary: true }); await s.add(); const group = s.group(), itemId = String(s.cart.items[0]._id);
  let result = await upsertCartItemService({ userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 1 });
  assert.equal(result.items[0].quantity, 3); assert.equal(result.bundles[0].id, group); assert.equal(result.totalCartPrice, 60);
  result = await updateCartItemQuantityService({ userId: U, warehouseId: W, itemId, quantity: 4 }); assert.equal(result.totalCartPrice, 70);
  result = await removeCartItemService({ userId: U, warehouseId: W, itemId });
  assert.deepEqual(result.items, []); assert.equal(result.bundles[0].id, group); assert.equal(result.totalCartPrice, 30);
});

test("combined ordinary and bundle demand cannot borrow another warehouse's stock", async t => {
  const s = cart(t, { ordinary: true }); s.products[0].warehouseStocks[0].quantity = 5;
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 }); const before = s.capture();
  await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
  s.products[0].warehouseStocks[0].quantity = 6; await s.add(); const after = s.capture();
  await assert.rejects(upsertCartItemService({ userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 1 }), { statusCode: 409 });
  assert.deepEqual(s.capture(), after);
});

test("four warehouse cart additions qualify only for the intersection of exact component stock", async t => {
  const s = cart(t); const initial = s.capture(), ids = [W, "888888888888888888888888", "999999999999999999999999", "aaaaaaaaaaaaaaaaaaaaaaaa"];
  s.warehouses = ids.map(_id => ({ ...s.warehouse, _id }));
  s.products = [{ ...s.products[0], warehouseStocks: [0,1,3].map(i => ({ warehouse: ids[i], quantity: 10 })) },
    { ...s.products[0], _id: OTHER, warehouseStocks: [1,2,3].map(i => ({ warehouse: ids[i], quantity: 10 })) }];
  s.definitions[0].components = [{ productId: P, productType: "SIMPLE", quantity: 1 }, { productId: OTHER, productType: "SIMPLE", quantity: 1 }];
  for (const [index, id] of ids.entries()) {
    Object.assign(s, clone(initial)); s.cart.warehouse = new mongoose.Types.ObjectId(id); s.expectedWarehouseId = id;
    if ([1,3].includes(index)) assert.equal((await s.add({ warehouseId: id })).bundles[0].quantity, 2);
    else await assert.rejects(s.add({ warehouseId: id }), { statusCode: 409 });
  }
});

test("exact variant, published revision and saved fixed price are revalidated on every edit", async t => {
  const s = cart(t); await s.add(); const before = s.capture();
  for (const change of [() => { s.definitions[0].status = "paused"; }, () => { s.definitions[0].revision = 3; }, () => { s.definitions[0].pricePiastres = 1400; }]) {
    const definition = clone({ definitions: s.definitions }).definitions; change(); await assert.rejects(s.set(1), { statusCode: 409 });
    assert.deepEqual(s.capture(), before); s.definitions = definition;
  }
  s.definitions[0].status = "paused"; await s.remove(); assert.equal(s.cart.bundles, undefined);
});

test("direct addition cannot replace an unavailable exact variant with a stocked variant", async t => {
  const s = cart(t); const selected = "bbbbbbbbbbbbbbbbbbbbbbbb", other = "cccccccccccccccccccccccc";
  s.products[0].type = "VARIANT"; s.products[0].variants = [
    { _id: selected, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 0 }] },
    { _id: other, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 1000 }] }];
  s.definitions[0].components = [{ productId: P, productType: "VARIANT", variantId: selected, quantity: 2 }];
  const before = s.capture(); await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
});

test("CAS failure rolls back the account fence and retains the earlier cart", async t => {
  const s = cart(t, { ordinary: true }), before = s.capture(); s.forceMismatch = true;
  await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.capture(), before); assert.equal(s.ends, 1);
});

test("retried transaction callback applies one addition; unknown commit requires a cart read", async t => {
  const s = cart(t); s.callbackRetry = true; await s.add(); assert.equal(s.cart.bundles[0].quantity, 2);
  s.commitError = Object.assign(Error("reply lost"), { hasErrorLabel: name => name === "UnknownTransactionCommitResult" });
  await assert.rejects(s.add({ quantity: 1 }), { statusCode: 503, code: "BUNDLE_CART_OUTCOME_UNKNOWN" });
  assert.equal(s.cart.bundles[0].quantity, 3); assert.equal(s.starts, 2); assert.equal(s.ends, 2);
});

test("owner cart uniqueness, creation races and account fences fail without partial writes", async t => {
  const s = cart(t, { existing: false }), before = s.capture(); s.creationRace = true;
  await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
  s.creationRace = false; s.cartIndexes = [{ key: { user: 1 } }];
  await assert.rejects(s.add(), { statusCode: 503 }); assert.deepEqual(s.capture(), before);
  s.cartIndexes = [{ key: { user: 1 }, unique: true, partialFilterExpression: { user: { $type: "objectId" } } }];
  s.fenceConflict = true; await assert.rejects(s.add(), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
});

test("explicit warehouse rebind verifies stock and clears an old address only after success", async t => {
  const s = cart(t); await s.add(); const before = s.capture();
  s.warehouses = [s.warehouse, { ...s.warehouse, _id: OTHER }]; s.expectedWarehouseId = OTHER;
  await assert.rejects(rebindCartWithBundlesService({ userId: U, warehouseId: OTHER }), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 10 });
  const result = await rebindCartWithBundlesService({ userId: U, warehouseId: OTHER });
  assert.equal(String(s.cart.warehouse), OTHER); assert.equal(result.warehouseChangeRequired, false);
  assert.equal(s.cart.deliveryAddress, undefined); assert.equal(result.deliveryAddress, null); assert.equal(result.totalCartPrice, 30);
});

test("existing address selection uses the owned address and explicitly selected warehouse atomically", async t => {
  const s = cart(t); await s.add(); const address = { _id: new mongoose.Types.ObjectId(OTHER), user: new mongoose.Types.ObjectId(U),
    warehouse: new mongoose.Types.ObjectId(W), __v: 0, name: "Owned address", location: { lat: 30, lng: 31 } };
  const query = { maxTimeMS() { return this; }, session(value) { assert.equal(value, s.session); return this; }, lean() { return this; },
    then(resolve, reject) { return Promise.resolve(address).then(resolve, reject); } };
  t.mock.method(AddressModel, "findOne", filter => { assert.equal(String(filter.user), U); return query; });
  t.mock.method(AddressModel.collection, "updateOne", async (filter, _update, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter.user), U); return { matchedCount: s.addressConflict ? 0 : 1, modifiedCount: 1 };
  });
  const before = s.capture(); await assert.rejects(setCartAddressFromUserService({ userId: U, userAddressId: OTHER }), { statusCode: 400 });
  assert.deepEqual(s.capture(), before); s.addressConflict = true;
  await assert.rejects(setCartAddressFromUserService({ userId: U, userAddressId: OTHER, warehouseId: W }), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
  s.addressConflict = false; const result = await setCartAddressFromUserService({ userId: U, userAddressId: OTHER, warehouseId: W });
  assert.equal(result.deliveryAddress.name, "Owned address"); assert.equal(String(s.cart.deliveryAddress.userAddressId), OTHER);
});

test("explicit clear works for unavailable groups and uses a full owner/cart fence", async t => {
  const s = cart(t); await s.add(); s.definitions = []; s.forceMismatch = true; const before = s.capture();
  await assert.rejects(clearCartService({ userId: U, warehouseId: W }), { statusCode: 409 }); assert.deepEqual(s.capture(), before);
  s.forceMismatch = false; assert.deepEqual(await clearCartService({ userId: U, warehouseId: W }), { success: true }); assert.equal(s.cart, null);
});

test("disabled feature, unverified accounts and invalid direct quantities remain blocked", async t => {
  const s = cart(t); process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  await assert.rejects(s.add(), { statusCode: 503 }); assert.equal(s.starts, 0);
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true"; s.user.phoneVerified = false;
  await assert.rejects(s.add(), { statusCode: 403 }); s.user.phoneVerified = true;
  for (const quantity of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(s.add({ quantity }), { statusCode: 400 });
  assert.equal(s.cart.bundles, undefined);
});

test("real existing cart router handles bundle and ordinary actions with standard envelopes and no new headers", async t => {
  const s = cart(t, { ordinary: true }), app = express(); app.use(express.json()); app.use((req, _res, next) => { req.lang = "en"; next(); });
  app.use("/api/v1/cart", cartRouter); app.use(globalError);
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve))); const token = jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET);
  const request = (method, route, body, authenticated = true) => new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/api/v1/cart" + route, method,
      headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ""; res.on("data", x => { text += x; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on("error", reject); req.end(payload);
  });
  const route = `/me/${W}/bundles`, body = { bundleId: B, expectedRevision: 2, quantity: 2 };
  assert.equal((await request("POST", route, body, false)).status, 401);
  assert.equal((await request("POST", route, { ...body, itemPrice: 1 })).status, 400);
  assert.equal((await request("POST", route, { ...body, quantity: "2" })).status, 400);
  let result = await request("POST", route, body); assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.body), ["data"]);
  assert.equal(result.body.data.totalCartPrice, 50); const id = result.body.data.bundles[0].id;
  result = await request("PATCH", route + "/" + id, { quantity: 1 }); assert.equal(result.status, 200); assert.equal(result.body.data.totalCartPrice, 35);
  const itemId = String(s.cart.items[0]._id);
  result = await request("PATCH", `/me/${W}/items/${itemId}`, { quantity: 3 }); assert.equal(result.status, 200); assert.equal(result.body.data.totalCartPrice, 45);
  result = await request("DELETE", route + "/" + id); assert.equal(result.status, 200); assert.deepEqual(result.body.data.bundles, []);
  result = await request("POST", route, body); assert.equal(result.status, 200);
  result = await request("POST", `/me/${W}/rebind`, {}); assert.equal(result.status, 200); assert.equal(result.body.data.warehouseChangeRequired, false);
  s.user.phoneVerified = false;
  assert.equal((await request("PATCH", route + "/" + s.group(), { quantity: 1 })).status, 403);
  s.user.phoneVerified = true;
  result = await request("DELETE", `/me/${W}`); assert.equal(result.status, 200); assert.deepEqual(result.body, {}); assert.equal(s.cart, null);
});
