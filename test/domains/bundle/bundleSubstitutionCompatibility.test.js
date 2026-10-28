import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";
import { buildBundleOrderMerchandise } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { fixture as cartFixture, U, W, P, B, G, R, OTHER, clone } from "./fixtures/bundleCartTransaction.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { SubstitutionRequestModel } from "../../../src/domains/substitution/substitutionRequest.model.js";
import { assertBundleOrderSnapshot } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { bindPendingBundleSubstitution, pendingBundleSubstitutionPiastres } from "../../../src/domains/bundle/bundle.substitution-pending.js";
import { calculateSubstitutionQuote } from "../../../src/domains/substitution/substitution.pricing.js";
import { applyQuoteToLegacyOrderAmounts, buildSubstituteOrderLines } from "../../../src/domains/substitution/substitution.order.js";
import { presentOrder } from "../../../src/domains/order/order.presenter.js";

async function fixture(t, { previousShortage = false, allMissing = false, coupon = false } = {}) {
  const s = cartFixture(t, { ordinary: true });
  const plan = buildBundleCartPurchasePlan({ warehouseId: W, warehouse: s.warehouse, products: s.products,
    bundles: [{ groupId: G, bundle: s.definitions[0], expectedRevision: 2, quantity: 2 }] });
  const merchandise = buildBundleOrderMerchandise({ plan, userId: U, ordinaryItems: [{ product: P, productType: "SIMPLE",
    productName: "Food", quantity: 2, fulfillmentQuantity: 2, finalizedUnavailableQuantity: 0, lineId: "ordinary-line", lineKind: "original",
    itemPrice: 10, itemPricePiastres: 1000, lineTotal: 20, lineTotalPiastres: 2000 }] });
  const discount = coupon ? 200 : 0;
  const order = new OrderModel({ _id: new mongoose.Types.ObjectId("888888888888888888888888"), user: U, warehouse: W,
    orderNumber: "SUBSTITUTION-FIXTURE", currency: "EGP", ...merchandise, subtotal: 50, shippingFee: 50,
    discountAmount: discount / 100, total: 90 - discount / 100, walletUsed: 10,
    paymentMethod: "card", paymentStatus: "paid", status: "accepted", sideEffectsCommitted: true,
    settlement: { schemaVersion: 1, revision: 0, currency: "EGP", migrationState: "native",
      currentMerchandiseGrossPiastres: 5000, originalCouponDiscountPiastres: discount, preservedCouponDiscountPiastres: discount,
      lockedNetShippingPiastres: 5000, currentOrderValuePiastres: 10000 - discount, walletDebitedPiastres: 1000,
      walletCreditedPiastres: 0, cardCapturedPiastres: 9000 - discount, cardRefundedPiastres: 0, cardDuePiastres: 0,
      instapaySubmittedPiastres: 0, instapayConfirmedPiastres: 0, deliveryDuePiastres: 0, pendingRefundLiabilityPiastres: 0 } }).toObject();
  s.orders = [order];
  const line = order.items[0];
  if (previousShortage) {
    line.fulfillmentQuantity = 1; line.finalizedUnavailableQuantity = 1; order.subtotal = 40;
    Object.assign(order.settlement, { currentMerchandiseGrossPiastres: 4000, currentOrderValuePiastres: 9000, walletCreditedPiastres: 1000 });
  }
  const before = line.fulfillmentQuantity, start = line.finalizedUnavailableQuantity;
  line.fulfillmentQuantity = allMissing || previousShortage ? 0 : 1; line.finalizedUnavailableQuantity = start + before - line.fulfillmentQuantity;
  const request = new SubstitutionRequestModel({ _id: R, order: order._id, orderNumber: order.orderNumber, warehouse: W, user: U,
    paymentMethod: "card", requestSequence: 1, status: "offered", isActive: true, offerExpiresAt: new Date(Date.now() + 600000),
    offeredBy: OTHER, offerIdempotencyKey: "test-offer", shortages: [{ shortageId: "shortage", lineId: line.lineId, product: P, productType: "SIMPLE",
      productName_en: "Food", productName_ar: "أكل", quantityBefore: before, deliverableOriginalQuantity: line.fulfillmentQuantity,
      unavailableQuantity: before - line.fulfillmentQuantity, finalizedUnavailableStart: start, finalizedUnavailableEnd: line.finalizedUnavailableQuantity,
      originalUnitPricePiastres: 1000, expectedUnallocatedQuantity: 24, expectedStockRevision: 1, correctedUnallocatedQuantity: 24, alternatives: [] }] });
  await request.validate(); order.activeSubstitutionRequest = request._id; order.substitutionState = "awaiting_customer"; order.requiresCustomerAction = true;
  return { s, order, request, line };
}

