import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCardPaymentExpirySettlementQuote,
  expireSubstitutionRequest,
  reconcileExpiredSubstitutionRefundOperations,
} from "../../../src/domains/substitution/substitution.expiration.service.js";
import { drainSubstitutionExpirations } from "../../../src/domains/substitution/substitution.expiration.worker.service.js";
import {
  substitutionRequestStatusEnum as status,
} from "../../../src/shared/constants/enums.js";

const now = new Date("2026-07-29T12:00:00.000Z");

function fixture(kind) {
  const request = {
    _id: "request-1",
    order: "order-1",
    warehouse: "warehouse-1",
    status: kind,
    isActive: true,
    offerExpiresAt: new Date("2026-07-29T11:00:00.000Z"),
    paymentExpiresAt: new Date("2026-07-29T11:00:00.000Z"),
    revision: 0,
    shortages: [{ shortageId: "shortage-1" }],
    pricingSnapshot: { additionalPaymentPiastres: 300, walletToUsePiastres: 200 },
    reservation: { state: "held", items: [{ product: "candidate-1", quantity: 2 }] },
    lifecycle: [],
    save: async () => {},
  };
  const order = {
    _id: "order-1",
    orderNumber: "PY-1",
    warehouse: "warehouse-1",
    guestId: "guest-1",
    activeSubstitutionRequest: "request-1",
    items: [
      { lineId: "original", fulfillmentQuantity: 1, finalizedUnavailableQuantity: 2 },
      { lineId: "sub", sourceSubstitutionRequest: "request-1", fulfillmentQuantity: 2 },
    ],
    settlement: {
      walletDebitedPiastres: 200,
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 1000,
      cardDuePiastres: 300,
      currentOrderValuePiastres: 1500,
      revision: 0,
    },
    history: [],
    save: async () => {},
  };
  if (kind === status.OFFERED) {
    order.settlement.walletDebitedPiastres = 0;
    order.settlement.cardDuePiastres = 0;
    order.settlement.currentOrderValuePiastres = 1000;
  }
  const calls = {
    release: [],
    attempts: [],
    notifications: [],
    quoteLineIds: [],
  };
  const dependencies = {
    startSession: async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }),
    requestModel: {
      findOneAndUpdate: async (filter, update) => {
        if (!request.isActive || request.status !== filter.status) return null;
        request.status = update.$set.status;
        request.revision += update.$inc.revision;
        return request;
      },
    },
    orderModel: { findById: () => ({ session: async () => order }) },
    attemptModel: {
      findOne: async () => null,
      updateMany: async (filter) => { calls.attempts.push(filter); },
    },
    calculateQuote: ({ order: quotedOrder }) => {
      calls.quoteLineIds.push(
        (quotedOrder.items || []).map((item) => item.lineId),
      );
      return {
        selections: [{ shortageId: "shortage-1", choices: [], rejectedQuantity: 2 }],
        quote: {
          refundOrCreditPiastres: kind === status.OFFERED ? 200 : 700,
          newOrderValuePiastres: 800,
          walletToUsePiastres: 0,
        },
      };
    },
    createLedgerOperationId: () => "ledger-1",
    createLedger: async () => {},
    applySettlement: async ({ quote }) => {
      order.settlement.walletCreditedPiastres += quote.refundOrCreditPiastres;
      order.settlement.currentOrderValuePiastres = quote.newOrderValuePiastres;
      return { walletDebitedPiastres: 0, refundRequired: { method: "card", amountPiastres: quote.refundOrCreditPiastres } };
    },
    applyLegacy: () => {},
    release: async (input) => { calls.release.push(input); },
    assertInvariant: (summary) => {
      assert.equal(
        summary.walletDebitedPiastres - summary.walletCreditedPiastres + summary.cardCapturedPiastres + summary.cardDuePiastres,
        summary.currentOrderValuePiastres,
      );
    },
    notifyCustomer: async (input) => calls.notifications.push(input.event),
    notifyStaff: async (input) => calls.notifications.push(input.event),
    invalidate: async () => {},
    createRefund: async () => ({ id: "refund-1" }),
  };
  return { request, order, calls, dependencies };
}

