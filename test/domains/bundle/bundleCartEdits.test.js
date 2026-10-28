import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, G, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { AddressModel } from "../../../src/domains/address/address.model.js";

const A = "888888888888888888888888", Q = "999999999999999999999999";
function edits(t, options = { ordinary: true }) {
  const s = fixture(t, options);
  if (s.cart) s.cart.bundles = [{ id: G, bundleId: "444444444444444444444444", bundleRevision: 2, quantity: 2, unitPricePiastres: 1500 }];
  s.edit = (action, values = {}) => { s.args.change = { action, cartId: String(s.cart?._id ?? A), expectedCartVersion: s.cart?.__v ?? 7, ...values }; };
  s.toOther = () => {
    s.warehouses = [{ _id: W, active: true }, { _id: OTHER, active: true }]; s.expectedWarehouseId = OTHER; s.args.warehouseId = OTHER;
    s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 30 });
  };
  s.address = { _id: new mongoose.Types.ObjectId(A), user: new mongoose.Types.ObjectId(U), guestId: null, warehouse: new mongoose.Types.ObjectId(W),
    name: "Owner", governorate: "Alexandria", area: "Area", phone: "01000000000", building: "1", floor: "2", apartment: "3", details: "Door",
    location: { lat: 31.2, lng: 29.9 }, __v: 0 };
  s.addressWrites = 0;
  t.mock.method(AddressModel, "findOne", filter => {
    let session; return { maxTimeMS() { return this; }, session(value) { session = value; return this; }, lean() {
      assert.equal(session, s.session); assert.equal(String(filter.user), U); assert.equal(String(filter._id), A);
      return Promise.resolve(s.address ? clone(s.address) : null);
    } };
  });
  t.mock.method(AddressModel.collection, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter.user), U); assert.equal(filter.$expr.$eq[0], "$$ROOT");
    s.onAddressFence?.();
    if (s.addressConflict || JSON.stringify(filter.$expr.$eq[1].$literal) !== JSON.stringify(s.address)) return { matchedCount: 0, modifiedCount: 0 };
    s.address.__v = (s.address.__v ?? 0) + update.$inc.__v; s.addressWrites++; return { matchedCount: 1, modifiedCount: 1 };
  });
  const baseAbort = s.abortOnFailure;
  s.abortOnFailure = async fn => {
    const address = clone({ address: s.address });
    try { return await baseAbort(fn); } catch (error) { s.address = address.address; throw error; }
  };
  return s;
}

test("ordinary quantity set refreshes current pricing and preserves bundle groups, address and checkout key", async t => {
  const s = edits(t), groups = clone({ groups: s.cart.bundles }), item = String(s.cart.items[0]._id);
  s.edit("ordinary_set", { itemId: item, quantity: 3 }); await s.prepare();
  assert.equal(s.quote, undefined); assert.equal(s.review.quote.ordinaryItemsBefore[0].quantity, 2);
  assert.equal(s.review.quote.ordinaryItemsAfter[0].quantity, 3); assert.equal(s.review.quote.itemsSubtotalPiastres, 6000);
  await s.stage(); assert.equal(s.cart.items[0].quantity, 3); assert.equal(s.cart.items[0].itemPrice, 10);
  assert.deepEqual(s.cart.bundles, groups.groups); assert.equal(s.cart.checkoutKey, "keep-key"); assert.equal(s.cart.deliveryAddress.name, "Keep address");
});

test("ordinary removal identifies the real item line without unpacking bundle components", async t => {
  const s = edits(t); s.edit("ordinary_remove", { itemId: String(s.cart.items[0]._id) });
  await s.prepare(); await s.stage(); assert.deepEqual(s.cart.items, []); assert.equal(s.cart.bundles[0].quantity, 2); assert.equal(s.cart.totalCartPrice, 30);
});

test("ordinary add increments an existing exact SKU once and retry returns the saved result", async t => {
  const s = edits(t); s.edit("ordinary_add", { productId: P, productType: "SIMPLE", variantId: null, quantity: 2, newItemId: A });
  await s.prepare(); const first = await s.stage(); assert.equal(s.cart.items[0].quantity, 4); assert.equal(s.cart.items.length, 1);
  assert.equal(s.cart.totalCartPrice, 70); assert.deepEqual((await s.stage()).receipt, first.receipt); assert.equal(s.cart.items[0].quantity, 4);
});

