import crypto from "node:crypto";
import mongoose from "mongoose";

import {
  orderPaymentAttemptStatusEnum,
  refundOperationStatusEnum,
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
} from "../../shared/constants/enums.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  assertSettlementInvariant,
  createOrFindSettlementLedger,
  createSettlementOperationId,
} from "../settlement/settlement.service.js";
import { OrderModel } from "../order/order.model.js";
import { enqueueSubstitutionRefundNotification } from "../substitution/substitution.notification.js";
import { OrderPaymentAttemptModel } from "./orderPaymentAttempt.model.js";
import { RefundOperationModel } from "./refundOperation.model.js";
import { refundTransaction } from "./paymob.service.js";
import {
  claimRefundOperation,
  markRefundOperationFailure,
  markRefundOperationProviderSucceeded,
  markRefundOperationSucceeded,
  reconcileLateSuccessRefundOperations,
} from "./substitutionPayment.service.js";

const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_CAP_MS = 60 * 60_000;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getId(value) {
  return value?._id ?? value?.id ?? value;
}

function refundError(message, code) {
  const error = new ApiError(message, 409, [{ code }]);
  error.code = code;
  return error;
}

function resolveDependencies(overrides = {}) {
  return {
    mongoose,
    orderModel: OrderModel,
    paymentAttemptModel: OrderPaymentAttemptModel,
    refundOperationModel: RefundOperationModel,
    refundTransaction,
    claimRefundOperation,
    markRefundOperationFailure,
    markRefundOperationProviderSucceeded,
    markRefundOperationSucceeded,
    reconcileLateSuccessRefundOperations,
    createOrFindSettlementLedger,
    createSettlementOperationId,
    assertSettlementInvariant,
    now: () => new Date(),
    enqueueSubstitutionRefundNotification,
    randomUUID: crypto.randomUUID,
    ...overrides,
  };
}

function paymentServiceDependencies(deps) {
  return {
    refundOperationModel: deps.refundOperationModel,
    now: deps.now,
    randomUUID: deps.randomUUID,
  };
}

function validCardRefund(operation) {
  return (
    operation?.method === "card" &&
    Number.isSafeInteger(operation.amountPiastres) &&
    operation.amountPiastres > 0 &&
    Boolean(normalizeString(operation.originalTransactionId))
  );
}

function isTransientGatewayError(error) {
  const status = Number(error?.statusCode ?? error?.response?.status);
  if (!Number.isInteger(status)) return true;
  return status === 408 || status === 429 || status >= 500;
}

function retryAtFor({ now, attempts, baseMs, capMs }) {
  const exponent = Math.max(0, Number(attempts || 1) - 1);
  const delay = Math.min(capMs, baseMs * 2 ** exponent);
  return new Date(now.getTime() + delay);
}

async function queryWithSession(queryOrPromise, session) {
  if (session && queryOrPromise && typeof queryOrPromise.session === "function") {
    return queryOrPromise.session(session);
  }
  return queryOrPromise;
}

async function saveOrder(order, session) {
  if (!order || typeof order.save !== "function") {
    throw refundError("Order document is unavailable for settlement", "REFUND_ORDER_UNAVAILABLE");
  }
  await order.save(session ? { session } : undefined);
}

async function withTransaction(deps, fn) {
  const session = await deps.mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function markManualRequired({ operation, errorCode, deps }) {
  return deps.markRefundOperationFailure({
    operationId: getId(operation),
    leaseToken: operation.leaseToken,
    errorCode,
    manualRequired: true,
    dependencies: paymentServiceDependencies(deps),
  });
}

async function markRetryOrManual({ operation, error, deps, maxAttempts, baseMs, capMs }) {
  const attempts = Number(operation.attempts || 0);
  const manualRequired = !isTransientGatewayError(error) || attempts >= maxAttempts;
  return deps.markRefundOperationFailure({
    operationId: getId(operation),
    leaseToken: operation.leaseToken,
    errorCode: error?.code || error?.name || "REFUND_GATEWAY_FAILED",
    retryAt: retryAtFor({ now: deps.now(), attempts, baseMs, capMs }),
    manualRequired,
    dependencies: paymentServiceDependencies(deps),
  });
}

async function renewRefundLease({ operation, leaseMs, deps }) {
  const now = deps.now();
  return deps.refundOperationModel.findOneAndUpdate(
    {
      _id: getId(operation),
      status: refundOperationStatusEnum.PROCESSING,
      leaseToken: operation.leaseToken,
      leaseExpiresAt: { $gt: now },
    },
    { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs) } },
    { returnDocument: "after" },
  );
}

