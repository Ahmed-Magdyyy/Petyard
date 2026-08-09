import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderBackfillOperation,
  buildProductRevisionBackfillOperation,
  classifyLegacyOrderSettlement,
  findInvalidWarehouseStockRevisions,
  legacyOrderLineId,
  parseBackfillArguments,
  toPiastresExact,
  validateSettlementInvariant,
} from "../../scripts/backfillSubstitutionReadiness.js";
import {
  findOrderLineReadinessProblems,
  findOrderRequestCoherenceProblems,
  isLegacyCardLoyaltyRiskOrder,
} from "../../scripts/auditSubstitutionReadiness.js";

function makeOrder(overrides = {}) {
  return {
    _id: "65a000000000000000000001",
    orderNumber: "PY-TEST-1",
    currency: "EGP",
    status: "accepted",
    sideEffectsCommitted: true,
    paymentMethod: "card",
    paymentStatus: "paid",
    subtotal: 40.01,
    shippingFee: 10,
    discountAmount: 5,
    shippingDiscount: 2,
    totalDiscount: 7,
    walletUsed: 3,
    total: 40.01,
    items: [
      {
        product: "65a000000000000000000100",
        productType: "SIMPLE",
        productName: "Food",
        quantity: 2,
        itemPrice: 20.005,
        lineTotal: 40.01,
      },
    ],
    ...overrides,
  };
}

test("legacy line ids are deterministic and distinct within an order", () => {
  const first = legacyOrderLineId("65a000000000000000000001", 0);
  assert.equal(first, legacyOrderLineId("65a000000000000000000001", 0));
  assert.notEqual(first, legacyOrderLineId("65a000000000000000000001", 1));
  assert.match(first, /^legacy-[a-f0-9]{32}$/);
});

test("piastre conversion rounds decimal EGP once and rejects unsafe values", () => {
  assert.equal(toPiastresExact(20.005), 2001);
  assert.equal(toPiastresExact(0), 0);
  assert.throws(() => toPiastresExact(-0.01), /finite non-negative/);
  assert.throws(() => toPiastresExact(Number.NaN), /finite non-negative/);
});

test("safe card, InstaPay, and delivery legacy orders receive balanced settlement buckets", () => {
  const card = classifyLegacyOrderSettlement(makeOrder());
  assert.equal(card.safe, true);
  assert.equal(card.settlement.cardCapturedPiastres, 4001);
  assert.equal(card.settlement.walletDebitedPiastres, 300);
  assert.equal(validateSettlementInvariant(card.settlement).valid, true);

  const instapay = classifyLegacyOrderSettlement(makeOrder({
    paymentMethod: "instapay",
    paymentStatus: "pending",
    status: "pending",
  }));
  assert.equal(instapay.safe, true);
  assert.equal(instapay.settlement.instapaySubmittedPiastres, 4001);
  assert.equal(validateSettlementInvariant(instapay.settlement).valid, true);

  const delivery = classifyLegacyOrderSettlement(makeOrder({
    paymentMethod: "cod",
    paymentStatus: "pending",
    status: "delivered",
  }));
  assert.equal(delivery.safe, true);
  assert.equal(delivery.settlement.deliveryDuePiastres, 4001);
  assert.equal(validateSettlementInvariant(delivery.settlement).valid, true);
});

test("terminal, refunded, and financially inconsistent legacy orders require manual review", () => {
  assert.equal(
    classifyLegacyOrderSettlement(makeOrder({ status: "cancelled" })).safe,
    false,
  );
  assert.equal(
    classifyLegacyOrderSettlement(makeOrder({ paymentStatus: "refunded" })).safe,
    false,
  );
  assert.equal(
    classifyLegacyOrderSettlement(makeOrder({ total: 1 })).safe,
    false,
  );
});

test("order backfill only sets missing paths and uses compare-before-update filters", () => {
  const plan = buildOrderBackfillOperation(makeOrder());
  assert.ok(plan.operation);
  const update = plan.operation.updateOne;
  assert.equal(update.update.$set["items.0.lineKind"], "original");
  assert.equal(update.update.$set["items.0.fulfillmentQuantity"], 2);
  assert.equal(update.update.$set["settlement"].migrationState, "backfilled");
  assert.deepEqual(
    update.filter.$and.find((condition) => condition["items.0.lineId"]),
    { "items.0.lineId": { $exists: false } },
  );
  assert.deepEqual(
    update.filter.$and.find((condition) => condition.settlement),
    { settlement: { $exists: false } },
  );

  const complete = makeOrder({
    items: [{
      ...makeOrder().items[0],
      lineId: "native-line",
      lineKind: "original",
      fulfillmentQuantity: 2,
      finalizedUnavailableQuantity: 0,
      itemPricePiastres: 2001,
      lineTotalPiastres: 4001,
    }],
    substitutionState: "none",
    requiresCustomerAction: false,
    substitutionRevision: 0,
    settlement: classifyLegacyOrderSettlement(makeOrder()).settlement,
  });
  assert.equal(buildOrderBackfillOperation(complete).operation, null);
});

