import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { getCartService, upsertCartItemService, mergeGuestCartService } from "../../src/domains/cart/cart.service.js";
import { globalError } from "../../src/shared/middlewares/errorMiddleware.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const G = "444444444444444444444444", C = "555555555555555555555555", OTHER = "666666666666666666666666";
const args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2 };
const duplicate = (changes = {}) => Object.assign(new Error("simulated duplicate owner index"), {
  code: 11000, keyPattern: { user: 1 }, keyValue: { user: new mongoose.Types.ObjectId(U) }, ...changes });
const clone = (value) => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;
const cart = (changes = {}) => new CartModel({ _id: C, user: U, warehouse: W, checkoutKey: "winner-key", __v: 7,
  items: [{ product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }], totalCartPrice: 300, ...changes }).toObject();

// Real cart services and Mongoose saves; database I/O and unique-index failures are simulated.
function fixture(t) {
  const state = { user: null, guest: null, winner: cart(), lookups: [], insertAttempts: [], updates: [], deletes: [],
    product: { _id: P, type: "SIMPLE", price: 100, name_en: "Toy", images: [], warehouseStocks: [{ warehouse: W, quantity: 10 }] } };
  const query = (read) => ({ select() { return this; }, lean() { return Promise.resolve().then(read); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(CartModel, "findOne", (filter) => {
    state.lookups.push(filter);
    return query(() => {
      const raw = filter.user ? state.user : state.guest;
      return raw ? CartModel.hydrate(clone(raw)) : null;
    });
  });
  t.mock.method(ProductModel, "findById", () => query(() => state.product));
  t.mock.method(ProductModel, "find", () => query(() => [state.product]));
  t.mock.method(WarehouseModel, "findById", () => query(() => ({ _id: W, active: true })));
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CartModel.collection, "insertOne", async (row) => {
    state.insertAttempts.push(clone(row));
    if (state.createError) { state.user = state.winner; throw state.createError; }
    if (row.user) state.user = clone(row); else state.guest = clone(row);
    return { acknowledged: true, insertedId: row._id };
  });
  t.mock.method(CartModel.collection, "updateOne", async (filter, update) => {
    if (update.$set?.user && state.adoptionError) { state.user = state.winner; throw state.adoptionError; }
    state.updates.push(clone({ filter, update }));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "deleteOne", async (filter) => {
    state.deletes.push(clone(filter));
    if (String(filter._id) === String(state.guest?._id)) state.guest = null;
    return { acknowledged: true, deletedCount: 1 };
  });
  t.mock.method(CartModel, "createIndexes", () => assert.fail("cart requests must not create indexes"));
  state.add = (changes = {}) => upsertCartItemService({ ...args, ...changes });
  state.merge = () => mergeGuestCartService({ userId: U, guestId: "guest-test", warehouseId: W });
  return state;
}

test("a duplicate first-user-cart insert reuses the winning cart and adds the requested increment once", async (t) => {
  const s = fixture(t); s.createError = duplicate();
  const result = await s.add();
  assert.equal(s.insertAttempts.length, 1); assert.equal(s.lookups.length, 2);
  assert.equal(String(result.id), C); assert.equal(result.items[0].quantity, 5);
  assert.equal(result.totalCartPrice, 500);
  assert.equal(s.user.checkoutKey, "winner-key"); assert.equal(s.deletes.length, 0);
  assert.ok(s.updates.some(({ update }) => update.$set?.["items.0.quantity"] === 5));
});

test("a disappeared winning cart yields a bounded 409 without another create attempt", async (t) => {
  const s = fixture(t); s.winner = null; s.createError = duplicate();
  await assert.rejects(s.add(), { statusCode: 409, message: "Your cart changed. Please try again." });
  assert.equal(s.insertAttempts.length, 1); assert.equal(s.lookups.length, 2); assert.equal(s.updates.length, 0);
});

test("unrelated duplicate keys and ordinary failures are not swallowed as user-cart races", async (t) => {
  const s = fixture(t);
  for (const error of [new Error("database failure"), duplicate({ keyPattern: { _id: 1 } }),
    duplicate({ keyPattern: { user: 1, warehouse: 1 } }), duplicate({ keyValue: { user: OTHER } }),
    duplicate({ keyPattern: undefined })]) {
    s.user = null; s.createError = error;
    await assert.rejects(s.add(), (received) => received === error);
  }
  assert.equal(s.updates.length, 0); assert.equal(s.deletes.length, 0);
});

test("a known single-user index conflict can recover when the driver omits keyValue", async (t) => {
  const s = fixture(t); s.createError = duplicate({ keyValue: undefined });
  const result = await s.add();
  assert.equal(String(result.id), C); assert.equal(result.items[0].quantity, 5);
  assert.equal(s.insertAttempts.length, 1); assert.equal(s.lookups.length, 2);
});

test("guest-only cart creation keeps its error behavior instead of recovering an unrelated user cart", async (t) => {
  const s = fixture(t); const error = duplicate(); s.createError = error;
  await assert.rejects(s.add({ userId: null, guestId: "guest-test" }), (received) => received === error);
  assert.equal(s.lookups.length, 1); assert.equal(s.updates.length, 0);
});

test("a recovered legacy cart still receives the existing checkout-key backfill", async (t) => {
  const s = fixture(t); delete s.winner.checkoutKey; s.createError = duplicate();
  await s.add();
  assert.ok(s.updates.some(({ update }) => typeof update.$set?.checkoutKey === "string" && update.$set.checkoutKey.length > 0));
  assert.equal(s.insertAttempts.length, 1);
});

test("ordinary existing cart additions do not create or perform a recovery lookup", async (t) => {
  const s = fixture(t); s.user = cart();
  const result = await s.add();
  assert.equal(s.lookups.length, 1); assert.equal(s.insertAttempts.length, 0);
  assert.equal(result.items[0].quantity, 5);
});

test("ordinary first-user-cart creation keeps its checkout key and existing result shape", async (t) => {
  const s = fixture(t); const result = await s.add();
  assert.equal(s.insertAttempts.length, 1); assert.equal(s.lookups.length, 1);
  assert.ok(s.insertAttempts[0].checkoutKey); assert.equal(result.items[0].quantity, 2);
  assert.equal(result.totalCartPrice, 200); assert.equal(String(s.insertAttempts[0].user), U);
});

test("ordinary guest adoption keeps its save flow and existing cart identity", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const result = await s.merge();
  assert.equal(String(result.id), G); assert.equal(result.items[0].quantity, 3);
  assert.equal(String(s.updates[0].update.$set.user), U);
  assert.equal(s.updates[0].update.$unset.guestId, 1);
  assert.equal(s.deletes.length, 0); assert.equal(s.insertAttempts.length, 0);
});

test("a user-uniqueness conflict during adoption returns 409 and preserves every guest item", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const original = clone(s.guest); s.adoptionError = duplicate();
  await assert.rejects(s.merge(), { statusCode: 409, message: "Your cart changed. Please try again." });
  assert.deepEqual(s.guest, original); assert.equal(s.deletes.length, 0); assert.equal(s.updates.length, 0);
  assert.equal(String(s.user._id), C); assert.equal(s.user.items[0].quantity, 3);
});

test("a fresh merge request after an adoption conflict uses the normal stock-capped merge", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  s.adoptionError = duplicate(); await assert.rejects(s.merge(), { statusCode: 409 });
  s.adoptionError = null; s.product.warehouseStocks[0].quantity = 4;
  const result = await s.merge();
  assert.equal(String(result.id), C); assert.equal(result.items[0].quantity, 4);
  assert.equal(s.deletes.length, 1); assert.equal(String(s.deletes[0]._id), G);
  assert.equal(s.guest, null);
});