async function finalizeRefundLocally({ operation, deps }) {
  const operationId = getId(operation);
  const isLateTopUp = Boolean(operation.paymentAttempt);

  return withTransaction(deps, async (session) => {
    const order = await queryWithSession(
      deps.orderModel.findById(operation.order),
      session,
    );
    if (!order) {
      throw refundError("Refund order was not found", "REFUND_ORDER_NOT_FOUND");
    }

    if (!isLateTopUp) {
      const summary = order.settlement;
      const amount = Number(operation.amountPiastres);
      if (!summary || Number(summary.pendingRefundLiabilityPiastres || 0) < amount) {
        throw refundError(
          "Refund liability does not match the queued operation",
          "REFUND_SETTLEMENT_MISMATCH",
        );
      }
      summary.pendingRefundLiabilityPiastres -= amount;
      summary.cardRefundedPiastres = Number(summary.cardRefundedPiastres || 0) + amount;
      summary.revision = Number(summary.revision || 0) + 1;
      deps.assertSettlementInvariant(summary);
      await saveOrder(order, session);
    }

    const ledgerOperationId = deps.createSettlementOperationId({
      orderId: getId(order),
      requestId: operation.substitutionRequest,
      kind: settlementOperationKindEnum.CARD_REFUND,
      idempotencyKey: `refund-operation:${operation.operationId}`,
    });
    await deps.createOrFindSettlementLedger({
      operationId: ledgerOperationId,
      order: getId(order),
      request: operation.substitutionRequest,
      kind: settlementOperationKindEnum.CARD_REFUND,
      status: settlementOperationStatusEnum.APPLIED,
      amountPiastres: Number(operation.amountPiastres),
      currency: operation.currency || order.currency || "EGP",
      providerReference:
        operation.providerRefundTransactionId || operation.originalTransactionId,
      session,
    });

    if (isLateTopUp) {
      const refundedAttempt = await deps.paymentAttemptModel.findOneAndUpdate(
        {
          _id: operation.paymentAttempt,
          status: orderPaymentAttemptStatusEnum.LATE_SUCCESS_REFUND_REQUIRED,
        },
        {
          $set: {
            status: orderPaymentAttemptStatusEnum.REFUNDED,
            refundedAt: deps.now(),
          },
        },
        { returnDocument: "after", session },
      );
      if (!refundedAttempt) {
        throw refundError(
          "Late payment attempt does not match the queued refund",
          "REFUND_PAYMENT_ATTEMPT_MISMATCH",
        );
      }
    }

    const completed = await deps.markRefundOperationSucceeded({
      operationId,
      leaseToken: operation.leaseToken,
      providerRefundTransactionId: operation.providerRefundTransactionId,
      session,
      dependencies: paymentServiceDependencies(deps),
    });
    if (!completed) {
      throw refundError("Refund worker lease was lost", "REFUND_LEASE_LOST");
    }
    if (!isLateTopUp && operation.substitutionRequest && order.guestId) {
      await deps.enqueueSubstitutionRefundNotification({
        order,
        requestId: operation.substitutionRequest,
        amountPiastres: Number(operation.amountPiastres),
        method: "card",
        session,
      });
    }
    return completed;
  });
}

