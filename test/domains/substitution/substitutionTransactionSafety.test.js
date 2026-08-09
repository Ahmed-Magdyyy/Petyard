import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  deriveCancellationSettlementRefunds,
  deriveGuestCardDirectRefundAmountPiastres,
  queueManualGuestMultiCaptureRefund,
  requiresManualGuestMultiCaptureRefund,
} from "../../../src/domains/order/order.service.js";
import { WalletTransactionModel } from "../../../src/domains/wallet/walletTransaction.model.js";
import {
  assertStaffOrderEligible,
  ensureRefundOperation,
  resolveRetryReplayAttempt,
} from "../../../src/domains/substitution/substitution.service.js";
import {
  orderPaymentAttemptStatusEnum,
  orderStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
} from "../../../src/shared/constants/enums.js";

test("disabled rollout still permits staff read eligibility checks", () => {
  const order = {
    warehouse: "warehouse-a",
    status: orderStatusEnum.PENDING,
    sideEffectsCommitted: true,
    settlement: { migrationState: "native" },
    paymentMethod: paymentMethodEnum.COD,
    loyaltyPointsAwarded: 0,
  };

  assert.doesNotThrow(() =>
    assertStaffOrderEligible(order, ["warehouse-a"], {
      requireFeature: false,
    }),
  );
  assert.throws(
    () => assertStaffOrderEligible(order, ["warehouse-a"]),
    (error) => error?.code === "SUBSTITUTIONS_DISABLED",
  );
});

test("cancellation refunds each captured source once after a negative substitution credit", () => {
  const mixedCard = deriveCancellationSettlementRefunds({
    walletDebitedPiastres: 800_000,
    walletCreditedPiastres: 500_000,
    cardCapturedPiastres: 200_000,
    cardRefundedPiastres: 0,
    pendingRefundLiabilityPiastres: 0,
  });
  assert.deepEqual(mixedCard, {
    walletRefundPiastres: 300_000,
    cardRefundPiastres: 200_000,
  });

  const deliveryOrInstapay = deriveCancellationSettlementRefunds({
    walletDebitedPiastres: 800_000,
    walletCreditedPiastres: 300_000,
    cardCapturedPiastres: 0,
    cardRefundedPiastres: 0,
    pendingRefundLiabilityPiastres: 0,
  });
  assert.equal(deliveryOrInstapay.walletRefundPiastres, 500_000);
  assert.equal(deliveryOrInstapay.cardRefundPiastres, 0);
});

test("guest card cancellation excludes settled and queued substitution refund amounts", () => {
  const queued = deriveCancellationSettlementRefunds({
    walletDebitedPiastres: 0,
    walletCreditedPiastres: 0,
    cardCapturedPiastres: 1_000,
    cardRefundedPiastres: 0,
    pendingRefundLiabilityPiastres: 500,
  });
  assert.equal(queued.cardRefundPiastres, 500);

  const fullyQueued = deriveCancellationSettlementRefunds({
    walletDebitedPiastres: 0,
    walletCreditedPiastres: 0,
    cardCapturedPiastres: 1_000,
    cardRefundedPiastres: 0,
    pendingRefundLiabilityPiastres: 1_000,
  });
  assert.equal(fullyQueued.cardRefundPiastres, 0);
});

test("guest multi-capture refunds are durably queued before the order is mutated", async () => {
  const session = { id: "transaction-session" };
  const order = {
    _id: "order-1",
    guestId: "guest-1",
    paymentMethod: paymentMethodEnum.CARD,
    paymentStatus: paymentStatusEnum.REFUNDED,
    paymobTransactionId: "original-transaction",
    status: orderStatusEnum.CANCELLED,
    currency: "EGP",
    history: [],
    settlement: {
      walletDebitedPiastres: 0,
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 1_500,
      cardRefundedPiastres: 0,
      pendingRefundLiabilityPiastres: 200,
    },
  };
  const paymentAttempts = [{
    substitutionRequest: "request-1",
    successAccepted: true,
    status: orderPaymentAttemptStatusEnum.SUCCEEDED,
    paymobTransactionId: "top-up-transaction",
  }];
  const calls = [];

  assert.equal(
    requiresManualGuestMultiCaptureRefund({ order, paymentAttempts }),
    true,
  );
  const amountPiastres = deriveGuestCardDirectRefundAmountPiastres(order);
  assert.equal(amountPiastres, 1_300);
  const queued = await queueManualGuestMultiCaptureRefund({
    order,
    paymentAttempts,
    refundAmountPiastres: amountPiastres,
    session,
    createRefundOperation: async (input) => {
      calls.push(input);
      return { operation: { _id: "refund-operation-1" } };
    },
  });

  assert.equal(queued, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, session);
  assert.equal(calls[0].method, "manual");
  assert.equal(calls[0].amountPiastres, 1_300);
  assert.equal("originalTransactionId" in calls[0], false);
  assert.equal(order.multiCaptureRefundReconciliationOperation, "refund-operation-1");
  assert.equal(order.paymentStatus, paymentStatusEnum.PAID);
  assert.equal(order.history.length, 1);

  await queueManualGuestMultiCaptureRefund({
    order,
    paymentAttempts,
    refundAmountPiastres: amountPiastres,
    session,
    createRefundOperation: async (input) => {
      calls.push(input);
      return { operation: { _id: "should-not-be-created" } };
    },
  });
  assert.equal(calls.length, 1);
});

