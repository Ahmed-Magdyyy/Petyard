import assert from "node:assert/strict";
import test from "node:test";

import {
  drainRefundOperations,
  processRefundOperation,
} from "../../../src/domains/payment/refund.worker.service.js";
import {
  orderPaymentAttemptStatusEnum,
  refundOperationStatusEnum,
} from "../../../src/shared/constants/enums.js";

const now = new Date("2026-07-29T12:00:00.000Z");

function clone(value) {
  return structuredClone(value);
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    if ("$gt" in expected) return new Date(actual).getTime() > new Date(expected.$gt).getTime();
    if ("$in" in expected) return expected.$in.some((value) => matchesValue(actual, value));
  }
  if (actual instanceof Date || expected instanceof Date) {
    return new Date(actual).getTime() === new Date(expected).getTime();
  }
  return String(actual ?? "") === String(expected ?? "");
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => matchesValue(document[key], expected));
}

function update(document, patch) {
  for (const [key, value] of Object.entries(patch.$set || {})) document[key] = value;
  for (const key of Object.keys(patch.$unset || {})) delete document[key];
}

function refundModel(seed) {
  const row = clone(seed);
  return {
    row,
    async findOneAndUpdate(filter, patch) {
      if (!matches(row, filter)) return null;
      update(row, patch);
      return row;
    },
  };
}

function makeOrder() {
  return {
    _id: "order-1",
    currency: "EGP",
    settlement: {
      currentOrderValuePiastres: 1000,
      walletDebitedPiastres: 0,
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 1200,
      cardRefundedPiastres: 0,
      cardDuePiastres: 0,
      instapaySubmittedPiastres: 0,
      instapayConfirmedPiastres: 0,
      deliveryDuePiastres: 0,
      pendingRefundLiabilityPiastres: 200,
      revision: 0,
    },
    async save() {},
  };
}

function makeOperation(overrides = {}) {
  return {
    _id: "refund-1",
    operationId: "refund:one",
    order: "order-1",
    substitutionRequest: "request-1",
    guestId: "guest-1",
    method: "card",
    amountPiastres: 200,
    currency: "EGP",
    originalTransactionId: "txn-original",
    status: refundOperationStatusEnum.PROCESSING,
    attempts: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    ...overrides,
  };
}

function makeDependencies({ operation, order = makeOrder(), failTransaction = false, refundTransaction, paymentAttempt = null } = {}) {
  const model = refundModel(operation);
  const ledgers = [];
  const attempt = paymentAttempt;
  const fakeMongoose = {
    async startSession() {
      return {
        async withTransaction(fn) {
          if (failTransaction) throw new Error("simulated local write interruption");
          await fn();
        },
        async endSession() {},
      };
    },
  };
  return {
    refundOperationModel: model,
    orderModel: { async findById() { return order; } },
    paymentAttemptModel: {
      async findOneAndUpdate(filter, patch) {
        if (!attempt || !matches(attempt, filter)) return null;
        update(attempt, patch);
        return attempt;
      },
    },
    mongoose: fakeMongoose,
    now: () => new Date(now),
    randomUUID: () => "worker-lease",
    refundTransaction: refundTransaction || (async () => ({ refundTransactionId: "provider-refund-1" })),
    createSettlementOperationId: ({ kind, idempotencyKey }) => `${kind}:${idempotencyKey}`,
    async createOrFindSettlementLedger(input) {
      ledgers.push(input);
      return { ledger: input, created: true };
    },
    ledgers,
    order,
    operation: model.row,
  };
}

test("worker sends exact piastres, settles the liability, and records a card-refund ledger", async () => {
  const deps = makeDependencies({ operation: makeOperation() });
  let gatewayInput;
  deps.refundTransaction = async (input) => {
    gatewayInput = input;
    return { refundTransactionId: "provider-refund-1" };
  };

  const result = await processRefundOperation({ operation: deps.operation, dependencies: deps });

  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(gatewayInput, { transactionId: "txn-original", amountCents: 200 });
  assert.equal(deps.order.settlement.pendingRefundLiabilityPiastres, 0);
  assert.equal(deps.order.settlement.cardRefundedPiastres, 200);
  assert.equal(deps.operation.status, refundOperationStatusEnum.SUCCEEDED);
  assert.equal(deps.ledgers.length, 1);
  assert.equal(deps.ledgers[0].providerReference, "provider-refund-1");
});

