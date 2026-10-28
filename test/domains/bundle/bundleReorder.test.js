import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";
import { buildBundleOrderMerchandise } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { bundleCartReviewInput } from "../../../src/domains/assistant/customer/assistant.bundle-cart.validation.js";

const O = "888888888888888888888888";
function reorder(t, { ordinary = true, variant = false } = {}) {
  const s = fixture(t, { ordinary });
  if (variant) {
    Object.assign(s.products[0], { type: "VARIANT", variants: [{ _id: OTHER, price: 10, options: [], images: [], warehouseStocks: [{ warehouse: W, quantity: 30 }] }] });
    s.definitions[0].components = [{ productId: P, productType: "VARIANT", variantId: OTHER, quantity: 2 }];
    if (ordinary) Object.assign(s.cart.items[0], { productType: "VARIANT", variantId: new mongoose.Types.ObjectId(OTHER) });
  }
  const plan = buildBundleCartPurchasePlan({ warehouseId: W, warehouse: s.warehouse, products: s.products,
    bundles: [{ groupId: G, bundle: s.definitions[0], expectedRevision: 2, quantity: 2 }] });
  const ordinaryItems = ordinary ? [{ product: new mongoose.Types.ObjectId(P), productType: variant ? "VARIANT" : "SIMPLE", ...(variant ? { variantId: OTHER } : {}), productName: "Food", quantity: 3,
    fulfillmentQuantity: 3, finalizedUnavailableQuantity: 0, itemPrice: 10, lineTotal: 30, lineId: "ordinary", lineKind: "original" }] : [];
  s.order = { _id: new mongoose.Types.ObjectId(O), user: new mongoose.Types.ObjectId(U), warehouse: W, currency: "EGP", __v: 0,
    subtotal: ordinary ? 60 : 30, ...buildBundleOrderMerchandise({ plan, ordinaryItems, userId: U }) };
  t.mock.method(OrderModel, "findOne", filter => {
    assert.equal(String(filter._id), O); assert.equal(String(filter.user), U);
    let session; return { select(value) { assert.equal(value, "+checkoutKey"); return this; }, maxTimeMS() { return this; }, session(value) { session = value; return this; }, lean() {
      assert.equal(session, s.session); s.reads.push("reorder-source"); return Promise.resolve(s.order ? clone(s.order) : null);
    } };
  });
  t.mock.method(OrderModel.collection, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, s.session); assert.equal(String(filter.user), U);
    s.writes.push("order-fence");
    if (s.orderConflict || !mongoose.mongo.BSON.serialize(filter.$expr.$eq[1].$literal).equals(mongoose.mongo.BSON.serialize(s.order))) return { matchedCount: 0, modifiedCount: 0 };
    s.order.__v = (s.order.__v ?? 0) + update.$inc.__v; return { matchedCount: 1, modifiedCount: 1 };
  });
  s.args.change = { action: "reorder", cartId: String(s.cart._id), expectedCartVersion: 7, orderId: O };
  const abort = s.abortOnFailure;
  s.abortOnFailure = async fn => { const order = clone(s.order); try { return await abort(fn); } catch (error) { s.order = order; throw error; } };
  return s;
}

test("reorder previews complete groups at current prices and overwrites matching ordinary quantities", async t => {
  const s = reorder(t), before = clone(s.cart); s.definitions[0].pricePiastres = 1200; s.definitions[0].revision = 3;
  await s.prepare(); assert.deepEqual(s.cart, before); assert.deepEqual(s.writes, []);
  assert.equal(s.review.quote.groupsAfter[0].quantity, 2); assert.equal(s.review.quote.groupsAfter[0].bundleRevision, 3);
  assert.equal(s.review.quote.groupsAfter[0].unitPricePiastres, 1200); assert.equal(s.review.quote.itemsSubtotalPiastres, 5400);
  assert.equal(s.review.quote.reorderOrderId, O); assert.match(s.review.quote.reorderFingerprint, /^[a-f\d]{64}$/);
  assert.equal(s.review.quote.sourceOrder, undefined);
  await s.stage(); assert.equal(s.cart.items.length, 1); assert.equal(s.cart.items[0].quantity, 3);
  assert.equal(s.cart.bundles.length, 1); assert.equal(s.cart.totalCartPrice, 54); assert.equal(s.order.__v, 1);
  assert.equal(s.cart.checkoutKey, "keep-key"); assert.equal(s.cart.deliveryAddress.name, "Keep address");
});

test("existing bundle identity is retained and its quantity is overwritten rather than added", async t => {
  const s = reorder(t, { ordinary: false }); s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 9, unitPricePiastres: 1500 }];
  await s.prepare(); await s.stage(); assert.equal(s.cart.bundles[0].id, G); assert.equal(s.cart.bundles[0].quantity, 2);
  assert.deepEqual(s.cart.items, []); assert.equal(s.cart.totalCartPrice, 30);
});

test("unrelated cart lines remain and count against combined exact-warehouse stock", async t => {
  const s = reorder(t, { ordinary: false }); s.cart.items.push({ _id: new mongoose.Types.ObjectId(), product: new mongoose.Types.ObjectId(P), productType: "SIMPLE", quantity: 2, itemPrice: 10 });
  s.products[0].warehouseStocks[0].quantity = 5;
  await assert.rejects(s.prepare(), { code: "BUNDLE_STOCK_CONFLICT" }); assert.deepEqual(s.writes, []);
});

