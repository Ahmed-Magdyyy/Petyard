import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import { UserModel } from "../../src/domains/user/user.model.js";
import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { getCartService, upsertCartItemService, mergeGuestCartService } from "../../src/domains/cart/cart.service.js";
import { globalError } from "../../src/shared/middlewares/errorMiddleware.js";
import { getCheckoutSummaryService } from "../../src/domains/checkout/checkout.service.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const G = "444444444444444444444444", C = "555555555555555555555555", OTHER = "666666666666666666666666";
const args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2 };
const duplicate = (changes = {}) => Object.assign(new Error("simulated duplicate owner index"), {
  code: 11000, keyPattern: { user: 1 }, keyValue: { user: new mongoose.Types.ObjectId(U) }, ...changes });
const clone = (value) => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;
const cart = (changes = {}) => new CartModel({ _id: C, user: U, warehouse: W, checkoutKey: "winner-key", __v: 7,
  items: [{ product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }], totalCartPrice: 300, ...changes }).toObject();

// Real cart services with database, provider, transaction, and uniqueness effects mocked.
function fixture(t) {
  const state = { user: null, guest: null, winner: cart(), lookups: [], insertAttempts: [], updates: [], deletes: [], active: false,
    account: { _id: new mongoose.Types.ObjectId(U), active: true, phoneVerified: true, deletedAt: null, __v: 1 },
    product: { _id: P, isActive: true, type: "SIMPLE", price: 100, name_en: "Toy", images: [], warehouseStocks: [{ warehouse: W, quantity: 10 }] } };
  const matchesCart = (row, filter) => {
    if (!row || String(row._id) !== String(filter._id)) return false;
    if (filter.user && String(row.user) !== String(filter.user)) return false;
    if (filter.guestId && (row.user != null || row.guestId !== filter.guestId)) return false;
    const expected = filter.$expr?.$eq?.[1]?.$literal;
    return !expected || mongoose.mongo.BSON.serialize(row).equals(mongoose.mongo.BSON.serialize(expected));
  };
  const query = (read) => ({ select() { return this; }, populate() { return this; },
    session(value) { assert.equal(value, state.session); return this; }, lean() { this.asLean = true; return this; },
    then(resolve, reject) { return Promise.resolve().then(read).then(value => value && this.asLean ? clone(value) : value).then(resolve, reject); } });
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
  t.mock.method(WarehouseModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "find", () => query(() => []));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(mongoose, "startSession", async () => state.session);
  t.mock.method(mongoose.Connection.prototype, "openUri", () => assert.fail("cart services must not connect to a database"));
  t.mock.method(globalThis, "fetch", () => assert.fail("cart services must not call providers"));
  state.session = { inTransaction: () => state.active, async endSession() {}, async withTransaction(work) {
    const before = clone({ user: state.user, guest: state.guest, account: state.account });
    state.active = true;
    try { return await work(); }
    catch (error) {
      state.user = before.user; state.guest = before.guest; state.account = before.account;
      if (state.externalUser) state.user = clone(state.externalUser);
      throw error;
    } finally { state.active = false; }
  } };
  t.mock.method(UserModel.collection, "updateOne", async (filter, _update, { session }) => {
    assert.equal(session, state.session); assert.equal(state.active, true);
    assert.equal(String(filter._id), U); assert.equal(filter.active, true); assert.equal(filter.phoneVerified, true);
    state.account.__v++;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "insertOne", async (row) => {
    state.insertAttempts.push(clone(row));
    if (state.createError) { if(row.user)state.user=state.winner;else state.guest=state.winner;throw state.createError; }
    if (row.user) state.user = clone(row); else state.guest = clone(row);
    return { acknowledged: true, insertedId: row._id };
  });
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, options = {}) => {
    if (options.session) {
      assert.equal(options.session, state.session); assert.equal(state.active, true);
      if (update.$set?.user && state.adoptionError) {
        if (state.adoptionError.keyPattern?.user === 1) state.externalUser = state.winner;
        throw state.adoptionError;
      }
      state.updates.push(clone({ filter, update }));
      const row = [state.user, state.guest].find(value => matchesCart(value, filter));
      if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set));
      for (const key of Object.keys(update.$unset ?? {})) delete row[key];
      row.__v = (row.__v ?? 0) + update.$inc.__v;
      if (row.guestId == null && row.user) { state.user = row; if (state.guest === row) state.guest = null; }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }
    if (update.$set?.user && state.adoptionError) { state.user = state.winner; throw state.adoptionError; }
    state.updates.push(clone({ filter, update }));
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "deleteOne", async (filter, options = {}) => {
    if (options.session) { assert.equal(options.session, state.session); assert.equal(state.active, true); }
    state.deletes.push(clone(filter));
    if (matchesCart(state.guest, filter)) { state.guest = null; return { acknowledged: true, deletedCount: 1 }; }
    return { acknowledged: true, deletedCount: 0 };
  });
  t.mock.method(CartModel, "createIndexes", () => assert.fail("cart requests must not create indexes"));
  state.add = (changes = {}) => upsertCartItemService({ ...args, ...changes });
  state.merge = () => mergeGuestCartService({ userId: U, guestId: "guest-test", warehouseId: W });
  return state;
}