test("manual and missing-transaction operations never call Paymob", async () => {
  for (const operation of [
    makeOperation({ method: "manual", originalTransactionId: undefined }),
    makeOperation({ originalTransactionId: undefined }),
  ]) {
    const deps = makeDependencies({ operation });
    let calls = 0;
    deps.refundTransaction = async () => { calls += 1; };
    const result = await processRefundOperation({ operation: deps.operation, dependencies: deps });
    assert.equal(result.outcome, "manual_required");
    assert.equal(calls, 0);
    assert.equal(deps.operation.status, refundOperationStatusEnum.MANUAL_REQUIRED);
  }
});

test("a stale lease is fenced before any provider side effect", async () => {
  const operation = makeOperation();
  const deps = makeDependencies({ operation });
  deps.operation.leaseToken = "new-owner";
  let calls = 0;
  deps.refundTransaction = async () => { calls += 1; };

  const result = await processRefundOperation({ operation, dependencies: deps });
  assert.equal(result.outcome, "not_claimed");
  assert.equal(calls, 0);
});

test("transient gateway errors receive a bounded exponential retry", async () => {
  const deps = makeDependencies({ operation: makeOperation({ attempts: 2 }) });
  const gatewayError = Object.assign(new Error("temporary outage"), { statusCode: 502, code: "HTTP_502" });
  deps.refundTransaction = async () => { throw gatewayError; };

  const result = await processRefundOperation({ operation: deps.operation, dependencies: deps });
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(deps.operation.status, refundOperationStatusEnum.RETRYABLE);
  assert.equal(new Date(deps.operation.nextAttemptAt).getTime(), now.getTime() + 120_000);
});

test("provider-success recovery finalizes without a second Paymob refund after local failure", async () => {
  const firstDeps = makeDependencies({ operation: makeOperation(), failTransaction: true });
  let calls = 0;
  firstDeps.refundTransaction = async () => {
    calls += 1;
    return { refundTransactionId: "provider-refund-1" };
  };
  const first = await processRefundOperation({ operation: firstDeps.operation, dependencies: firstDeps });
  assert.equal(first.outcome, "local_finalization_deferred");
  assert.equal(calls, 1);
  assert.ok(firstDeps.operation.providerRefundSucceededAt);
  assert.equal(firstDeps.operation.status, refundOperationStatusEnum.PROCESSING);

  const recoveryDeps = makeDependencies({ operation: firstDeps.operation });
  recoveryDeps.refundTransaction = async () => {
    calls += 1;
    throw new Error("must not call gateway after provider marker");
  };
  const second = await processRefundOperation({ operation: recoveryDeps.operation, dependencies: recoveryDeps });
  assert.equal(second.outcome, "succeeded");
  assert.equal(calls, 1);
});

test("late successful top-up refunds update the payment attempt without altering order value", async () => {
  const operation = makeOperation({ paymentAttempt: "attempt-1", amountPiastres: 200 });
  const attempt = { _id: "attempt-1", status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED };
  const deps = makeDependencies({ operation, paymentAttempt: attempt });
  const before = structuredClone(deps.order.settlement);

  const result = await processRefundOperation({ operation: deps.operation, dependencies: deps });
  assert.equal(result.outcome, "succeeded");
  assert.equal(attempt.status, orderPaymentAttemptStatusEnum.REFUNDED);
  assert.deepEqual(deps.order.settlement, before);
  assert.equal(deps.ledgers.length, 1);
});

test("drain resolves worker dependencies before late-success reconciliation and claiming", async () => {
  const deps = makeDependencies({ operation: makeOperation() });
  const observed = [];
  deps.reconcileLateSuccessRefundOperations = async ({ limit, dependencies }) => {
    observed.push({ limit, dependencies });
    return [];
  };
  deps.claimRefundOperation = async () => null;

  const result = await drainRefundOperations({
    maxRecords: 7,
    concurrency: 2,
    dependencies: deps,
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].limit, 7);
  assert.equal(observed[0].dependencies.paymentAttemptModel, deps.paymentAttemptModel);
  assert.equal(result.claimed, 0);
  assert.equal(result.lateSuccessReconciliations, 0);
});
