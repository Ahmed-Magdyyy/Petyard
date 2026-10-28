import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { upsertCartItemService, updateCartItemQuantityService, removeCartItemService,
  clearCartService, mergeGuestCartService } from "../../../src/domains/cart/cart.service.js";

const U = "111111111111111111111111", W = "222222222222222222222222";
const P = "333333333333333333333333", C = "444444444444444444444444", I = "555555555555555555555555";
const args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2, itemId: I };
const plain = (value) => JSON.parse(JSON.stringify(value));
const rawCart = (changes = {}) => ({ _id: C, user: U, warehouse: W, checkoutKey: "retained-key", __v: 7,
  items: [{ _id: I, product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }],
  totalCartPrice: 300, status: "ACTIVE", ...changes });

// Exercise real document saves and ODM-generated predicates; only collection I/O is replaced.
function fixture(t, raw = rawCart()) {
  const state = { raw, updates: [], inserts: [], deletes: [], rejectWrite: false };
  const product = { _id: new mongoose.Types.ObjectId(P), type: "SIMPLE", isActive: true,
    price: 100, name_en: "Toy", images: [], warehouseStocks: [{ warehouse: W, quantity: 20 }] };
  const query = (value) => ({ select() { return this; }, lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(WarehouseModel, "findById", () => query({ _id: W, active: true }));
  t.mock.method(ProductModel, "findById", () => query(product));
  t.mock.method(ProductModel, "find", () => query([product]));
  t.mock.method(CollectionModel, "findOne", () => query(null));
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  t.mock.method(CartModel, "findOne", (filter) => {
    const found = state.raw && (filter.user ? String(state.raw.user) === String(filter.user) : state.raw.guestId === filter.guestId);
    return query(found ? CartModel.hydrate(state.raw) : null);
  });
  t.mock.method(CartModel.collection, "updateOne", async (filter, update) => {
    state.updates.push(plain({ filter, update }));
    if (state.rejectWrite) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "insertOne", async (doc) => {
    state.inserts.push(plain(doc));
    return { acknowledged: true, insertedId: doc._id };
  });
  t.mock.method(CartModel.collection, "deleteOne", async (filter) => {
    state.deletes.push(plain(filter)); return { acknowledged: true, deletedCount: 1 };
  });
  return state;
}

test("ordinary additions can guard quantity writes without incrementing the version", async (t) => {
  const state = fixture(t);
  await upsertCartItemService(args);
  assert.equal(state.updates.length, 2);
  for (const [index, { filter, update }] of state.updates.entries()) {
    assert.equal(filter._id, C); assert.equal(filter.__v, 7 + index);
    assert.equal(update.$inc?.__v, index === 0 ? 1 : undefined);
  }
  assert.equal(state.updates[1].update.$set["items.0.quantity"], 5);
  assert.equal(state.updates[1].update.$set.totalCartPrice, 500);
});

test("ordinary quantity edits and removals retain the array version guard", async (t) => {
  const state = fixture(t);
  await updateCartItemQuantityService(args);
  assert.equal(state.updates[0].filter.__v, 7);
  assert.equal(state.updates[0].update.$inc.__v, 1);
  assert.equal(state.updates[0].update.$set["items.0.quantity"], 2);
  state.updates.length = 0;
  await removeCartItemService(args);
  assert.equal(state.updates[0].filter.__v, 7);
  assert.equal(state.updates[0].update.$inc.__v, 1);
  assert.deepEqual(state.updates[0].update.$set.items, []);
});

test("a conflicting signed-in cart save returns operational 409 instead of overwriting", async (t) => {
  const state = fixture(t); state.rejectWrite = true;
  await assert.rejects(upsertCartItemService(args), { statusCode: 409, message: "Your cart changed. Please try again." });
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].filter.__v, 7);
});

test("legacy carts missing __v have no version predicate when editing items", async (t) => {
  const raw = rawCart(); delete raw.__v;
  const state = fixture(t, raw);
  await upsertCartItemService(args);
  assert.equal(Object.hasOwn(state.updates[0].filter, "__v"), false);
  assert.equal(state.updates[0].update.$inc.__v, 1);
});

test("already-refreshed quantity writes can leave __v unchanged across competing documents", async (t) => {
  const raw = rawCart({ currency: "EGP", abandonedEmailCount: 0 });
  Object.assign(raw.items[0], { productName: "Toy", productImageUrl: null, variantOptionsSnapshot: [] });
  const state = fixture(t, raw);
  await updateCartItemQuantityService({ ...args, quantity: 4 });
  await updateCartItemQuantityService({ ...args, quantity: 6 });
  assert.equal(state.updates.length, 2);
  for (const { filter, update } of state.updates) {
    assert.equal(filter.__v, 7);
    assert.equal(update.$inc?.__v, undefined);
  }
  assert.equal(state.updates[0].update.$set["items.0.quantity"], 4);
  assert.equal(state.updates[1].update.$set["items.0.quantity"], 6);
});

test("clear remains owner-scoped without a version predicate and excludes bundle carts", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await clearCartService(args), { success: true });
  assert.deepEqual(state.deletes, [{ user: U, $and: [{ $or: [{ bundles: { $exists: false } }, { bundles: { $size: 0 } }] }] }]);
  assert.equal(state.updates.length, 0);
});