test("new ordinary lines retain generated identity and current promotion pricing alongside fixed bundle pricing", async t => {
  const s = edits(t, { ordinary: false }); s.products[0].discountedPrice = 8;
  s.edit("ordinary_add", { productId: P, productType: "SIMPLE", quantity: 1, newItemId: A }); await s.prepare();
  assert.equal(s.review.quote.ordinaryItemsBefore.length, 0); assert.equal(s.review.quote.ordinaryItemsAfter[0].itemPrice, 8);
  await s.stage(); assert.equal(String(s.cart.items[0]._id), A); assert.equal(s.cart.totalCartPrice, 38); assert.equal(s.cart.bundles[0].unitPricePiastres, 1500);
});

test("ordinary add and set cannot silently prune their requested item when warehouse stock is too low", async t => {
  const s = edits(t); s.products[0].warehouseStocks[0].quantity = 1;
  for (const action of ["ordinary_add", "ordinary_set"]) {
    s.edit(action, action === "ordinary_add" ? { productId: P, productType: "SIMPLE", quantity: 2, newItemId: A } : { itemId: String(s.cart.items[0]._id), quantity: 3 });
    await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  }
  assert.equal(s.cart.items[0].quantity, 2); assert.deepEqual(s.writes, []);
});

test("combined stock includes newly increased ordinary quantities and retained bundles", async t => {
  const s = edits(t); s.products[0].warehouseStocks[0].quantity = 6;
  s.edit("ordinary_set", { itemId: String(s.cart.items[0]._id), quantity: 3 });
  await assert.rejects(s.prepare(), { code: "BUNDLE_STOCK_CONFLICT" }); assert.deepEqual(s.writes, []);
});

test("rebind reviews the target warehouse and old address removal, preserving all groups", async t => {
  const s = edits(t); s.toOther(); s.edit("rebind"); const before = clone(s.cart); await s.prepare();
  assert.deepEqual(s.cart, before); assert.equal(s.review.quote.warehouseBefore, W); assert.equal(s.review.quote.warehouseAfter, OTHER);
  assert.equal(s.review.quote.deliveryAddressBefore.name, "Keep address"); assert.equal(s.review.quote.deliveryAddressAfter, null);
  await s.stage(); assert.equal(String(s.cart.warehouse), OTHER); assert.equal(s.cart.deliveryAddress, undefined);
  assert.equal(s.cart.bundles[0].id, G); assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.cart.totalCartPrice, 50);
});

test("rebind never borrows old warehouse stock or silently drops an unavailable bundle", async t => {
  const s = edits(t); s.toOther(); s.products[0].warehouseStocks[1].quantity = 3; s.edit("rebind");
  await assert.rejects(s.prepare(), { code: "BUNDLE_STOCK_CONFLICT" }); assert.equal(String(s.cart.warehouse), W); assert.equal(s.cart.bundles.length, 1);
});

test("unavailable ordinary lines removed on rebind appear before/after and in the removal review", async t => {
  const s = edits(t); s.cart.items[0].product = new mongoose.Types.ObjectId(Q); s.toOther(); s.edit("rebind");
  await s.prepare(); assert.equal(s.review.quote.ordinaryItemsBefore.length, 1); assert.equal(s.review.quote.ordinaryItemsAfter.length, 0);
  assert.equal(s.review.quote.removedOrdinaryItems.length, 1); await s.stage(); assert.deepEqual(s.cart.items, []); assert.equal(s.cart.totalCartPrice, 30);
});

test("same-warehouse rebind retains the saved address", async t => {
  const s = edits(t); s.edit("rebind"); await s.prepare(); await s.stage(); assert.equal(s.cart.deliveryAddress.name, "Keep address");
});

test("selecting an owned address reuses its saved snapshot and effective warehouse resolution", async t => {
  const s = edits(t); s.toOther(); s.address.warehouse = new mongoose.Types.ObjectId(OTHER); s.edit("address", { userAddressId: A });
  await s.prepare(); assert.equal(s.review.quote.deliveryAddressAfter.userAddressId, A); assert.match(s.review.quote.addressFingerprint, /^[a-f\d]{64}$/);
  await s.stage(); assert.equal(String(s.cart.warehouse), OTHER); assert.equal(String(s.cart.deliveryAddress.userAddressId), A);
  assert.equal(s.cart.deliveryAddress.name, "Owner"); assert.equal(s.addressWrites, 1); assert.equal(s.cart.bundles[0].quantity, 2);
});