test("awaiting-card expiry cancels unpaid due, releases the exact substitute reservation, and preserves missing originals", async () => {
  const { request, order, calls, dependencies } = fixture(status.AWAITING_CARD_PAYMENT);
  const result = await expireSubstitutionRequest({
    requestId: request._id, expectedStatus: status.AWAITING_CARD_PAYMENT, now, dependencies,
  });
  assert.equal(result.claimed, true);
  assert.equal(request.status, status.EXPIRED);
  assert.equal(request.reservation.state, "released");
  assert.deepEqual(calls.release[0].demands, [{ productId: "candidate-1", productType: "SIMPLE", variantId: undefined, quantity: 2 }]);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].fulfillmentQuantity, 1);
  assert.equal(order.items[0].finalizedUnavailableQuantity, 2);
  assert.deepEqual(calls.quoteLineIds, [["original"]]);
  assert.equal(order.settlement.cardDuePiastres, 0);
  assert.equal(order.settlement.walletCreditedPiastres, 400);
  assert.equal(calls.attempts.length, 1);
  assert.deepEqual(calls.notifications.sort(), ["expired", "offer_expired"]);
  const replay = await expireSubstitutionRequest({
    requestId: request._id, expectedStatus: status.AWAITING_CARD_PAYMENT, now, dependencies,
  });
  assert.equal(replay.claimed, false);
});

test("offer expiry needs no reservation and finalizes rejected choices", async () => {
  const { request, order, calls, dependencies } = fixture(status.OFFERED);
  await expireSubstitutionRequest({ requestId: request._id, expectedStatus: status.OFFERED, now, dependencies });
  assert.equal(request.reservation.state, "none");
  assert.equal(calls.release.length, 0);
  assert.equal(order.activeSubstitutionRequest, null);
  assert.equal(order.settlement.walletCreditedPiastres, 200);
});

test("the card expiry quote excludes the unpaid card due from customer credit", () => {
  const quote = buildCardPaymentExpirySettlementQuote({
    finalQuote: { refundOrCreditPiastres: 700, additionalPaymentPiastres: 300 },
    unpaidCardDuePiastres: 300,
  });
  assert.equal(quote.refundOrCreditPiastres, 400);
  assert.equal(quote.additionalPaymentPiastres, 0);
});

test("worker is bounded and reports only transaction claims", async () => {
  const result = await drainSubstitutionExpirations({
    maxRecords: 2,
    concurrency: 2,
    findCandidates: async () => [{ _id: "a", status: "offered" }, { _id: "b", status: "awaiting_card_payment" }],
    expire: async ({ requestId, expectedStatus }) => ({ claimed: requestId === "a", expectedStatus }),
    reconcileRefunds: async () => [],
  });
  assert.deepEqual(result.summary, {
    candidates: 2, claimed: 1, offeredExpired: 1, cardPaymentExpired: 0,
    skipped: 1, failures: 0, refundReconciliations: 0,
  });
});

test("terminal guest refund reconciliation excludes cancelled substitution requests", async () => {
  let observedFilter;
  const query = {
    sort() { return this; },
    limit() { return this; },
    async lean() { return []; },
  };
  const result = await reconcileExpiredSubstitutionRefundOperations({
    dependencies: {
      requestModel: {
        find(filter) {
          observedFilter = filter;
          return query;
        },
      },
    },
  });

  assert.deepEqual(result, []);
  assert.deepEqual(observedFilter.status.$in, [
    status.COMPLETED,
    status.REJECTED,
    status.EXPIRED,
  ]);
  assert.equal(observedFilter.status.$in.includes(status.CANCELLED), false);
});