test("final ordinary fulfilled quantities are aggregated while bundle cohorts are never ordinary lines", async t => {
  const s = reorder(t), row = s.order.items[0]; row.fulfillmentQuantity = 1; row.finalizedUnavailableQuantity = 2;
  s.order.items.push({ ...clone(row), lineId: "substitute", lineKind: "substitute", quantity: 1, fulfillmentQuantity: 1, finalizedUnavailableQuantity: 0, sourceSubstitutionRequest: OTHER });
  s.order.subtotal = 50; await s.prepare(); await s.stage(); assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.cart.bundles[0].quantity, 2);
});

test("all requested ordinary goods must survive refresh without dropping or reducing quantity", async t => {
  const s = reorder(t); s.products[0].warehouseStocks[0].quantity = 2;
  await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

for (const change of ["paused", "missing", "stock", "other_warehouse"]) test(`${change} bundle cannot partially reorder`, async t => {
  const s = reorder(t);
  if (change === "paused") s.definitions[0].status = "paused";
  if (change === "missing") s.definitions = [];
  if (change === "stock") s.products[0].warehouseStocks[0].quantity = 6;
  if (change === "other_warehouse") s.products[0].warehouseStocks = [{ warehouse: OTHER, quantity: 100 }];
  await assert.rejects(s.prepare()); assert.deepEqual(s.writes, []); assert.equal(s.cart.items[0].quantity, 2);
});

test("the app warehouse determines reorder stock even when the historical order used another warehouse", async t => {
  const s = reorder(t); s.order.warehouse = OTHER; s.order.bundleGroups[0].warehouseId = OTHER;
  await s.prepare(); await s.stage(); assert.equal(s.review.quote.warehouseId, W); assert.equal(s.review.quote.groups[0].warehouseId, W);
});

for (const source of ["missing", "foreign", "guest", "corrupt", "unsafe_version"]) test(`${source} order source refuses before writes`, async t => {
  const s = reorder(t);
  if (source === "missing") s.order = null;
  if (source === "foreign") s.order.user = OTHER;
  if (source === "guest") s.order.guestId = "guest";
  if (source === "corrupt") s.order.bundleGroups[0].quantity++;
  if (source === "unsafe_version") s.order.__v = Number.MAX_SAFE_INTEGER;
  await assert.rejects(s.prepare()); assert.deepEqual(s.writes, []);
});

for (const changed of ["order", "definition", "cart"]) test(`changed ${changed} invalidates confirmation before writes`, async t => {
  const s = reorder(t); await s.prepare();
  if (changed === "order") s.order.__v++;
  if (changed === "definition") s.definitions[0].revision++;
  if (changed === "cart") s.cart.__v++;
  await assert.rejects(s.stage(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});

for (const failure of ["orderConflict", "forceMismatch", "failReceipt"]) test(`${failure} aborts cart, account, order fence and receipt`, async t => {
  const s = reorder(t); await s.prepare(); const before = clone({ cart: s.cart, user: s.user, order: s.order }); s[failure] = true;
  await assert.rejects(s.abortOnFailure(() => s.stage())); assert.deepEqual({ cart: s.cart, user: s.user, order: s.order }, before); assert.deepEqual(s.receipts, []);
});

test("committed retry recovers without source order reads or a second cart write", async t => {
  const s = reorder(t); await s.prepare(); const first = await s.stage(), writes = s.writes.length;
  s.order = null; s.reads = []; const second = await s.stage();
  assert.deepEqual(second.receipt, first.receipt); assert.equal(second.duplicate, true); assert.equal(s.writes.length, writes);
  assert.ok(!s.reads.includes("reorder-source"));
});

test("reorder validation is shopping-only, rejects injected prices and requires cart version", () => {
  const body = { warehouseId: W, language: "en", change: { action: "reorder", cartId: G, expectedCartVersion: 0, orderId: O } };
  assert.throws(() => bundleCartReviewInput(body));
  assert.equal(bundleCartReviewInput(body, { allowReorder: true }).change.orderId, O);
  assert.throws(() => bundleCartReviewInput({ ...body, change: { ...body.change, price: 1 } }, { allowReorder: true }));
  assert.throws(() => bundleCartReviewInput({ ...body, change: { ...body.change, expectedCartVersion: undefined } }, { allowReorder: true }));
});

test("variant reorder retains the exact saved ordinary variant and current fixed bundle variant", async t => {
  const s = reorder(t, { variant: true }); await s.prepare(); await s.stage();
  assert.equal(s.cart.items[0].productType, "VARIANT"); assert.equal(String(s.cart.items[0].variantId), OTHER);
  assert.equal(s.review.quote.groups[0].components[0].variantId, OTHER); assert.equal(s.cart.items[0].quantity, 3);
});

test("stock in a sibling variant cannot supply the reordered variant", async t => {
  const s = reorder(t, { variant: true }); s.products[0].variants[0].warehouseStocks[0].quantity = 0;
  s.products[0].variants.push({ _id: O, price: 10, options: [], warehouseStocks: [{ warehouse: W, quantity: 100 }] });
  await assert.rejects(s.prepare()); assert.deepEqual(s.writes, []);
});

test("changed fixed contents require choosing the current offer instead of silently reordering different goods", async t => {
  const s = reorder(t); s.definitions[0].components[0].quantity++; s.definitions[0].revision++;
  await assert.rejects(s.prepare(), { code: "BUNDLE_CART_REVIEW_REQUIRED" }); assert.deepEqual(s.writes, []);
});
