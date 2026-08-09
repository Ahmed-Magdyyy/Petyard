import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  orderPaymentAttemptStatusEnum as attemptStatus,
  orderSubstitutionStateEnum as substitutionState,
  paymentMethodEnum,
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
  substitutionRequestStatusEnum as requestStatus,
} from "../../shared/constants/enums.js";
import { invalidateProductCaches } from "../product/productCache.service.js";
import { releaseInventoryAtomically } from "../inventory/inventory.service.js";
import { OrderModel } from "../order/order.model.js";
import { OrderPaymentAttemptModel } from "../payment/orderPaymentAttempt.model.js";
import { createOrFindRefundOperation } from "../payment/substitutionPayment.service.js";
import {
  assertSettlementInvariant,
  createOrFindSettlementLedger,
  createSettlementOperationId,
} from "../settlement/settlement.service.js";
import {
  enqueueSubstitutionCustomerNotification as notifyCustomer,
  enqueueSubstitutionStaffNotification as notifyStaff,
} from "./substitution.notification.js";
import { applyQuoteToLegacyOrderAmounts as applyLegacy } from "./substitution.order.js";
import { calculateSubstitutionQuote as calculateQuote } from "./substitution.pricing.js";
import { SubstitutionRequestModel } from "./substitutionRequest.model.js";
import { applySubstitutionSettlement as applySettlement } from "./substitution.settlement.js";

const ACTIVE = [attemptStatus.INITIALIZING, attemptStatus.AWAITING_PAYMENT];
const error = (message, code) => {
  const value = new ApiError(message, 409, [{ code }]);
  value.code = code;
  return value;
};
const same = (a, b) => String(a || "") === String(b || "");
const withSession = (query, session) =>
  session && typeof query?.session === "function" ? query.session(session) : query;
const currentDeps = (overrides = {}) => ({
  startSession: mongoose.startSession.bind(mongoose),
  requestModel: SubstitutionRequestModel,
  orderModel: OrderModel,
  attemptModel: OrderPaymentAttemptModel,
  release: releaseInventoryAtomically,
  calculateQuote,
  applySettlement,
  applyLegacy,
  createLedger: createOrFindSettlementLedger,
  createLedgerOperationId: createSettlementOperationId,
  assertInvariant: assertSettlementInvariant,
  notifyCustomer,
  notifyStaff,
  createRefund: createOrFindRefundOperation,
  invalidate: invalidateProductCaches,
  now: () => new Date(),
  ...overrides,
});
function validDate(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw error("Invalid expiry time", "SUBSTITUTION_EXPIRY_INVALID_DATE");
  return result;
}
function piastres(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(name + " must be piastres", "SUBSTITUTION_SETTLEMENT_MISMATCH");
  return value;
}
function expiryFilter(status, now) {
  if (status === requestStatus.OFFERED) return { offerExpiresAt: { $lte: now } };
  if (status === requestStatus.AWAITING_CARD_PAYMENT) return { paymentExpiresAt: { $lte: now } };
  throw error("Unsupported expiry status", "SUBSTITUTION_EXPIRY_STATUS_INVALID");
}
function rejected(request) {
  return (request.shortages || []).map((shortage) => ({ shortageId: shortage.shortageId, choices: [] }));
}
function releaseDemands(request) {
  return (request.reservation?.items || []).flatMap((item) => {
    if (!item?.product || !Number.isInteger(item.quantity) || item.quantity < 1) return [];
    return [{
      productId: item.product,
      productType: item.variantId ? "VARIANT" : "SIMPLE",
      variantId: item.variantId || undefined,
      quantity: item.quantity,
    }];
  });
}
function finish(order, request, from, now, reason) {
  request.status = requestStatus.EXPIRED;
  request.isActive = false;
  request.terminalReason = reason;
  request.finalizedAt = now;
  request.lifecycle ||= [];
  request.lifecycle.push({ at: now, from, to: requestStatus.EXPIRED, reason, actorType: "system" });
  order.activeSubstitutionRequest = null;
  order.substitutionState = substitutionState.NONE;
  order.requiresCustomerAction = false;
  order.history ||= [];
  order.history.push({ at: now, description: "Product substitution expired", visibleToUser: true });
}

export function buildCardPaymentExpirySettlementQuote({ finalQuote, unpaidCardDuePiastres }) {
  const refund = piastres(finalQuote?.refundOrCreditPiastres, "final quote refund") -
    piastres(unpaidCardDuePiastres, "unpaid card due");
  if (refund < 0) throw error("Unpaid card due exceeds price reduction", "SUBSTITUTION_SETTLEMENT_MISMATCH");
  return {
    ...finalQuote,
    deltaPiastres: -refund,
    walletToUsePiastres: 0,
    additionalPaymentPiastres: 0,
    refundOrCreditPiastres: refund,
  };
}

