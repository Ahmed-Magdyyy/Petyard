import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, R, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
test("preview loads exact warehouse sources and refreshes only a private ordinary slice", async t => {
  const s = fixture(t, { ordinary: true }), before = clone(s.cart); await s.prepare();
  assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []);
  assert.equal(s.review.quote.ordinaryItemsBefore[0].itemPrice, 7);
  assert.equal(s.review.quote.ordinaryItemsAfter[0].itemPrice, 10);
  assert.equal(s.review.quote.itemsSubtotalPiastres, 6500); assert.equal(s.review.quote.demands[0].quantity, 8);
});

test("existing cart, account fence and immutable receipt are staged in the same caller transaction", async t => {
  const s = fixture(t, { ordinary: true }); await s.prepare(); const address = clone(s.cart.deliveryAddress);
  const result = await s.stage(); assert.equal(result.duplicate, false);
  assert.deepEqual(s.writes, ["user", "cart", "receipt"]); assert.equal(s.cart.__v, 8); assert.equal(s.user.__v, 4);
  assert.equal(s.cart.bundles[0].quantity, 3); assert.equal(s.cart.items[0].itemPrice, 10); assert.equal(s.cart.totalCartPrice, 65);
  assert.equal(s.cart.checkoutKey, "keep-key"); assert.deepEqual(s.cart.deliveryAddress, address); assert.equal(s.cart.abandonedAt, undefined);
  assert.equal(result.receipt.result.cartId, String(s.cart._id)); assert.equal(result.receipt.proposalId, R);
});

test("new cart uses one raw insert with validated group shape and a real stable result ID", async t => {
  const s = fixture(t, { existing: false }); await s.prepare(); assert.equal(s.review.quote.cartId, null);
  const first = await s.stage(); assert.deepEqual(s.writes, ["user", "insert", "receipt"]);
  assert.equal(first.receipt.cartId, String(s.cart._id)); assert.equal(s.cart.__v, 0); assert.ok(s.cart.checkoutKey);
  assert.equal(s.cart.totalCartPrice, 45); assert.deepEqual((await s.recover()).receipt, first.receipt);
});

test("lost-response retry returns the saved result without reloading or mutating the later cart/catalog", async t => {
  const s = fixture(t); await s.prepare(); const first = await s.stage();
  s.cart.bundles = []; s.definitions = []; s.products = []; const reads = s.reads.length;
  assert.deepEqual((await s.stage()).receipt, first.receipt); assert.deepEqual(s.reads.slice(reads), ["user", "receipt"]);
  assert.deepEqual(s.writes, ["user", "cart", "receipt"]); assert.deepEqual(s.cart.bundles, []);
});

test("receipt key binds the review fingerprint, input, language and complete quote", async t => {
  const s = fixture(t); await s.prepare(); await s.stage();
  for (const [review, args] of [
    [{ ...s.review, proposalFingerprint: "b".repeat(64) }, s.args],
    [{ ...s.review, quote: { ...s.review.quote, itemsSubtotalPiastres: 1 } }, s.args],
    [s.review, { ...s.args, language: "ar" }],
    [s.review, { ...s.args, change: { ...s.args.change, quantity: 1 } }],
  ]) await assert.rejects(s.stage(review, args), { code: "BUNDLE_CART_IDEMPOTENCY_CONFLICT" });
  assert.equal(s.writes.length, 3);
});