export async function processRefundOperation({
  operation,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryCapMs = DEFAULT_RETRY_CAP_MS,
  dependencies,
}) {
  const deps = resolveDependencies(dependencies);
  if (!operation || operation.status !== refundOperationStatusEnum.PROCESSING || !operation.leaseToken) {
    return { outcome: "not_claimed", operation: operation ?? null };
  }

  // Fence the lease before the gateway call. A stale worker is never allowed
  // to create a provider side effect after another worker reclaimed its row.
  const renewed = await renewRefundLease({ operation, leaseMs, deps });
  if (!renewed) return { outcome: "not_claimed", operation };
  operation = renewed;

  if (operation.method === "manual" || operation.method === "wallet") {
    const updated = await markManualRequired({
      operation,
      errorCode: operation.method === "manual" ? "MANUAL_REFUND_REQUIRED" : "WALLET_REFUND_NOT_QUEUEABLE",
      deps,
    });
    return { outcome: "manual_required", operation: updated ?? operation };
  }

  // Registered customers receive an ordinary negative adjustment in their
  // wallet during settlement. A card operation here would violate that rule.
  if (!operation.paymentAttempt && operation.user) {
    const updated = await markManualRequired({
      operation,
      errorCode: "REGISTERED_REFUND_MUST_USE_WALLET",
      deps,
    });
    return { outcome: "manual_required", operation: updated ?? operation };
  }

  if (!validCardRefund(operation)) {
    const updated = await markManualRequired({
      operation,
      errorCode: "REFUND_ORIGINAL_TRANSACTION_REQUIRED",
      deps,
    });
    return { outcome: "manual_required", operation: updated ?? operation };
  }

  let markedOperation = operation;
  if (!operation.providerRefundSucceededAt) {
    let providerResult;
    try {
      // Deliberately outside the MongoDB transaction: the gateway is an
      // external side effect and receives exact integer piastres only.
      providerResult = await deps.refundTransaction({
        transactionId: normalizeString(operation.originalTransactionId),
        amountCents: Number(operation.amountPiastres),
      });
    } catch (error) {
      const updated = await markRetryOrManual({
        operation,
        error,
        deps,
        maxAttempts,
        baseMs: retryBaseMs,
        capMs: retryCapMs,
      });
      return { outcome: updated?.status === refundOperationStatusEnum.MANUAL_REQUIRED ? "manual_required" : "retry_scheduled", operation: updated ?? operation };
    }

    try {
      const marked = await deps.markRefundOperationProviderSucceeded({
        operationId: getId(operation),
        leaseToken: operation.leaseToken,
        providerRefundTransactionId: providerResult?.refundTransactionId || null,
        dependencies: paymentServiceDependencies(deps),
      });
      if (!marked) {
        throw refundError("Refund worker lease was lost after gateway success", "REFUND_LEASE_LOST");
      }
      markedOperation = marked;
    } catch {
      // We cannot prove a retry is safe once the provider accepted the refund.
      // Escalate to a person instead of risking a duplicate card refund.
      const updated = await markManualRequired({
        operation,
        errorCode: "REFUND_PROVIDER_SUCCESS_RECONCILIATION_REQUIRED",
        deps,
      });
      return { outcome: "manual_required", operation: updated ?? operation };
    }
  }

  try {
    const completed = await finalizeRefundLocally({ operation: markedOperation, deps });
    return { outcome: "succeeded", operation: completed };
  } catch (error) {
    // The durable provider-success marker remains. A leased retry will only
    // finish local state and ledger work; it cannot call Paymob again.
    return {
      outcome: "local_finalization_deferred",
      operation: markedOperation,
      errorCode: error?.code || "REFUND_LOCAL_FINALIZATION_FAILED",
    };
  }
}

export async function processNextRefundOperation({
  leaseMs = DEFAULT_LEASE_MS,
  dependencies,
  ...options
} = {}) {
  const deps = resolveDependencies(dependencies);
  const operation = await deps.claimRefundOperation({
    now: deps.now(),
    leaseMs,
    dependencies: paymentServiceDependencies(deps),
  });
  if (!operation) return { outcome: "empty", operation: null };
  return processRefundOperation({ operation, leaseMs, dependencies: deps, ...options });
}

export async function drainRefundOperations({
  maxRecords = 50,
  concurrency = 3,
  dependencies,
  ...options
} = {}) {
  const deps = resolveDependencies(dependencies);
  const limit = Math.max(1, Math.min(500, Number(maxRecords) || 1));
  const workers = Math.max(1, Math.min(20, Number(concurrency) || 1));
  const lateSuccessReconciliation = await deps.reconcileLateSuccessRefundOperations({
    limit,
    dependencies: {
      paymentAttemptModel: deps.paymentAttemptModel,
      refundOperationModel: deps.refundOperationModel,
      now: deps.now,
    },
  });
  const results = [];
  let claimed = 0;

  async function runner() {
    while (claimed < limit) {
      claimed += 1;
      const result = await processNextRefundOperation({ dependencies, ...options });
      if (result.outcome === "empty") {
        claimed -= 1;
        return;
      }
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: workers }, runner));
  const counts = results.reduce((summary, result) => {
    summary[result.outcome] = (summary[result.outcome] || 0) + 1;
    return summary;
  }, {});
  return {
    claimed: results.length,
    counts,
    results,
    lateSuccessReconciliations: Array.isArray(lateSuccessReconciliation)
      ? lateSuccessReconciliation.filter((item) => item?.operation).length
      : 0,
  };
}

export const refundWorkerInternals = Object.freeze({
  isTransientGatewayError,
  retryAtFor,
  validCardRefund,
  renewRefundLease,
});
