import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import {
  OrderPaymentAttemptModel,
} from "../../../src/domains/payment/orderPaymentAttempt.model.js";
import { RefundOperationModel } from "../../../src/domains/payment/refundOperation.model.js";
import {
  claimAttemptSuccessAtomically,
  claimRefundOperation,
  createOrFindRefundOperation,
  createOrFindSubstitutionPaymentAttempt,
  ensureLateSuccessRefundOperation,
  initializeSubstitutionPaymentAttempt,
  markRefundOperationSucceeded,
  reconcileLateSuccessRefundOperations,
} from "../../../src/domains/payment/substitutionPayment.service.js";
import {
  orderPaymentAttemptStatusEnum,
  refundOperationStatusEnum,
} from "../../../src/shared/constants/enums.js";

function clone(value) {
  return structuredClone(value);
}

function matchValue(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    if ("$in" in expected) return expected.$in.some((value) => matchValue(actual, value));
    if ("$ne" in expected) return !matchValue(actual, expected.$ne);
    if ("$lte" in expected) return new Date(actual).getTime() <= new Date(expected.$lte).getTime();
    if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
  }
  if (actual instanceof Date || expected instanceof Date) {
    return new Date(actual).getTime() === new Date(expected).getTime();
  }
  return String(actual ?? "") === String(expected ?? "");
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(document, branch));
    return matchValue(document[key], expected);
  });
}

function applyUpdate(document, update) {
  for (const [key, value] of Object.entries(update.$set || {})) document[key] = value;
  for (const key of Object.keys(update.$unset || {})) delete document[key];
  for (const [key, value] of Object.entries(update.$inc || {})) document[key] = (document[key] || 0) + value;
}

function memoryModel(seed = [], { beforeFindOneAndUpdate } = {}) {
  const docs = seed.map(clone);
  let sequence = docs.length;
  return {
    docs,
    async findOne(filter) {
      return docs.find((doc) => matches(doc, filter)) || null;
    },
    async findById(id) {
      return docs.find((doc) => String(doc._id) === String(id)) || null;
    },
    find(filter) {
      let found = docs.filter((doc) => matches(doc, filter));
      const query = {
        sort() { return this; },
        limit(value) {
          found = found.slice(0, value);
          return this;
        },
        then(resolve, reject) {
          return Promise.resolve(found).then(resolve, reject);
        },
      };
      return query;
    },
    async create(document) {
      const created = { _id: `generated-${++sequence}`, ...clone(document) };
      docs.push(created);
      return created;
    },
    async findOneAndUpdate(filter, update) {
      beforeFindOneAndUpdate?.({ filter, update, docs });
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      return doc;
    },
  };
}

function fixedDeps(overrides = {}) {
  return {
    now: () => new Date("2026-07-29T12:00:00.000Z"),
    randomUUID: () => "lease-token",
    getPublicKey: () => "pk_test",
    ...overrides,
  };
}

const ids = Object.freeze({
  order: "order-1",
  request: "request-1",
  user: "user-1",
  guest: "guest-1",
});
const paymentDeadline = new Date("2026-07-29T12:30:00.000Z");

test("payment and refund models enforce registered-or-guest ownership", async () => {
  const user = new mongoose.Types.ObjectId();
  const request = new mongoose.Types.ObjectId();
  const order = new mongoose.Types.ObjectId();

  await assert.rejects(
    new OrderPaymentAttemptModel({
      order,
      substitutionRequest: request,
      user,
      guestId: "guest",
      requestIdempotencyKey: "one",
      merchantOrderId: "SUB-one",
      amountPiastres: 100,
      expiresAt: paymentDeadline,
    }).validate(),
  );
  await assert.rejects(
    new RefundOperationModel({
      operationId: "refund-one",
      order,
      substitutionRequest: request,
      method: "manual",
      amountPiastres: 100,
    }).validate(),
  );
});