test("real typed offer request binds exact pending amount while strict purchased bundle checks stay valid", async t => {
  const { order, request } = await fixture(t); assert.throws(() => assertBundleOrderSnapshot(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
  bindPendingBundleSubstitution(order, request); assert.equal(pendingBundleSubstitutionPiastres(order), 1000);
  assert.doesNotThrow(() => assertBundleOrderSnapshot(order)); await new OrderModel(order).validate();
  assert.equal(order.subtotal, 50); assert.equal(order.settlement.currentMerchandiseGrossPiastres, 5000);
});

test("public presenter validates pending context then hides it without changing item or bundle response fields", async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request);
  const dto = presentOrder(new OrderModel(order)); assert.equal(dto.bundlePendingSubstitution, undefined);
  assert.equal(dto.items.length, 1); assert.equal(dto.bundles.length, 1); assert.equal(dto.subtotal, 50);
  assert.equal(dto.requiresCustomerAction, true); assert.ok(order.bundlePendingSubstitution);
});

test("previously finalized unavailable units are excluded from the new pending difference", async t => {
  const { order, request } = await fixture(t, { previousShortage: true }); bindPendingBundleSubstitution(order, request);
  assert.equal(pendingBundleSubstitutionPiastres(order), 1000); assert.equal(order.subtotal, 40);
  await new OrderModel(order).validate();
});

test("ordinary orders are untouched and pending field has no model default", () => {
  const order = { items: [] }; bindPendingBundleSubstitution(order, null); assert.deepEqual(order, { items: [] });
  assert.equal(new OrderModel().bundlePendingSubstitution, undefined);
});