async function fenceAndExpireAttempts(request, now, session, d) {
  const won = await withSession(d.attemptModel.findOne({
    substitutionRequest: request._id,
    successAccepted: true,
  }), session);
  if (won) throw error("Payment already succeeded", "SUBSTITUTION_PAYMENT_ALREADY_CAPTURED");
  await d.attemptModel.updateMany(
    {
      substitutionRequest: request._id,
      successAccepted: { $ne: true },
      status: { $in: ACTIVE },
    },
    {
      $set: {
        status: attemptStatus.EXPIRED,
        expiredAt: now,
        errorCode: "SUBSTITUTION_PAYMENT_EXPIRED",
        errorAt: now,
      },
      $unset: { initializationLeaseToken: 1, initializationLeaseExpiresAt: 1 },
    },
    { session },
  );
  const raced = await withSession(d.attemptModel.findOne({
    substitutionRequest: request._id,
    successAccepted: true,
  }), session);
  if (raced) throw error("Payment won expiry race", "SUBSTITUTION_PAYMENT_ALREADY_CAPTURED");
}
async function reverseDue(order, request, session, d) {
  const due = piastres(request.pricingSnapshot?.additionalPaymentPiastres, "request card due");
  if (!due || piastres(order.settlement?.cardDuePiastres, "order card due") < due) {
    throw error("Missing unpaid card due", "SUBSTITUTION_SETTLEMENT_MISMATCH");
  }
  order.settlement.cardDuePiastres -= due;
  order.settlement.revision = (order.settlement.revision || 0) + 1;
  await d.createLedger({
    operationId: d.createLedgerOperationId({
      orderId: order._id,
      requestId: request._id,
      kind: settlementOperationKindEnum.CARD_DUE,
      idempotencyKey: "expiration:" + request._id + ":reverse-card-due",
    }),
    order: order._id,
    request: request._id,
    kind: settlementOperationKindEnum.CARD_DUE,
    status: settlementOperationStatusEnum.REVERSED,
    amountPiastres: due,
    currency: order.currency || "EGP",
    session,
  });
  return due;
}
async function expireOffer(order, request, now, session, d) {
  const calculated = d.calculateQuote({
    order, request, selections: rejected(request), walletBalancePiastres: 0, registeredCustomer: Boolean(order.user),
  });
  const settlement = await d.applySettlement({
    order, request, quote: calculated.quote, userId: order.user || null,
    idempotencyKey: "expiration:" + request._id + ":offer", session,
  });
  d.applyLegacy({ order, quote: calculated.quote, walletDebitPiastres: settlement.walletDebitedPiastres || 0 });
  request.selections = calculated.selections;
  request.pricingSnapshot = calculated.quote;
  request.reservation = { ...(request.reservation?.toObject?.() || request.reservation || {}), state: "none", items: [] };
  finish(order, request, requestStatus.OFFERED, now, "offer_deadline_elapsed");
  return { settlement };
}
async function expireCard(order, request, now, session, d, affected) {
  order.items = (order.items || []).filter(
    (item) => !same(item.sourceSubstitutionRequest, request._id),
  );
  const calculated = d.calculateQuote({
    order, request, selections: rejected(request), walletBalancePiastres: 0, registeredCustomer: Boolean(order.user),
  });
  const due = await reverseDue(order, request, session, d);
  const quote = buildCardPaymentExpirySettlementQuote({ finalQuote: calculated.quote, unpaidCardDuePiastres: due });
  const settlement = await d.applySettlement({
    order, request, quote, userId: order.user || null,
    idempotencyKey: "expiration:" + request._id + ":card", session,
  });
  d.applyLegacy({
    order,
    quote: calculated.quote,
    walletDebitPiastres: -piastres(request.pricingSnapshot?.walletToUsePiastres || 0, "wallet contribution"),
  });
  await fenceAndExpireAttempts(request, now, session, d);
  const demands = releaseDemands(request);
  if (demands.length) {
    await d.release({
      demands, warehouseId: order.warehouse,
      operationId: "substitution-expiration-release:" + request._id,
      orderId: order._id, requestId: request._id,
      metadata: { source: "product_substitution_payment_expiration" }, session,
    });
    demands.forEach((demand) => affected.add(String(demand.productId)));
  }
  request.selections = calculated.selections;
  request.pricingSnapshot = quote;
  request.reservation = { ...(request.reservation?.toObject?.() || request.reservation || {}), state: "released" };
  finish(order, request, requestStatus.AWAITING_CARD_PAYMENT, now, "card_payment_deadline_elapsed");
  return { settlement, unpaidCardDuePiastres: due };
}
function refundMethod(order, required) {
  if (required?.method) return required.method;
  if (order.paymentMethod === paymentMethodEnum.CARD) return order.paymobTransactionId ? "card" : "manual";
  return order.paymentMethod === paymentMethodEnum.INSTAPAY ? "manual" : null;
}
export async function ensureExpiredSubstitutionRefundOperation({ order, request, refundRequired, dependencies }) {
  const d = currentDeps(dependencies);
  const value = Number(refundRequired?.amountPiastres ?? request?.pricingSnapshot?.refundOrCreditPiastres ?? 0);
  const method = refundMethod(order, refundRequired);
  if (!order?.guestId || !method || !Number.isSafeInteger(value) || value < 1) return null;
  if (
    !Number.isSafeInteger(order?.settlement?.pendingRefundLiabilityPiastres) ||
    order.settlement.pendingRefundLiabilityPiastres < value
  ) {
    return null;
  }
  const result = await d.createRefund({
    operationId: "substitution-expiration-refund:" + request._id + ":" + method + ":" + value,
    orderId: order._id, substitutionRequestId: request._id, guestId: order.guestId,
    method, amountPiastres: value, currency: order.currency || "EGP",
    originalTransactionId: method === "card" ? order.paymobTransactionId || null : null,
  });
  request.refundOperation = result.operation._id;
  if (typeof request.save === "function") await request.save();
  return result;
}
export async function expireSubstitutionRequest({ requestId, expectedStatus, now, dependencies }) {
  const d = currentDeps(dependencies);
  const at = validDate(now ?? d.now());
  const session = await d.startSession();
  const affected = new Set();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const request = await d.requestModel.findOneAndUpdate(
        { _id: requestId, isActive: true, status: expectedStatus, ...expiryFilter(expectedStatus, at) },
        { $set: { status: requestStatus.EXPIRED }, $inc: { revision: 1 } },
        { new: true, session },
      );
      if (!request) return;
      const order = await withSession(d.orderModel.findById(request.order), session);
      if (!order) throw error("Order not found", "SUBSTITUTION_ORDER_NOT_FOUND");
      if (!same(order.warehouse, request.warehouse)) throw error("Warehouse changed", "SUBSTITUTION_WAREHOUSE_MISMATCH");
      if (!same(order.activeSubstitutionRequest, request._id)) throw error("Request not active", "SUBSTITUTION_ACTIVE_REQUEST_MISMATCH");
      const outcome = expectedStatus === requestStatus.OFFERED
        ? await expireOffer(order, request, at, session, d)
        : await expireCard(order, request, at, session, d, affected);
      d.assertInvariant(order.settlement);
      await request.save({ session });
      await order.save({ session });
      await d.notifyCustomer({ order, request, event: "expired", session });
      await d.notifyStaff({ order, request, event: "offer_expired", session });
      result = { claimed: true, order, request, expectedStatus, outcome };
    });
  } finally {
    await session.endSession();
  }
  if (!result) return { claimed: false, requestId };
  if (affected.size) await d.invalidate([...affected]);
  try {
    result.refund = await ensureExpiredSubstitutionRefundOperation({
      order: result.order, request: result.request,
      refundRequired: result.outcome.settlement?.refundRequired, dependencies: d,
    });
  } catch (refundError) {
    result.refundError = refundError;
  }
  return result;
}
export async function findDueSubstitutionExpirationCandidates({ now, limit = 25, dependencies }) {
  const d = currentDeps(dependencies);
  const at = validDate(now ?? d.now());
  const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)));
  const query = d.requestModel.find({
    isActive: true,
    $or: [
      { status: requestStatus.OFFERED, offerExpiresAt: { $lte: at } },
      { status: requestStatus.AWAITING_CARD_PAYMENT, paymentExpiresAt: { $lte: at } },
    ],
  }).sort({ offerExpiresAt: 1, paymentExpiresAt: 1, _id: 1 }).limit(size);
  return typeof query.lean === "function" ? query.lean() : query;
}
export async function reconcileExpiredSubstitutionRefundOperations({ limit = 25, dependencies }) {
  const d = currentDeps(dependencies);
  const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)));
  const query = d.requestModel.find({
    status: {
      $in: [
        requestStatus.COMPLETED,
        requestStatus.REJECTED,
        requestStatus.EXPIRED,
      ],
    },
    isActive: false,
    guestId: { $exists: true, $ne: "" },
    "pricingSnapshot.refundOrCreditPiastres": { $gt: 0 },
    $or: [
      { refundOperation: { $exists: false } },
      { refundOperation: null },
    ],
  }).sort({ finalizedAt: 1, _id: 1 }).limit(size);
  const requests = typeof query.lean === "function" ? await query.lean() : await query;
  const results = [];
  for (const request of requests) {
    const queryOrder = d.orderModel.findById(request.order);
    const order = typeof queryOrder.lean === "function" ? await queryOrder.lean() : await queryOrder;
    if (!order) continue;
    try {
      const operation = await ensureExpiredSubstitutionRefundOperation({ order, request, dependencies: d });
      if (operation) results.push({ requestId: request._id, operation });
    } catch (refundError) {
      results.push({ requestId: request._id, error: refundError });
    }
  }
  return results;
}
export const substitutionExpirationInternals = Object.freeze({
  ACTIVE, rejected, releaseDemands, expiryFilter,
});