test("first-cart creation inserts a new ID without an owner uniqueness guard", async (t) => {
  const state = fixture(t, null);
  await upsertCartItemService(args);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0].user, U);
  assert.equal(state.inserts[0].__v, 0);
  assert.ok(state.inserts[0].checkoutKey);
  const userIndex = CartModel.schema.indexes().find(([keys]) => keys.user === 1);
  assert.ok(userIndex); assert.notEqual(userIndex[1].unique, true);
});

test("competing first-cart requests emit distinct inserts for the same user", async (t) => {
  const state = fixture(t, null);
  await Promise.all([upsertCartItemService(args), upsertCartItemService(args)]);
  assert.equal(state.inserts.length, 2);
  assert.equal(state.inserts[0].user, U); assert.equal(state.inserts[1].user, U);
  assert.notEqual(state.inserts[0]._id, state.inserts[1]._id);
});

test("guest adoption changes user identity without a version predicate or user uniqueness", async (t) => {
  const raw = rawCart({ guestId: "guest-test" }); delete raw.user;
  const state = fixture(t, raw);
  await mergeGuestCartService({ userId: U, guestId: "guest-test", warehouseId: W });
  const adoption = state.updates[0];
  assert.equal(adoption.update.$set.user, U);
  assert.equal(Object.hasOwn(adoption.filter, "__v"), false);
  assert.equal(adoption.update.$inc?.__v, undefined);
  assert.equal(state.updates[1].filter.__v, 7);
});

test("scalar address/key saves do not guard versions and do not replace cart items", async (t) => {
  const state = fixture(t);
  const doc = CartModel.hydrate(rawCart());
  doc.warehouse = "666666666666666666666666";
  doc.deliveryAddress = { name: "Updated address" };
  doc.checkoutKey = "rotated-key";
  await doc.save();
  const { filter, update } = state.updates[0];
  assert.equal(Object.hasOwn(filter, "__v"), false);
  assert.equal(update.$inc?.__v, undefined);
  assert.equal(Object.hasOwn(update.$set, "items"), false);
  assert.equal(Object.hasOwn(update.$set, "totalCartPrice"), false);
});

test("Mongoose direct payment-style clearing does not add a version guard or increment", async (t) => {
  const state = fixture(t);
  await CartModel.updateOne({ user: U }, { items: [], totalCartPrice: 0, lastActivityAt: new Date(), status: "ACTIVE" });
  const { filter, update } = state.updates[0];
  assert.deepEqual(filter, { user: U, $and: [{ $or: [{ bundles: { $exists: false } }, { bundles: { $size: 0 } }] }] });
  assert.equal(update.$inc?.__v, undefined);
  assert.deepEqual(update.$set.items, []);
});