for (const change of ["request", "order", "warehouse", "revision", "subtotal", "sku", "price", "quantity", "duplicate", "bundle_line", "state", "empty"]) test(`pending ${change} tampering fails validation`, async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request); const pending = order.bundlePendingSubstitution;
  if (change === "request") pending.requestId = OTHER;
  if (change === "order") pending.orderId = OTHER;
  if (change === "warehouse") pending.warehouseId = OTHER;
  if (change === "revision") pending.settlementRevision++;
  if (change === "subtotal") pending.subtotalPiastres++;
  if (change === "sku") pending.shortages[0].productId = OTHER;
  if (change === "price") pending.shortages[0].originalUnitPricePiastres++;
  if (change === "quantity") pending.shortages[0].deliverableOriginalQuantity = 0;
  if (change === "duplicate") pending.shortages.push({ ...pending.shortages[0] });
  if (change === "bundle_line") pending.shortages[0].lineId = order.items.find(row => row.bundleGroupId).lineId;
  if (change === "state") order.requiresCustomerAction = false;
  if (change === "empty") pending.shortages = [];
  assert.throws(() => assertBundleOrderSnapshot(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("binding rejects wrong owner, held reservation and already responded request", async t => {
  const { order, request } = await fixture(t), raw = request.toObject();
  for (const changed of [{ ...raw, user: new mongoose.Types.ObjectId(OTHER) }, { ...raw, reservation: { state: "held", items: [] } },
    { ...raw, responseSubmittedAt: new Date() }]) assert.throws(() => bindPendingBundleSubstitution(order, changed), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("pending metadata cannot hide a mismatched saved subtotal or a partially fulfilled bundle cohort", async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request); order.subtotal++;
  assert.throws(() => assertBundleOrderSnapshot(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" }); order.subtotal--;
  order.items.find(row => row.bundleGroupId).fulfillmentQuantity--;
  assert.throws(() => assertBundleOrderSnapshot(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("decline or expiration removes pending context only after exact resolved merchandise and settlement are saved", async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request);
  const { quote } = calculateSubstitutionQuote({ order, request, selections: [], registeredCustomer: true });
  Object.assign(order.settlement, { currentMerchandiseGrossPiastres: quote.finalMerchandiseGrossPiastres,
    currentOrderValuePiastres: quote.newOrderValuePiastres, walletCreditedPiastres: 1000, revision: order.settlement.revision + 1 });
  applyQuoteToLegacyOrderAmounts({ order, quote }); order.substitutionState = "none"; order.requiresCustomerAction = false; order.activeSubstitutionRequest = null;
  const doc = new OrderModel(order); await doc.validate(); assert.equal(doc.bundlePendingSubstitution, undefined);
  assert.equal(doc.subtotal, 40); assert.equal(doc.bundleGroups[0].lineTotalPiastres, 3000);
  const bad = new OrderModel({ ...order, subtotal: 50 }); await assert.rejects(bad.validate(), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("acceptance awaiting extra card payment clears pending context and preserves bundle allocations", async t => {
  const { order, request } = await fixture(t); request.shortages[0].alternatives.push({ candidateId: "choice", product: P, productType: "SIMPLE",
    productName_en: "Food", productName_ar: "أكل", unitPricePiastres: 2000, maxQuantity: 1, stockQuantitySnapshot: 10, stockRevisionSnapshot: 1 });
  bindPendingBundleSubstitution(order, request); const groups = clone({ groups: order.bundleGroups });
  const calculated = calculateSubstitutionQuote({ order, request, selections: [{ shortageId: "shortage", choices: [{ candidateId: "choice", quantity: 1 }] }], registeredCustomer: true });
  order.items.push(...buildSubstituteOrderLines({ request, selections: calculated.selections }));
  Object.assign(order.settlement, { currentMerchandiseGrossPiastres: 6000, currentOrderValuePiastres: 11000, cardDuePiastres: 1000, revision: order.settlement.revision + 1 });
  applyQuoteToLegacyOrderAmounts({ order, quote: calculated.quote }); order.substitutionState = "awaiting_card_payment";
  const doc = new OrderModel(order); await doc.validate(); assert.equal(doc.bundlePendingSubstitution, undefined); assert.equal(doc.subtotal, 60);
  assert.deepEqual(doc.bundleGroups.toObject(), groups.groups);
});

test("losing the final ordinary line removes its coupon rather than discounting remaining bundles", async t => {
  const { order, request } = await fixture(t, { allMissing: true, coupon: true }); bindPendingBundleSubstitution(order, request);
  const { quote } = calculateSubstitutionQuote({ order, request, selections: [], registeredCustomer: true });
  assert.equal(quote.finalMerchandiseGrossPiastres, 3000); assert.equal(quote.preservedCouponDiscountPiastres, 0); assert.equal(quote.lockedNetShippingPiastres, 5000);
});

test("mixed order coupons are capped at remaining ordinary merchandise plus selected ordinary substitutes", async t => {
  const { order, request } = await fixture(t); order.settlement.originalCouponDiscountPiastres = 2000;
  let quote = calculateSubstitutionQuote({ order, request, selections: [] }).quote; assert.equal(quote.preservedCouponDiscountPiastres, 1000);
  request.shortages[0].alternatives.push({ candidateId: "choice", product: P, productType: "SIMPLE", productName_en: "Food", productName_ar: "أكل",
    unitPricePiastres: 500, maxQuantity: 1, stockQuantitySnapshot: 10, stockRevisionSnapshot: 1 });
  quote = calculateSubstitutionQuote({ order, request, selections: [{ shortageId: "shortage", choices: [{ candidateId: "choice", quantity: 1 }] }] }).quote;
  assert.equal(quote.preservedCouponDiscountPiastres, 1500); assert.equal(quote.finalMerchandiseGrossPiastres, 4500);
});

test("ordinary-only quote retains the preexisting whole-merchandise coupon rule", () => {
  const order = { items: [{ quantity: 2, itemPricePiastres: 1000 }], settlement: { originalCouponDiscountPiastres: 1500, lockedNetShippingPiastres: 500 } };
  const { quote } = calculateSubstitutionQuote({ order, request: { shortages: [] }, selections: [] });
  assert.equal(quote.preservedCouponDiscountPiastres, 1500); assert.equal(quote.newOrderValuePiastres, 1000);
});


test("cancellation retains the existing shortage proof without changing purchased prices or restoring missing units", async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request);
  order.status = "cancelled"; order.substitutionState = "none"; order.requiresCustomerAction = false; order.activeSubstitutionRequest = null;
  const doc = new OrderModel(order); await doc.validate();
  assert.ok(doc.bundlePendingSubstitution); assert.equal(doc.subtotal, 50);
  assert.equal(doc.items[0].fulfillmentQuantity, 1); assert.equal(doc.items[0].finalizedUnavailableQuantity, 1);
  assert.equal(presentOrder(doc).bundlePendingSubstitution, undefined);
});

for (const change of ["active_request", "action_required", "unresolved_state", "revision", "quantity", "component"]) test(`cancelled shortage proof rejects ${change} inconsistency`, async t => {
  const { order, request } = await fixture(t); bindPendingBundleSubstitution(order, request);
  order.status = "cancelled"; order.substitutionState = "none"; order.requiresCustomerAction = false; order.activeSubstitutionRequest = null;
  if (change === "active_request") order.activeSubstitutionRequest = request._id;
  if (change === "action_required") order.requiresCustomerAction = true;
  if (change === "unresolved_state") order.substitutionState = "awaiting_customer";
  if (change === "revision") order.bundlePendingSubstitution.settlementRevision++;
  if (change === "quantity") order.items[0].fulfillmentQuantity = 2;
  if (change === "component") order.items.find(row => row.bundleGroupId).fulfillmentQuantity--;
  await assert.rejects(new OrderModel(order).validate(), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});