test("multi-capture queue failure leaves the order untouched for transaction rollback", async () => {
  const order = {
    _id: "order-2",
    guestId: "guest-2",
    paymentMethod: paymentMethodEnum.CARD,
    paymentStatus: paymentStatusEnum.REFUNDED,
    paymobTransactionId: "original-transaction",
    status: orderStatusEnum.RETURNED,
    history: [],
  };
  await assert.rejects(
    queueManualGuestMultiCaptureRefund({
      order,
      paymentAttempts: [{ substitutionRequest: "request-2" }],
      refundAmountPiastres: 500,
      session: { id: "transaction-session" },
      createRefundOperation: async () => {
        throw new Error("operation write failed");
      },
    }),
    /operation write failed/,
  );
  assert.equal(order.multiCaptureRefundReconciliationOperation, undefined);
  assert.equal(order.paymentStatus, paymentStatusEnum.REFUNDED);
  assert.deepEqual(order.history, []);
});

test("mixed wallet and card cancellation uses non-colliding wallet transaction kinds", () => {
  const typePath = WalletTransactionModel.schema.path("type");
  assert.equal(typePath.enumValues.includes("ORDER_REFUND"), true);
  assert.equal(typePath.enumValues.includes("ORDER_CARD_REFUND"), true);
  assert.equal(
    WalletTransactionModel.schema.indexes().some(
      ([keys, options]) =>
        keys.type === 1 &&
        keys.referenceType === 1 &&
        keys.referenceId === 1 &&
        options.unique === true,
    ),
    true,
  );
});

test("ordinary guest card credits materialize the exact original capture liability in the caller transaction", async () => {
  const session = { id: "response-transaction" };
  const order = {
    _id: "order-negative",
    guestId: "guest-negative",
    paymentMethod: paymentMethodEnum.CARD,
    paymobTransactionId: "original-order-capture",
    currency: "EGP",
    settlement: { pendingRefundLiabilityPiastres: 650 },
  };
  const request = {
    _id: "request-negative",
    pricingSnapshot: { refundOrCreditPiastres: 650 },
  };
  let observed;
  const refund = await ensureRefundOperation({
    order,
    request,
    guestId: order.guestId,
    refundRequired: { method: "card", amountPiastres: 650 },
    session,
    createRefundOperation: async (input) => {
      observed = input;
      return {
        operation: {
          _id: "refund-negative",
          method: input.method,
          status: "pending",
          amountPiastres: input.amountPiastres,
        },
      };
    },
  });

  assert.equal(observed.session, session);
  assert.equal(observed.method, "card");
  assert.equal(observed.originalTransactionId, "original-order-capture");
  assert.equal(observed.amountPiastres, 650);
  assert.equal(request.refundOperation, "refund-negative");
  assert.equal(refund.amountPiastres, 650);

  const settledReplay = await ensureRefundOperation({
    order: {
      ...order,
      settlement: { pendingRefundLiabilityPiastres: 0 },
    },
    request,
    guestId: order.guestId,
    createRefundOperation: async () => {
      throw new Error("a materialized refund must not be duplicated");
    },
  });
  assert.equal(settledReplay.id, "refund-negative");

  await assert.rejects(
    ensureRefundOperation({
      order: {
        ...order,
        settlement: { pendingRefundLiabilityPiastres: 649 },
      },
      request: { ...request, refundOperation: undefined },
      guestId: order.guestId,
      refundRequired: { method: "card", amountPiastres: 650 },
      session,
      createRefundOperation: async () => {
        throw new Error("must not create an unbacked refund");
      },
    }),
    (error) => error.code === "SUBSTITUTION_REFUND_LIABILITY_MISMATCH",
  );
});

test("retry idempotency replays only the exact active retry attempt", () => {
  const replay = { _id: "attempt-retry" };
  assert.equal(
    resolveRetryReplayAttempt({
      replayAttempt: replay,
      activePaymentAttempt: "attempt-retry",
    }),
    replay,
  );
  assert.throws(
    () =>
      resolveRetryReplayAttempt({
        replayAttempt: replay,
        activePaymentAttempt: "newer-attempt",
      }),
    (error) => error.code === "SUBSTITUTION_PAYMENT_ATTEMPT_CONFLICT",
  );
});

test("response proof cleanup, retry switching, and late-webhook paths are fenced", async () => {
  const [substitutionSource, paymentControllerSource] = await Promise.all([
    readFile(resolve("src/domains/substitution/substitution.service.js"), "utf8"),
    readFile(resolve("src/domains/payment/payment.controller.js"), "utf8"),
  ]);
  const retrySource = substitutionSource.slice(
    substitutionSource.indexOf("export async function retrySubstitutionCardPaymentService"),
    substitutionSource.indexOf("export async function confirmSubstitutionCardPaymentService"),
  );

  assert.match(substitutionSource, /let proofAdopted = false/);
  assert.match(
    substitutionSource,
    /uploadedProof &&\s*!responseResult\?\.idempotent &&[\s\S]*additionalInstapayScreenshot ===\s*uploadedProof\.url/,
  );
  assert.match(
    substitutionSource,
    /if \(uploadedProof && !proofAdopted\) \{\s*await deleteImage\(uploadedProof\)/,
  );

  assert.match(retrySource, /session\.withTransaction/);
  assert.match(
    retrySource,
    /String\(created\.attempt\._id\) !== String\(request\.activePaymentAttempt\)/,
  );
  assert.match(retrySource, /activePaymentAttempt: currentAttempt\._id/);
  assert.match(retrySource, /markSubstitutionPaymentAttemptSuperseded\([\s\S]*session/);
  assert.match(retrySource, /SUBSTITUTION_SAVED_CARD_NOT_ALLOWED/);

  assert.match(
    substitutionSource,
    /lateSuccessRefundRequired: true/,
  );
  assert.match(
    paymentControllerSource,
    /confirmation\?\.lateSuccessRefundRequired/,
  );
  assert.match(
    paymentControllerSource,
    /duplicate_success_refund_required/,
  );
  assert.match(
    paymentControllerSource,
    /another_attempt_success_refund_required/,
  );
});
