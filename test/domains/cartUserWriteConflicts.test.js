import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { AddressModel } from "../../src/domains/address/address.model.js";
import { upsertCartItemService, updateCartItemQuantityService, removeCartItemService,
  getCartService, setCartAddressFromUserService } from "../../src/domains/cart/cart.service.js";
import { globalError } from "../../src/shared/middlewares/errorMiddleware.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const C = "444444444444444444444444", I = "555555555555555555555555", A = "666666666666666666666666";
const args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2, itemId: I };
const clone = (value) => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;

// Use real Mongoose saves and injected collection results; no native race/isolation claim.
function fixture(t, changes = {}) {
  const state = { raw: { _id: new mongoose.Types.ObjectId(C), user: new mongoose.Types.ObjectId(U), warehouse: new mongoose.Types.ObjectId(W),
    checkoutKey: "retained-key", __v: 7, totalCartPrice: 300, currency: "EGP", status: "ACTIVE",
    items: [{ _id: new mongoose.Types.ObjectId(I), product: new mongoose.Types.ObjectId(P), productType: "SIMPLE", quantity: 3, itemPrice: 100 }],
    ...changes }, writes: [], reads: 0, failAt: 1, creates: 0 };
  const query = (read) => ({ select() { return this; }, lean() { return Promise.resolve().then(read); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  const product = { _id: P, type: "SIMPLE", price: 100, name_en: "Toy", images: [], warehouseStocks: [{ warehouse: W, quantity: 20 }] };
  t.mock.method(ProductModel, "findById", () => query(() => product));
  t.mock.method(ProductModel, "find", () => query(() => [product]));
  t.mock.method(WarehouseModel, "findById", () => query(() => ({ _id: W, active: true })));
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(AddressModel, "findOne", () => query(() => ({ _id: A, user: U, warehouse: W, name: "New address", area: "Area" })));
  t.mock.method(CartModel, "findOne", () => query(() => { state.reads++; return CartModel.hydrate(clone(state.raw)); }));
  t.mock.method(CartModel.collection, "updateOne", async (filter, update) => {
    state.writes.push(clone({ filter, update }));
    if (state.writes.length === state.failAt) {
      state.onConflict?.();
      if (state.failure) throw state.failure;
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    state.onAcceptedWrite?.(filter, update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "insertOne", () => { state.creates++; assert.fail("do not recreate a stale existing cart"); });
  return state;
}

test("a signed-in addition losing its first save returns 409 without retry or overwrite", async (t) => {
  const s = fixture(t); s.onConflict = () => { s.raw.items[0].quantity = 9; s.raw.__v = 8; };
  await assert.rejects(upsertCartItemService(args), { statusCode: 409, isOperational: true });
  assert.equal(s.writes.length, 1); assert.equal(s.reads, 1); assert.equal(s.creates, 0);
  assert.equal(s.raw.items[0].quantity, 9);
});

test("a signed-in addition losing its final save does not replay the increment", async (t) => {
  const s = fixture(t); s.failAt = 2;
  s.onConflict = () => { s.raw.items[0].quantity = 9; s.raw.__v = 9; };
  await assert.rejects(upsertCartItemService(args), { statusCode: 409 });
  assert.equal(s.writes.length, 2); assert.equal(s.reads, 1);
  assert.equal(s.writes[1].update.$set["items.0.quantity"], 5);
  assert.equal(s.raw.items[0].quantity, 9);
});

test("quantity edits losing their save preserve the newer cart and return 409", async (t) => {
  const s = fixture(t); s.onConflict = () => { s.raw.items[0].quantity = 8; };
  await assert.rejects(updateCartItemQuantityService(args), { statusCode: 409 });
  assert.equal(s.raw.items[0].quantity, 8); assert.equal(s.writes.length, 1);
});

test("item removal losing its save returns 409 without removing the current item", async (t) => {
  const s = fixture(t);
  await assert.rejects(removeCartItemService(args), { statusCode: 409 });
  assert.equal(s.raw.items.length, 1); assert.equal(s.writes.length, 1);
});

test("ordinary signed-in cart refresh maps a stale save to 409 without recreation", async (t) => {
  const s = fixture(t);
  await assert.rejects(getCartService(args), { statusCode: 409 });
  assert.equal(s.writes.length, 1); assert.equal(s.creates, 0);
});

test("checkout-key backfill on a deleted cart maps actual ODM DocumentNotFoundError to 409", async (t) => {
  const s = fixture(t, { checkoutKey: undefined });
  await assert.rejects(getCartService(args), { statusCode: 409 });
  assert.equal(s.writes.length, 1); assert.equal(s.creates, 0);
  assert.equal(s.writes[0].filter.__v, undefined, "scalar backfill has no version predicate");
});

test("address selection losing its scalar save returns 409 through the actual ODM missing-document result", async (t) => {
  const s = fixture(t);
  await assert.rejects(setCartAddressFromUserService({ userId: U, userAddressId: A }), { statusCode: 409 });
  assert.equal(s.writes.length, 1); assert.equal(s.raw.deliveryAddress, undefined);
});

test("409 on a later address refresh does not pretend an earlier address save rolled back", async (t) => {
  const s = fixture(t); s.failAt = 2;
  s.onAcceptedWrite = (_filter, update) => {
    if (update.$set?.deliveryAddress) s.raw.deliveryAddress = clone(update.$set.deliveryAddress);
  };
  await assert.rejects(setCartAddressFromUserService({ userId: U, userAddressId: A }), { statusCode: 409 });
  assert.equal(s.writes.length, 2); assert.equal(s.raw.deliveryAddress.name, "New address");
  assert.equal(s.raw.items[0].quantity, 3); assert.equal(s.creates, 0);
});

test("independent guest cart conflicts retain VersionError behavior", async (t) => {
  const s = fixture(t, { user: undefined, guestId: "independent-guest" });
  await assert.rejects(upsertCartItemService({ ...args, userId: null, guestId: "independent-guest" }),
    (error) => error instanceof mongoose.Error.VersionError);
  assert.equal(s.writes.length, 1);
});

test("an ordinary database failure is not mislabeled or retried as a cart conflict", async (t) => {
  const s = fixture(t); const error = new Error("database transport failed"); s.failure = error;
  await assert.rejects(upsertCartItemService(args), (received) => received === error);
  assert.equal(s.writes.length, 1); assert.equal(s.reads, 1);
});

test("an uncertain final write response never causes an automatic second addition", async (t) => {
  const s = fixture(t); s.failAt = 2; const error = new Error("simulated lost write acknowledgement"); s.failure = error;
  s.onConflict = () => { s.raw.items[0].quantity = 5; s.raw.totalCartPrice = 500; };
  await assert.rejects(upsertCartItemService(args), (received) => received === error);
  assert.equal(s.writes.length, 2); assert.equal(s.reads, 1); assert.equal(s.raw.items[0].quantity, 5);
});

test("an error merely named VersionError does not become a known no-match conflict", async (t) => {
  const s = fixture(t); const error = Object.assign(new Error("unrelated named error"), { name: "VersionError" }); s.failure = error;
  await assert.rejects(upsertCartItemService(args), (received) => received === error);
  assert.equal(s.writes.length, 1);
});

test("known signed-in save conflicts retain the ordinary production 409 envelope", async (t) => {
  fixture(t); let failure;
  try { await upsertCartItemService(args); } catch (error) { failure = error; }
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.method(console, "warn", () => {});
  let status, body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
  await globalError(failure, { method: "POST", originalUrl: `/api/v1/cart/me/${W}/items` }, response, () => assert.fail("unexpected next"));
  assert.equal(status, 409);
  assert.deepEqual(body, { status: "fail", error: [], message: "Your cart changed. Please try again." });
});