test("ordinary cart reads retain requested quantities above stock and report the selected warehouse issue", async t => {
  const s = fixture(t); s.user = cart(); s.user.items[0].quantity = 6; s.product.warehouseStocks[0].quantity = 4;
  const response = await getCartService(args);
  assert.equal(response.items[0].quantity, 6); assert.equal(response.stockIssues[0].availableQuantity, 4);
  assert.equal(response.checkoutSupported, false); assert.equal(s.user.items[0].quantity, 6);
});

test("ordinary checkout refuses an unresolved stock issue rather than quoting a reduced basket", async t => {
  const s = fixture(t); s.user = cart(); s.user.items[0].quantity = 6; s.product.warehouseStocks[0].quantity = 4;
  await assert.rejects(getCheckoutSummaryService({ userId: U, warehouseId: W }), error =>
    error.statusCode === 409 && error.errors[0].code === "CART_STOCK_REVIEW_REQUIRED");
  assert.equal(s.user.items[0].quantity, 6);
});

test("guest-only adoption keeps the existing cart identity and transfers its full contents", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const result = await s.merge();
  assert.equal(String(result.id), G); assert.equal(result.items[0].quantity, 3);
  assert.equal(String(s.user._id), G); assert.equal(String(s.user.user), U); assert.equal(s.user.guestId, undefined);
  assert.equal(s.updates.length, 1); assert.equal(s.updates[0].update.$unset.guestId, "");
  assert.equal(s.deletes.length, 0); assert.equal(s.insertAttempts.length, 0);
});

test("a user-uniqueness conflict during adoption returns 409 and preserves every guest item", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const original = clone(s.guest); s.adoptionError = duplicate();
  await assert.rejects(s.merge(), { statusCode: 409, message: "Your cart changed. Please try again." });
  assert.deepEqual(s.guest, original); assert.equal(s.deletes.length, 0); assert.equal(s.updates.length, 0);
  assert.equal(String(s.user._id), C); assert.equal(s.user.items[0].quantity, 3);
});

test("a fresh merge after an adoption conflict preserves full quantities and flags insufficient stock", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  s.adoptionError = duplicate(); await assert.rejects(s.merge(), { statusCode: 409 });
  s.adoptionError = null; s.product.warehouseStocks[0].quantity = 4;
  const result = await s.merge();
  assert.equal(String(result.id), C); assert.equal(result.items[0].quantity, 6);
  assert.equal(result.checkoutSupported, false); assert.equal(result.stockIssues[0].requestedQuantity, 6);
  assert.equal(result.stockIssues[0].availableQuantity, 4);
  assert.equal(s.deletes.length, 1); assert.equal(String(s.deletes[0]._id), G);
  assert.equal(s.guest, null);
});

test("an unrelated duplicate-key error during adoption preserves its identity and guest data", async (t) => {
  const s = fixture(t); s.guest = cart({ _id: G, user: undefined, guestId: "guest-test" });
  const original = clone(s.guest); const error = duplicate({ keyPattern: { _id: 1 } }); s.adoptionError = error;
  await assert.rejects(s.merge(), (received) => received === error);
  assert.deepEqual(s.guest, original); assert.equal(s.deletes.length, 0);
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