test("unrelated adoption-save errors preserve their original identity and the guest data", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const original = clone(s.guest); const error = duplicate({ keyPattern: { _id: 1 } }); s.adoptionError = error;
  await assert.rejects(s.merge(), (received) => received === error);
  assert.deepEqual(s.guest, original); assert.equal(s.deletes.length, 0);
});

test("recovered cart additions still validate stock for the resulting full quantity", async (t) => {
  const s = fixture(t); s.createError = duplicate();
  await assert.rejects(s.add({ quantity: 8 }), /exceeds available stock/);
  assert.equal(s.insertAttempts.length, 1);
  assert.equal(s.updates.some(({ update }) => update.$set?.["items.0.quantity"] > 3), false);
});

test("ordinary get-cart creation also reuses the winning user cart without losing its contents", async (t) => {
  const s = fixture(t); s.createError = duplicate();
  const result = await getCartService({ userId: U, warehouseId: W });
  assert.equal(String(result.id), C); assert.equal(result.items[0].quantity, 3);
  assert.equal(s.insertAttempts.length, 1); assert.equal(s.lookups.length, 2);
});

test("adoption conflict uses the existing production error envelope with HTTP status 409", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" }); s.adoptionError = duplicate();
  let failure;
  try { await s.merge(); } catch (error) { failure = error; }
  assert.ok(failure);
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.method(console, "warn", () => {});
  let status, body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
  await globalError(failure, { method: "POST", originalUrl: `/api/v1/cart/me/${W}/merge` }, response, () => assert.fail("unexpected next"));
  assert.equal(status, 409);
  assert.deepEqual(body, { status: "fail", error: [], message: "Your cart changed. Please try again." });
});
