import {
  paymentMethodEnum,
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
} from "../../shared/constants/enums.js";
import { fromPiastres } from "../../shared/utils/money.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import {
  assertSettlementInvariant,
  createOrFindSettlementLedger,
  createSettlementOperationId,
} from "../settlement/settlement.service.js";

function conflict(message, code) {
  const error = new ApiError(message, 409, [{ code }]);
  error.code = code;
  return error;
}

async function applyWalletMutation({
  userId,
  order,
  request,
  amountPiastres,
  direction,
  idempotencyKey,
  session,
}) {
  if (!amountPiastres) return null;
  if (!userId) {
    throw conflict("A guest wallet operation is not allowed", "WALLET_OWNER_REQUIRED");
  }

  const kind =
    direction < 0
      ? settlementOperationKindEnum.WALLET_DEBIT
      : settlementOperationKindEnum.WALLET_CREDIT;
  const operationId = createSettlementOperationId({
    orderId: order._id,
    requestId: request._id,
    kind,
    idempotencyKey,
  });
  const existingTransaction = await WalletTransactionModel.findOne({
    operationId,
  }).session(session);
  if (existingTransaction) return existingTransaction;

  const amount = fromPiastres(amountPiastres);
  const filter = { _id: userId };
  if (direction < 0) filter.walletBalance = { $gte: amount };
  const user = await UserModel.findOneAndUpdate(
    filter,
    { $inc: { walletBalance: direction * amount } },
    { new: true, session },
  ).select("walletBalance");
  if (!user) {
    throw conflict(
      "Wallet balance changed; request a fresh quote",
      "SUBSTITUTION_WALLET_CONFLICT",
    );
  }

  const [transaction] = await WalletTransactionModel.create(
    [
      {
        user: userId,
        amount: direction * amount,
        amountPiastres,
        currency: order.currency || "EGP",
        operationId,
        type:
          direction < 0 ? "SUBSTITUTION_DEBIT" : "SUBSTITUTION_CREDIT",
        referenceType: "SUBSTITUTION",
        referenceId: request._id,
        balanceAfter: user.walletBalance,
        note:
          direction < 0
            ? `Wallet contribution for order substitution ${order.orderNumber}`
            : `Wallet credit for order substitution ${order.orderNumber}`,
      },
    ],
    { session },
  );

  await createOrFindSettlementLedger({
    operationId,
    order: order._id,
    request: request._id,
    kind,
    status: settlementOperationStatusEnum.APPLIED,
    amountPiastres,
    currency: order.currency || "EGP",
    session,
  });
  return transaction;
}

async function recordSettlementComponent({
  order,
  request,
  kind,
  amountPiastres,
  idempotencyKey,
  session,
  status = settlementOperationStatusEnum.APPLIED,
}) {
  if (!amountPiastres) return null;
  const operationId = createSettlementOperationId({
    orderId: order._id,
    requestId: request._id,
    kind,
    idempotencyKey,
  });
  return createOrFindSettlementLedger({
    operationId,
    order: order._id,
    request: request._id,
    kind,
    status,
    amountPiastres,
    currency: order.currency || "EGP",
    session,
  });
}