test("changed bundle price/revision, source stock or ordinary price invalidates the review before writes", async t => {
  const s = fixture(t, { ordinary: true }); await s.prepare();
  s.definitions[0].pricePiastres = 1400; await assert.rejects(s.stage(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.definitions[0].pricePiastres = 1500; s.definitions[0].revision = 3; await assert.rejects(s.stage(), { code: "BUNDLE_REVISION_CONFLICT" });
  s.definitions[0].revision = 2; s.products[0].warehouseStocks[0].quantity = 7; await assert.rejects(s.stage(), { code: "BUNDLE_STOCK_CONFLICT" });
  s.products[0].warehouseStocks[0].quantity = 30; s.products[0].discountedPrice = 9;
  await assert.rejects(s.stage(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

test("cart preimage detects concurrent address or checkout-key changes without a version advance", async t => {
  const s = fixture(t); await s.prepare();
  for (const change of [() => { s.cart.deliveryAddress.area = "Changed"; }, () => { s.cart.checkoutKey = "changed"; }]) {
    s.onWrite = change; await assert.rejects(s.abortOnFailure(() => s.stage()), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
    assert.equal(s.cart.__v, 7); assert.equal(s.user.__v, 3); assert.equal(s.receipts.length, 0);
  }
});

test("caller abort restores cart and account metadata when receipt insertion fails", async t => {
  for (const existing of [true, false]) {
    const s = fixture(t, { existing }); await s.prepare(); const before = clone({ cart: s.cart, user: s.user }); s.failReceipt = true;
    await assert.rejects(s.abortOnFailure(() => s.stage()), /receipt unavailable/);
    assert.deepEqual(s.cart, before.cart); assert.deepEqual(s.user, before.user); assert.equal(s.receipts.length, 0);
    t.mock.restoreAll();
  }
});

test("account fence conflict and duplicate new-cart race are propagated without retry or receipt", async t => {
  const s = fixture(t, { existing: false }); await s.prepare(); s.fenceConflict = true;
  await assert.rejects(s.stage(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, ["user"]);
  s.fenceConflict = false; s.duplicateCart = true;
  await assert.rejects(s.abortOnFailure(() => s.stage()), { code: 11000 }); assert.equal(s.receipts.length, 0); assert.equal(s.cart, null);
});

test("missing transaction and malformed external fields reject before source reads", async t => {
  const s = fixture(t); s.review = { proposalId: R, proposalFingerprint: "a".repeat(64), quote: {} };
  for (const session of [null, {}, { inTransaction: () => false }]) await assert.rejects(s.stage(s.review, s.args, session), { code: "BUNDLE_CART_TRANSACTION_REQUIRED" });
  await assert.rejects(s.stage(s.review, { ...s.args, price: 1 }), { code: "BUNDLE_INVALID_REQUEST" });
  await assert.rejects(s.stage({ ...s.review, proposalFingerprint: "bad" }), { code: "BUNDLE_INVALID_REQUEST" });
  await assert.rejects(s.stage({ ...s.review, quote: { huge: "x".repeat(65536) } }), { code: "BUNDLE_CART_REVIEW_TOO_LARGE" });
  assert.deepEqual(s.reads, []); assert.deepEqual(s.writes, []);
});

test("unsafe/missing indexes and TTL fail without setup or data writes", async t => {
  const s = fixture(t); await s.prepare();
  for (const index of [null, { key: { user: 1 } }, { key: { user: 1 }, unique: true, sparse: true },
    { key: { user: 1 }, unique: true, partialFilterExpression: { active: true } }]) {
    s.cartIndexes = index ? [index] : []; await assert.rejects(s.stage(), { code: "BUNDLE_CART_STORE_UNAVAILABLE" });
  }
  s.cartIndexes = [{ key: { user: 1 }, unique: true }]; s.receiptIndexes.push({ key: { recordedAt: 1 }, expireAfterSeconds: 10 });
  await assert.rejects(s.stage(), { code: "BUNDLE_CART_STORE_UNAVAILABLE" });
  s.receiptIndexes = []; await assert.rejects(s.stage(), { code: "BUNDLE_CART_STORE_UNAVAILABLE" }); assert.deepEqual(s.writes, []);
});

test("fresh account eligibility is required even for receipt recovery", async t => {
  const s = fixture(t); await s.prepare(); await s.stage(); s.user.active = false;
  await assert.rejects(s.recover(), { code: "BUNDLE_ACCESS_DENIED" }); assert.equal(s.writes.length, 3);
});

test("corrupt receipts fail closed and foreign-owner receipts are not disclosed", async t => {
  const s = fixture(t); await s.prepare(); await s.stage(); const record = s.receipts[0];
  const originalHash = record.resultHash; record.resultHash = "0".repeat(64);
  await assert.rejects(s.recover(), { code: "BUNDLE_CART_RECEIPT_UNAVAILABLE" }); record.resultHash = originalHash;
  record.owner = new mongoose.Types.ObjectId(OTHER); assert.equal(await s.recover(), null);
});

test("malformed saved groups, missing cart version and wrong warehouse fail before mutation", async t => {
  const s = fixture(t);
  for (const value of [null, {}, [null]]) {
    s.cart.bundles = value; await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  }
  delete s.cart.bundles; delete s.cart.__v; await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.cart.__v = 7; s.cart.warehouse = new mongoose.Types.ObjectId(OTHER);
  await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

test("last group removal can complete with a deleted definition and no surviving product sources", async t => {
  const s = fixture(t); s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 1, unitPricePiastres: 1500 }];
  s.definitions = []; s.products = []; s.args.change = { action: "remove", groupId: G };
  await s.prepare(); await s.stage(); assert.deepEqual(s.cart.bundles, []); assert.equal(s.cart.totalCartPrice, 0);
});

test("absolute quantity update preserves group identity", async t => {
  const s = fixture(t); s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 3, unitPricePiastres: 1500 }];
  s.args.change = { action: "set", groupId: G, quantity: 1 }; await s.prepare(); await s.stage();
  assert.equal(s.cart.bundles[0].id, G); assert.equal(s.cart.bundles[0].quantity, 1); assert.equal(s.cart.totalCartPrice, 15);
});

test("an exact variant cannot borrow stock from a sibling variant or another warehouse", async t => {
  const s = fixture(t);
  s.products[0] = { ...s.products[0], type: "VARIANT", variants: [
    { _id: OTHER, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 5 }, { warehouse: OTHER, quantity: 1000 }] },
    { _id: G, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 1000 }] },
  ] };
  s.definitions[0].components = [{ productId: P, productType: "VARIANT", variantId: OTHER, quantity: 2 }];
  await assert.rejects(s.prepare(), { code: "BUNDLE_STOCK_CONFLICT" });
  s.products[0].variants[0].warehouseStocks[0].quantity = 6; await s.prepare(); await s.stage();
  assert.equal(s.receipts[0] && s.review.quote.demands[0].variantId, OTHER); assert.equal(s.cart.totalCartPrice, 45);
});

test("ordinary removals must appear in the review and cannot change silently on confirmation", async t => {
  const s = fixture(t, { ordinary: true });
  const missing = new mongoose.Types.ObjectId(OTHER);
  s.cart.items[0].product = missing; await s.prepare();
  assert.equal(s.review.quote.ordinaryItemsBefore.length, 1); assert.equal(s.review.quote.ordinaryItemsAfter.length, 0);
  assert.equal(s.review.quote.removedOrdinaryItems.length, 1); assert.equal(s.cart.items.length, 1);
  const review = s.review; s.cart.items[0].product = new mongoose.Types.ObjectId(P);
  await assert.rejects(s.stage(review), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
  s.cart.items[0].product = missing; await s.stage(review); assert.equal(s.cart.items.length, 0); assert.equal(s.cart.totalCartPrice, 45);
});

test("unavailable warehouse, malformed definition and unsafe ordinary data fail without a write", async t => {
  const s = fixture(t, { ordinary: true }); s.warehouse.active = false;
  await assert.rejects(s.prepare(), { code: "BUNDLE_WAREHOUSE_UNAVAILABLE" }); s.warehouse.active = true;
  s.definitions[0].components = {}; await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" });
  s.cart.items[0].quantity = 1.5; await assert.rejects(s.prepare(), /Cart items are unavailable/); assert.deepEqual(s.writes, []);
});
