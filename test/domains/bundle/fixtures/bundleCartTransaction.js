import assert from "node:assert/strict";

import mongoose from "mongoose";
import { CartModel } from "../../../../src/domains/cart/cart.model.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../../src/domains/collection/collection.model.js";
import { ManualBundle } from "../../../../src/domains/bundle/bundle.model.js";
import { AssistantCartReceipt } from "../../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { previewBundleCartChange, stageBundleCartChangeWithReceipt, recoverBundleCartChange } from "../../../../src/domains/bundle/bundle.cart-transaction.js";

export const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
export const B = "444444444444444444444444", G = "555555555555555555555555", R = "666666666666666666666666";
export const OTHER = "777777777777777777777777";
export const clone = value => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
export const plain = value => JSON.parse(JSON.stringify(value));

export function fixture(t, { existing = true, ordinary = false, guest = false } = {}) {
  const s = { active: true, reads: [], writes: [], receipts: [],
    user: { _id: new mongoose.Types.ObjectId(U), role: "user", active: true, phoneVerified: true, __v: 3 },
    warehouse: { _id: W, active: true },
    products: [{ _id: P, type: "SIMPLE", isActive: true, price: 10, name_en: "Food", name_ar: "أكل", images: [],
      warehouseStocks: [{ warehouse: W, quantity: 30 }] }],
    definitions: [{ _id: B, origin: "manual", status: "published", revision: 2, name_en: "Pair", pricePiastres: 1500,
      components: [{ productId: P, productType: "SIMPLE", quantity: 2 }] }],
    cartIndexes: [{ key: { user: 1 }, unique: true, partialFilterExpression: { user: { $type: "objectId" } } }],
    receiptIndexes: [{ name: "_id_", key: { _id: 1 } }],
  };
  s.guestId = guest ? "guest-bundle-fixture" : undefined;
  s.assertOwnerFilter = filter => {
    if (guest) { assert.equal(filter.user, null); assert.equal(filter.guestId, s.guestId); }
    else assert.equal(String(filter.user), U);
  };
  if (guest) s.cartIndexes.push({ key: { guestId: 1 }, unique: true,
    partialFilterExpression: { guestId: { $type: "string" }, user: null } });
  s.cart = existing ? new CartModel({ ...(guest ? { user: null, guestId: s.guestId } : { user: U }), warehouse: W, __v: 7, checkoutKey: "keep-key", currency: "EGP",
    deliveryAddress: { name: "Keep address", area: "Keep area" }, abandonedAt: new Date(),
    items: ordinary ? [{ product: P, productType: "SIMPLE", quantity: 2, itemPrice: 7 }] : [], totalCartPrice: ordinary ? 14 : 0 }).toObject() : null;
  s.session = { inTransaction: () => s.active };
  function query(label, read) {
    let session;
    return { select() { return this; }, maxTimeMS() { return this; }, lean() { return this; },
      session(value) { session = value; return this; }, then(resolve, reject) {
        return Promise.resolve().then(() => {
          assert.equal(session, s.session, `${label} must use the caller session`);
          s.reads.push(label); return read();
        }).then(resolve, reject);
      } };
  }
  t.mock.method(UserModel, "findById", () => { if (guest) assert.fail("Guest shopping must not load a user account"); return query("user", () => clone(s.user)); });
  t.mock.method(WarehouseModel, "findById", id => query("warehouse", () => {
    if (s.warehouses) return s.warehouses.find(row => String(row._id) === String(id)) ?? null;
    assert.equal(String(id), W); return s.warehouse;
  }));
  t.mock.method(CartModel, "findOne", filter => query("cart", () => { s.assertOwnerFilter(filter);
    return s.cart && (filter._id == null || String(filter._id) === String(s.cart._id)) ? clone(s.cart) : null; }));
  t.mock.method(ManualBundle, "find", filter => query("definitions", () => s.definitions.filter(row => filter._id.$in.some(id => String(id) === String(row._id)))));
  t.mock.method(ProductModel, "find", filter => query("products", () => {
    if (filter.$or) {
      assert.equal(filter.isActive, true);
      assert.equal(String(filter.$or[0].warehouseStocks.$elemMatch.warehouse), s.expectedWarehouseId ?? W);
      assert.equal(String(filter.$or[1].variants.$elemMatch.warehouseStocks.$elemMatch.warehouse), s.expectedWarehouseId ?? W);
      assert.deepEqual(filter.$or[0].warehouseStocks.$elemMatch.quantity, { $gt: 0 });
    }
    return s.products;
  }));
  t.mock.method(CollectionModel, "findOne", () => query("promotion", () => s.promotion ?? null));
  t.mock.method(CollectionModel, "updateMany", () => assert.fail("no promotion maintenance"));
  t.mock.method(CartModel.prototype, "save", () => assert.fail("no ordinary cart save"));
  t.mock.method(CartModel.collection, "indexes", async () => s.cartIndexes);
  t.mock.method(AssistantCartReceipt.collection, "indexes", async () => s.receiptIndexes);
  t.mock.method(UserModel.collection, "updateOne", async (filter, update, options) => {
    if (guest) assert.fail("Guest shopping must not write a user account");
    assert.equal(options.session, s.session);
    assert.deepEqual(filter.deletedAt, { $exists: false });
    assert.deepEqual(filter.account_status, { $exists: false });
    s.writes.push("user");
    if (s.fenceConflict) return { matchedCount: 0, modifiedCount: 0 };
    s.user.__v += update.$inc.__v; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, s.session); s.assertOwnerFilter(filter); assert.equal(filter.__v, s.expectedCartVersion ?? s.cart?.__v ?? 7);
    assert.equal(filter.$expr.$eq[0], "$$ROOT"); assert.doesNotThrow(() => mongoose.mongo.BSON.serialize(filter));
    s.onWrite?.(); s.writes.push("cart");
    if (s.forceMismatch || JSON.stringify(plain(filter.$expr.$eq[1].$literal)) !== JSON.stringify(plain(s.cart))) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(s.cart, update.$set); for (const key of Object.keys(update.$unset ?? {})) delete s.cart[key];
    s.cart.__v += update.$inc.__v; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel.collection, "insertOne", async (row, options) => {
    assert.equal(options.session, s.session); s.writes.push("insert");
    if (s.duplicateCart) throw Object.assign(new Error("duplicate owner"), { code: 11000 });
    assert.equal(new CartModel(row).validateSync(), undefined); s.cart = clone(row); return { insertedId: row._id };
  });
  t.mock.method(AssistantCartReceipt, "findOne", filter => query("receipt", () => s.receipts.find(row =>
    String(row._id) === String(filter._id) && String(row.owner) === String(filter.owner)) ?? null));
  t.mock.method(AssistantCartReceipt, "create", async ([row], options) => {
    assert.equal(options.session, s.session); s.writes.push("receipt");
    if (s.failReceipt) throw Error("receipt unavailable");
    const doc = new AssistantCartReceipt(row); assert.equal(doc.validateSync(), undefined);
    s.receipts.push(doc.toObject()); return [doc];
  });
  s.actor = guest ? { guestId: s.guestId } : { ...s.user };
  s.args = { warehouseId: W, language: "en", change: { action: "add", bundleId: B, expectedRevision: 2, quantity: 3, newGroupId: G } };
  s.prepare = async () => { s.review = { proposalId: R, proposalFingerprint: "a".repeat(64),
    quote: await previewBundleCartChange(s.actor, s.args, { session: s.session }) }; };
  s.stage = (review = s.review, args = s.args, session = s.session) => stageBundleCartChangeWithReceipt(s.actor, args, review, { session });
  s.recover = () => recoverBundleCartChange(s.actor, s.args, s.review, { session: s.session });
  // Fixture-only caller abort. This is not proof of MongoDB rollback or commit behavior.
  s.abortOnFailure = async fn => {
    const snapshot = clone({ cart: s.cart, user: s.user, receipts: s.receipts });
    try { return await fn(); } catch (error) { Object.assign(s, snapshot); throw error; }
  };
  return s;
}