export async function applySubstitutionSettlement({
  order,
  request,
  quote,
  userId,
  idempotencyKey,
  session,
}) {
  const summary = order.settlement;
  if (!summary) {
    throw conflict(
      "Order settlement data is not ready",
      "SUBSTITUTION_SETTLEMENT_NOT_READY",
    );
  }

  const result = {
    walletDebitedPiastres: quote.walletToUsePiastres,
    walletCreditedPiastres: 0,
    refundRequired: null,
  };

  if (quote.walletToUsePiastres > 0) {
    await applyWalletMutation({
      userId,
      order,
      request,
      amountPiastres: quote.walletToUsePiastres,
      direction: -1,
      idempotencyKey: `${idempotencyKey}:wallet-debit`,
      session,
    });
    summary.walletDebitedPiastres =
      (summary.walletDebitedPiastres || 0) + quote.walletToUsePiastres;
  }

  const additional = quote.additionalPaymentPiastres;
  const refund = quote.refundOrCreditPiastres;
  const method = order.paymentMethod;

  if (additional > 0) {
    if (method === paymentMethodEnum.CARD) {
      summary.cardDuePiastres = (summary.cardDuePiastres || 0) + additional;
      await recordSettlementComponent({
        order,
        request,
        kind: settlementOperationKindEnum.CARD_DUE,
        amountPiastres: additional,
        idempotencyKey: `${idempotencyKey}:card-due`,
        session,
      });
    } else if (method === paymentMethodEnum.INSTAPAY) {
      summary.instapaySubmittedPiastres =
        (summary.instapaySubmittedPiastres || 0) + additional;
      await recordSettlementComponent({
        order,
        request,
        kind: settlementOperationKindEnum.INSTAPAY_SUBMITTED,
        amountPiastres: additional,
        idempotencyKey: `${idempotencyKey}:instapay-submitted`,
        session,
      });
    } else {
      summary.deliveryDuePiastres = quote.deliveryDuePiastres;
      await recordSettlementComponent({
        order,
        request,
        kind: settlementOperationKindEnum.DELIVERY_DUE,
        amountPiastres: additional,
        idempotencyKey: `${idempotencyKey}:delivery-due`,
        session,
      });
    }
  } else if (refund > 0) {
    if (
      method === paymentMethodEnum.CARD ||
      method === paymentMethodEnum.INSTAPAY
    ) {
      if (userId) {
        await applyWalletMutation({
          userId,
          order,
          request,
          amountPiastres: refund,
          direction: 1,
          idempotencyKey: `${idempotencyKey}:wallet-credit`,
          session,
        });
        summary.walletCreditedPiastres =
          (summary.walletCreditedPiastres || 0) + refund;
        result.walletCreditedPiastres = refund;
      } else {
        summary.pendingRefundLiabilityPiastres =
          (summary.pendingRefundLiabilityPiastres || 0) + refund;
        result.refundRequired = {
          method: method === paymentMethodEnum.CARD ? "card" : "manual",
          amountPiastres: refund,
        };
        await recordSettlementComponent({
          order,
          request,
          kind: settlementOperationKindEnum.REFUND_LIABILITY,
          amountPiastres: refund,
          idempotencyKey: `${idempotencyKey}:refund-liability`,
          session,
        });
      }
    } else {
      const previousDue = summary.deliveryDuePiastres || 0;
      const nextDue = quote.deliveryDuePiastres;
      const dueReduction = Math.max(0, previousDue - nextDue);
      summary.deliveryDuePiastres = nextDue;
      const excess = Math.max(0, refund - dueReduction);
      if (excess > 0 && userId) {
        await applyWalletMutation({
          userId,
          order,
          request,
          amountPiastres: excess,
          direction: 1,
          idempotencyKey: `${idempotencyKey}:delivery-excess-credit`,
          session,
        });
        summary.walletCreditedPiastres =
          (summary.walletCreditedPiastres || 0) + excess;
        result.walletCreditedPiastres = excess;
      } else if (excess > 0) {
        summary.pendingRefundLiabilityPiastres =
          (summary.pendingRefundLiabilityPiastres || 0) + excess;
        result.refundRequired = { method: "manual", amountPiastres: excess };
      }
    }
  } else if (
    method === paymentMethodEnum.COD ||
    method === paymentMethodEnum.POS_ON_DELIVERY
  ) {
    summary.deliveryDuePiastres = quote.deliveryDuePiastres;
  }

  summary.currentMerchandiseGrossPiastres =
    quote.finalMerchandiseGrossPiastres;
  summary.preservedCouponDiscountPiastres =
    quote.preservedCouponDiscountPiastres;
  summary.lockedNetShippingPiastres = quote.lockedNetShippingPiastres;
  summary.currentOrderValuePiastres = quote.newOrderValuePiastres;
  summary.revision = (summary.revision || 0) + 1;
  assertSettlementInvariant(summary);

  return result;
}