test("attempt idempotency is request-scoped and refuses changed economics", async () => {
  const model = memoryModel();
  const dependencies = fixedDeps({ paymentAttemptModel: model });
  const first = await createOrFindSubstitutionPaymentAttempt({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    userId: ids.user,
    requestIdempotencyKey: "same-key",
    amountPiastres: 1250,
    paymentExpiresAt: paymentDeadline,
    dependencies,
  });
  const replay = await createOrFindSubstitutionPaymentAttempt({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    userId: ids.user,
    requestIdempotencyKey: "same-key",
    amountPiastres: 1250,
    paymentExpiresAt: paymentDeadline,
    dependencies,
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.match(first.attempt.merchantOrderId, /^SUB-/);
  assert.notEqual(first.attempt.merchantOrderId, "order-1");
  await assert.rejects(
    createOrFindSubstitutionPaymentAttempt({
      orderId: ids.order,
      substitutionRequestId: ids.request,
      userId: ids.user,
      requestIdempotencyKey: "same-key",
      amountPiastres: 1300,
      paymentExpiresAt: paymentDeadline,
      dependencies,
    }),
    { statusCode: 409 },
  );
});

test("initialization returns a client secret transiently and persists only safe provider ids", async () => {
  const model = memoryModel([
    {
      _id: "attempt-1",
      order: ids.order,
      substitutionRequest: ids.request,
      user: ids.user,
      requestIdempotencyKey: "key",
      merchantOrderId: "SUB-attempt",
      amountPiastres: 1250,
      currency: "EGP",
      status: orderPaymentAttemptStatusEnum.INITIALIZING,
      expiresAt: paymentDeadline,
    },
  ]);
  let observedCardTokens = null;
  const result = await initializeSubstitutionPaymentAttempt({
    attemptId: "attempt-1",
    orderNumber: "PY-123",
    savedCardId: "saved-card",
    billingData: { firstName: "Ada" },
    dependencies: fixedDeps({
      paymentAttemptModel: model,
      getSavedCardTokenService: async () => "sensitive-card-token",
      createPaymentIntention: async (input) => {
        observedCardTokens = input.cardTokens;
        return {
          clientSecret: "sensitive-client-secret",
          intentionId: "intent-1",
          paymobOrderId: "paymob-order-1",
        };
      },
    }),
  });

  assert.equal(result.clientSecret, "sensitive-client-secret");
  assert.deepEqual(observedCardTokens, ["sensitive-card-token"]);
  assert.equal(model.docs[0].status, orderPaymentAttemptStatusEnum.AWAITING_PAYMENT);
  assert.equal(model.docs[0].paymobIntentionId, "intent-1");
  assert.equal(model.docs[0].paymobOrderId, "paymob-order-1");
  assert.equal("clientSecret" in model.docs[0], false);
  assert.equal("cardTokens" in model.docs[0], false);
  assert.equal("initializationLeaseToken" in model.docs[0], false);
});

test("webhook amount/currency mismatch is fail-closed and concurrent success accepts once", async () => {
  const model = memoryModel([
    {
      _id: "attempt-2",
      order: ids.order,
      substitutionRequest: ids.request,
      guestId: ids.guest,
      amountPiastres: 1250,
      currency: "EGP",
      status: orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
      successAccepted: false,
      expiresAt: paymentDeadline,
    },
  ]);
  const dependencies = fixedDeps({ paymentAttemptModel: model });
  const mismatch = await claimAttemptSuccessAtomically({
    attemptId: "attempt-2",
    paymobTransactionId: "txn-mismatch",
    amountPiastres: 1249,
    currency: "EGP",
    dependencies,
  });
  assert.equal(mismatch.classification, "amount_or_currency_mismatch");
  assert.equal(model.docs[0].status, orderPaymentAttemptStatusEnum.AWAITING_PAYMENT);

  const [first, second] = await Promise.all([
    claimAttemptSuccessAtomically({
      attemptId: "attempt-2",
      paymobTransactionId: "txn-accepted",
      amountPiastres: 1250,
      currency: "EGP",
      dependencies,
    }),
    claimAttemptSuccessAtomically({
      attemptId: "attempt-2",
      paymobTransactionId: "txn-accepted",
      amountPiastres: 1250,
      currency: "EGP",
      dependencies,
    }),
  ]);
  assert.equal(first.classification, "accepted");
  assert.equal(second.classification, "already_succeeded");
  assert.equal(model.docs[0].successAccepted, true);
});

test("a second provider transaction for an already accepted attempt is queued for refund", async () => {
  const model = memoryModel([
    {
      _id: "attempt-duplicate-provider-success",
      order: ids.order,
      substitutionRequest: ids.request,
      guestId: ids.guest,
      amountPiastres: 1250,
      currency: "EGP",
      status: orderPaymentAttemptStatusEnum.SUCCEEDED,
      successAccepted: true,
      paymobTransactionId: "txn-original",
      expiresAt: paymentDeadline,
    },
  ]);

  const result = await claimAttemptSuccessAtomically({
    attemptId: "attempt-duplicate-provider-success",
    paymobTransactionId: "txn-duplicate",
    amountPiastres: 1250,
    currency: "EGP",
    dependencies: fixedDeps({ paymentAttemptModel: model }),
  });

  assert.equal(result.classification, "duplicate_success_refund_required");
  assert.equal(result.attempt.paymobTransactionId, "txn-original");
});

test("a success CAS that loses to expiry is reclassified as a late refundable payment", async () => {
  let expiredDuringActiveClaim = false;
  const model = memoryModel(
    [
      {
        _id: "attempt-expiry-race",
        order: ids.order,
        substitutionRequest: ids.request,
        guestId: ids.guest,
        amountPiastres: 1250,
        currency: "EGP",
        status: orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
        successAccepted: false,
        expiresAt: paymentDeadline,
      },
    ],
    {
      beforeFindOneAndUpdate({ filter, docs }) {
        if (
          !expiredDuringActiveClaim &&
          filter.status?.$in?.includes(
            orderPaymentAttemptStatusEnum.AWAITING_PAYMENT,
          )
        ) {
          docs[0].status = orderPaymentAttemptStatusEnum.EXPIRED;
          expiredDuringActiveClaim = true;
        }
      },
    },
  );

  const result = await claimAttemptSuccessAtomically({
    attemptId: "attempt-expiry-race",
    paymobTransactionId: "txn-expiry-race",
    amountPiastres: 1250,
    currency: "EGP",
    dependencies: fixedDeps({ paymentAttemptModel: model }),
  });

  assert.equal(result.classification, "late_success_refund_required");
  assert.equal(
    model.docs[0].status,
    orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
  );
  assert.equal(model.docs[0].paymobTransactionId, "txn-expiry-race");
});

test("retry attempts retain the existing request payment deadline and late success is refund-required", async () => {
  const model = memoryModel();
  const dependencies = fixedDeps({ paymentAttemptModel: model });
  const one = await createOrFindSubstitutionPaymentAttempt({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    guestId: ids.guest,
    requestIdempotencyKey: "first",
    amountPiastres: 500,
    paymentExpiresAt: paymentDeadline,
    attemptNumber: 1,
    dependencies,
  });
  const two = await createOrFindSubstitutionPaymentAttempt({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    guestId: ids.guest,
    requestIdempotencyKey: "retry",
    amountPiastres: 500,
    paymentExpiresAt: paymentDeadline,
    attemptNumber: 2,
    dependencies,
  });
  assert.equal(new Date(one.attempt.expiresAt).getTime(), new Date(two.attempt.expiresAt).getTime());

  const late = await claimAttemptSuccessAtomically({
    attemptId: one.attempt._id,
    paymobTransactionId: "late-txn",
    amountPiastres: 500,
    currency: "EGP",
    requestIsTerminal: true,
    dependencies,
  });
  assert.equal(late.classification, "late_success_refund_required");
  assert.equal(one.attempt.status, orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED);
});

test("refund operations are idempotent and lease fencing rejects stale workers", async () => {
  const model = memoryModel();
  const dependencies = fixedDeps({ refundOperationModel: model });
  const first = await createOrFindRefundOperation({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    paymentAttemptId: "attempt-3",
    guestId: ids.guest,
    method: "card",
    originalTransactionId: "txn-3",
    amountPiastres: 750,
    dependencies,
  });
  const replay = await createOrFindRefundOperation({
    orderId: ids.order,
    substitutionRequestId: ids.request,
    paymentAttemptId: "attempt-3",
    guestId: ids.guest,
    method: "card",
    originalTransactionId: "txn-3",
    amountPiastres: 750,
    dependencies,
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);

  const claimed = await claimRefundOperation({ dependencies });
  assert.equal(claimed.status, refundOperationStatusEnum.PROCESSING);
  assert.equal(claimed.leaseToken, "lease-token");
  const stale = await markRefundOperationSucceeded({
    operationId: claimed._id,
    leaseToken: "old-lease",
    dependencies,
  });
  assert.equal(stale, null);
  const completed = await markRefundOperationSucceeded({
    operationId: claimed._id,
    leaseToken: "lease-token",
    providerRefundTransactionId: "refund-txn",
    dependencies,
  });
  assert.equal(completed.status, refundOperationStatusEnum.SUCCEEDED);
  assert.equal(completed.providerRefundTransactionId, "refund-txn");
});

test("late success refund materialization uses the exact capture and reconciles once", async () => {
  const attemptModel = memoryModel([{
    _id: "attempt-late",
    order: ids.order,
    substitutionRequest: ids.request,
    guestId: ids.guest,
    amountPiastres: 875,
    currency: "EGP",
    status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
    successAccepted: true,
    paymobTransactionId: "late-provider-transaction",
    lateSuccessAt: new Date("2026-07-29T11:59:00.000Z"),
  }]);
  const refundModel = memoryModel();
  const dependencies = fixedDeps({
    paymentAttemptModel: attemptModel,
    refundOperationModel: refundModel,
  });

  const reconciled = await reconcileLateSuccessRefundOperations({
    limit: 10,
    dependencies,
  });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].error, undefined);
  assert.equal(refundModel.docs.length, 1);
  assert.equal(refundModel.docs[0].method, "card");
  assert.equal(refundModel.docs[0].amountPiastres, 875);
  assert.equal(
    refundModel.docs[0].originalTransactionId,
    "late-provider-transaction",
  );
  assert.equal(attemptModel.docs[0].refundOperation, refundModel.docs[0]._id);

  const replay = await ensureLateSuccessRefundOperation({
    attempt: attemptModel.docs[0],
    dependencies,
  });
  assert.equal(replay.created, false);
  assert.equal(refundModel.docs.length, 1);
});