test("a configured address-zone fallback must equal the app-resolved warehouse and remains a zone snapshot", async t => {
  const s = edits(t); s.toOther(); s.warehouses[0].fulfillment = { status: "MAINTENANCE", fallbackWarehouse: OTHER };
  s.edit("address", { userAddressId: A }); await s.prepare(); await s.stage();
  assert.equal(String(s.cart.warehouse), OTHER); assert.equal(String(s.cart.deliveryAddress.warehouse), W);
});

test("foreign, guest and missing addresses or mismatched effective warehouses cannot change the cart", async t => {
  const s = edits(t); s.edit("address", { userAddressId: A });
  const original = clone(s.address);
  for (const value of [null, { ...original, user: new mongoose.Types.ObjectId(OTHER) }, { ...original, guestId: "guest" }]) {
    s.address = value; await assert.rejects(s.prepare(), { code: "BUNDLE_CART_ADDRESS_NOT_FOUND" });
  }
  s.address = original; s.toOther(); await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

test("address edits between review and confirmation invalidate the whole reviewed action", async t => {
  const s = edits(t); s.edit("address", { userAddressId: A }); await s.prepare(); s.address.details = "Changed";
  await assert.rejects(s.stage(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

test("same-version address and cart races fail their exact preimage fences", async t => {
  const s = edits(t); s.edit("address", { userAddressId: A }); await s.prepare(); s.addressConflict = true;
  await assert.rejects(s.abortOnFailure(() => s.stage()), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.equal(s.user.__v, 3); assert.equal(s.cart.__v, 7);
  s.addressConflict = false; s.onWrite = () => { s.cart.checkoutKey = "changed"; };
  await assert.rejects(s.abortOnFailure(() => s.stage()), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.equal(s.address.__v, 0); assert.equal(s.receipts.length, 0);
});

test("receipt failure rolls back warehouse, address, ordinary edits and eligibility metadata in the fixture", async t => {
  const s = edits(t); s.toOther(); s.address.warehouse = new mongoose.Types.ObjectId(OTHER); s.edit("address", { userAddressId: A }); await s.prepare();
  const before = clone({ cart: s.cart, address: s.address, user: s.user }); s.failReceipt = true;
  await assert.rejects(s.abortOnFailure(() => s.stage()), /receipt unavailable/);
  assert.deepEqual(s.cart, before.cart); assert.deepEqual(s.address, before.address); assert.deepEqual(s.user, before.user); assert.equal(s.receipts.length, 0);
});

test("stale or replacement cart identities, unknown ordinary line IDs and invalid request fields fail closed", async t => {
  const s = edits(t); s.edit("ordinary_remove", { itemId: A }); await assert.rejects(s.prepare(), { code: "BUNDLE_CART_ITEM_NOT_FOUND" });
  s.edit("rebind", { cartId: A }); await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.edit("rebind", { expectedCartVersion: 6 }); await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.edit("ordinary_set", { itemId: String(s.cart.items[0]._id), quantity: 0 }); await assert.rejects(s.prepare(), { code: "BUNDLE_INVALID_REQUEST" });
  s.edit("address", { userAddressId: A, location: { lat: 1, lng: 2 } }); await assert.rejects(s.prepare(), { code: "BUNDLE_INVALID_REQUEST" }); assert.deepEqual(s.writes, []);
});

test("exact variant additions do not merge into sibling variants and aggregate their own warehouse demand", async t => {
  const s = edits(t, { ordinary: false });
  s.products.push({ _id: Q, type: "VARIANT", isActive: true, name_en: "Variant toy", variants: [
    { _id: A, price: 5, options: [{ name: "color", value: "red" }], warehouseStocks: [{ warehouse: W, quantity: 3 }] },
    { _id: OTHER, price: 5, options: [], warehouseStocks: [{ warehouse: W, quantity: 1000 }] },
  ] });
  s.edit("ordinary_add", { productId: Q, productType: "VARIANT", variantId: A, quantity: 2, newItemId: OTHER }); await s.prepare(); await s.stage();
  assert.equal(String(s.cart.items[0].variantId), A); assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.cart.totalCartPrice, 40);
});