test("existing substitution lineage is never defaulted into a legacy original line", () => {
  const order = makeOrder({
    items: [{
      ...makeOrder().items[0],
      lineKind: "substitute",
      sourceLineId: "existing-source-line",
    }],
  });
  const plan = buildOrderBackfillOperation(order);
  assert.equal(plan.manualReview, true);
  assert.equal(plan.operation.updateOne.update.$set["items.0.lineId"], undefined);
  assert.equal(plan.operation.updateOne.update.$set["settlement.migrationState"], "manual_review");
});

test("duplicate warehouse rows skip a product instead of collapsing stock", () => {
  const duplicate = buildProductRevisionBackfillOperation({
    _id: "65a000000000000000000200",
    warehouseStocks: [
      { warehouse: "65a000000000000000000300", quantity: 2 },
      { warehouse: "65a000000000000000000300", quantity: 4 },
    ],
    variants: [],
  });
  assert.equal(duplicate.operation, null);
  assert.equal(duplicate.reason, "duplicate-or-invalid-warehouse-stock");

  const valid = buildProductRevisionBackfillOperation({
    _id: "65a000000000000000000201",
    warehouseStocks: [{ warehouse: "65a000000000000000000300", quantity: 2 }],
    variants: [{ warehouseStocks: [{ warehouse: "65a000000000000000000301", quantity: 4 }] }],
  });
  assert.equal(valid.operation.updateOne.update.$set["warehouseStocks.0.revision"], 0);
  assert.equal(valid.operation.updateOne.update.$set["variants.0.warehouseStocks.0.revision"], 0);
  assert.deepEqual(
    valid.operation.updateOne.filter.$and.find(
      (condition) => condition["warehouseStocks.0.revision"],
    ),
    { "warehouseStocks.0.revision": { $exists: false } },
  );
});

test("missing and invalid stock revisions are reported without changing stock rows", () => {
  const product = {
    warehouseStocks: [{ warehouse: "65a000000000000000000300", quantity: 2 }],
    variants: [{ warehouseStocks: [{ warehouse: "65a000000000000000000301", quantity: 4, revision: -1 }] }],
  };
  assert.deepEqual(findInvalidWarehouseStockRevisions(product), [
    { path: "warehouseStocks.0.revision", value: null },
    { path: "variants.0.warehouseStocks.0.revision", value: -1 },
  ]);
  assert.equal(product.warehouseStocks[0].quantity, 2);
  assert.equal(product.variants[0].warehouseStocks[0].quantity, 4);
});

test("live apply requires the explicit rewrite confirmation guard", () => {
  assert.throws(
    () => parseBackfillArguments(["--apply"]),
    /--confirm-live-db-rewrite/,
  );
  assert.deepEqual(
    parseBackfillArguments(["--batch-size=25", "--resume-orders-after=65a000000000000000000001"]),
    {
      apply: false,
      batchSize: 25,
      productsAfter: null,
      ordersAfter: "65a000000000000000000001",
    },
  );
});

test("loyalty readiness signal is limited to pending committed registered card orders in scope", () => {
  const order = makeOrder({
    user: "65a000000000000000000400",
    warehouse: "65a000000000000000000500",
    status: "pending",
    sideEffectsCommitted: true,
    paymentMethod: "card",
    loyaltyPointsAwarded: 10,
  });
  assert.equal(
    isLegacyCardLoyaltyRiskOrder(order, new Set(["65a000000000000000000500"])),
    true,
  );
  assert.equal(
    isLegacyCardLoyaltyRiskOrder(order, new Set(["65a000000000000000000501"])),
    false,
  );
  assert.equal(isLegacyCardLoyaltyRiskOrder({ ...order, user: null }), false);
  assert.equal(isLegacyCardLoyaltyRiskOrder({ ...order, loyaltyPointsAwarded: 0 }), false);
});

test("audit preserves stored warehouse and detects line readiness conflicts", () => {
  const order = makeOrder({ warehouse: "65a000000000000000000500" });
  order.items[0] = {
    ...order.items[0], lineId: "line-1", lineKind: "original",
    fulfillmentQuantity: 1, finalizedUnavailableQuantity: 0,
    itemPricePiastres: 2001, lineTotalPiastres: 4001,
  };
  assert.deepEqual(findOrderLineReadinessProblems(order), [
    "items.0 fulfillment quantities do not reconcile",
  ]);
  assert.equal(order.warehouse, "65a000000000000000000500");
});

test("audit detects active request owner, warehouse, pointer, and lifecycle mismatches", () => {
  const order = makeOrder({
    _id: "65a000000000000000000001",
    user: "65a000000000000000000400",
    warehouse: "65a000000000000000000500",
    activeSubstitutionRequest: "65a000000000000000000600",
    substitutionState: "awaiting_customer",
    requiresCustomerAction: true,
  });
  const request = {
    _id: "65a000000000000000000600",
    order: "65a000000000000000000999",
    user: "65a000000000000000000401",
    warehouse: "65a000000000000000000501",
    status: "awaiting_card_payment",
  };
  assert.deepEqual(findOrderRequestCoherenceProblems(order, request), [
    "request order does not match pointer order",
    "request warehouse does not match stored order warehouse",
    "request owner does not match order owner",
    "order substitutionState does not match active request status",
  ]);
  assert.deepEqual(
    findOrderRequestCoherenceProblems(order, null),
    ["order pointer does not reference an active request"],
  );
});
