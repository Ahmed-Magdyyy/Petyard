import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { ReturnRequestModel } from "./return.model.js";
import { OrderModel } from "../order/order.model.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import { LoyaltyTransactionModel } from "../loyalty/loyaltyTransaction.model.js";
import {
  orderStatusEnum,
  returnStatusEnum,
  paymentStatusEnum,
  paymentMethodEnum,
  refundMethodEnum,
} from "../../shared/constants/enums.js";
import { restoreStockForOrder } from "../order/order.service.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import { sendReturnStatusChangedNotification } from "../notification/notification.service.js";
import { deductLoyaltyPointsOnReturnService } from "../loyalty/loyalty.service.js";
import { refundTransaction } from "../payment/paymob.service.js";

const RETURN_WINDOW_DAYS = 14;

// ─── Refund Strategy ────────────────────────────────────────────────────────
//
// Change this single function to adjust refund routing.
//
// Current rules:
//   User  + any payment  → wallet
//   Guest + card          → card (Paymob refund)
//   Guest + COD           → manual
//
function resolveRefundMethod(order) {
  const isGuest = !order.user;
  const isCard = order.paymentMethod === paymentMethodEnum.CARD;

  if (isGuest) {
    return isCard ? refundMethodEnum.CARD : refundMethodEnum.MANUAL;
  }
  // Registered user — always wallet
  return refundMethodEnum.WALLET;
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

function validateDeliveredAndReturnWindow(order, lang) {
  if (order.status !== orderStatusEnum.DELIVERED) {
    throw new ApiError(
      lang === "ar"
        ? "لا يمكن إرجاع إلا الطلبات التي تم تسليمها"
        : "Only delivered orders can be returned",
      400,
    );
  }

  const deliveredHistoryEntry = order.history.find(
    (h) => h.description && h.description.includes("DELIVERED"),
  );

  const deliveredDate = deliveredHistoryEntry
    ? deliveredHistoryEntry.at
    : order.updatedAt;

  const daysSinceDelivery = Math.floor(
    (Date.now() - new Date(deliveredDate).getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceDelivery > RETURN_WINDOW_DAYS) {
    throw new ApiError(
      lang === "ar"
        ? `يمكن الإرجاع خلال ${RETURN_WINDOW_DAYS} أيام من تاريخ التسليم`
        : `Return only available within ${RETURN_WINDOW_DAYS} days from delivery date`,
      400,
    );
  }
}

async function validateNoExistingReturn(orderId, lang) {
  const existingReturn = await ReturnRequestModel.findOne({ order: orderId });

  if (existingReturn && existingReturn.status === returnStatusEnum.APPROVED) {
    throw new ApiError(
      lang === "ar"
        ? "تم قبول طلب الإرجاع لهذا الطلب من قبل"
        : "Return request had been accepted for this order before",
      400,
    );
  }

  if (existingReturn && existingReturn.status === returnStatusEnum.REJECTED) {
    throw new ApiError(
      lang === "ar"
        ? "تم رفض طلب الإرجاع لهذا الطلب من قبل"
        : "Return request had been rejected for this order before",
      400,
    );
  }

  if (existingReturn && existingReturn.status === returnStatusEnum.PENDING) {
    throw new ApiError(
      lang === "ar"
        ? "تم إنشاء طلب إرجاع لهذا الطلب من قبل"
        : "Return request had been placed for this order before",
      400,
    );
  }
}

function computeRefundAmount(order) {
  const subtotal = typeof order.subtotal === "number" ? order.subtotal : 0;
  const discountAmount =
    typeof order.discountAmount === "number" ? order.discountAmount : 0;
  return Math.max(0, subtotal - discountAmount);
}

// ─── Create Return Request (User or Guest) ──────────────────────────────────

export async function createReturnRequestService({
  userId,
  guestId,
  orderId,
  reason,
  lang = "en",
}) {
  if (!orderId || !reason || !reason.trim()) {
    throw new ApiError("Order ID and reason are required", 400);
  }

  const order = await OrderModel.findById(orderId);
  if (!order) {
    throw new ApiError("Order not found", 404);
  }

  // Ownership check — user or guest
  if (userId) {
    if (!order.user || String(order.user) !== String(userId)) {
      throw new ApiError("Order not found", 404);
    }
  } else if (guestId) {
    if (!order.guestId || order.guestId !== guestId) {
      throw new ApiError("Order not found", 404);
    }
  }

  validateDeliveredAndReturnWindow(order, lang);
  await validateNoExistingReturn(orderId, lang);

  const refundAmount = computeRefundAmount(order);
  const method = resolveRefundMethod(order);

  const returnData = {
    order: orderId,
    reason: reason.trim(),
    status: returnStatusEnum.PENDING,
    refundMethod: method,
    refundAmount,
    walletRefund: method === refundMethodEnum.WALLET ? refundAmount : 0,
    requestedAt: new Date(),
  };

  // Attach the correct identity
  if (userId) {
    returnData.user = userId;
  } else {
    returnData.guestId = guestId;
  }

  const returnRequest = await ReturnRequestModel.create(returnData);

  return returnRequest;
}

// ─── List Return Requests ───────────────────────────────────────────────────

export async function listReturnRequestsService({
  userId,
  guestId,
  status,
  orderNumber,
  page = 1,
  limit = 20,
}) {
  const filter = {};

  if (userId) {
    filter.user = userId;
  } else if (guestId) {
    filter.guestId = guestId;
  }

  if (status) {
    const normalizedStatus = String(status).trim().toLowerCase();
    if (
      [
        returnStatusEnum.PENDING,
        returnStatusEnum.APPROVED,
        returnStatusEnum.REJECTED,
      ].includes(normalizedStatus)
    ) {
      filter.status = normalizedStatus;
    }
  }

  // Search by order number (admin use case)
  if (orderNumber) {
    const matchingOrders = await OrderModel.find(
      { orderNumber: { $regex: orderNumber, $options: "i" } },
      "_id",
    ).lean();
    filter.order = { $in: matchingOrders.map((o) => o._id) };
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const selectFields = guestId ? "-user" : "-guestId";

  const [returnRequests, totalCount] = await Promise.all([
    ReturnRequestModel.find(filter)
      .select(selectFields)
      .populate(
        "order",
        "orderNumber status total walletUsed createdAt paymentMethod",
      )
      .populate("user", "name phone email")
      .populate("processedBy", "name role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ReturnRequestModel.countDocuments(filter),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: returnRequests.length,
    data: returnRequests,
  };
}

// ─── Get Return Request By Id ───────────────────────────────────────────────

export async function getReturnRequestByIdService({
  returnId,
  userId,
  guestId,
}) {
  const returnRequest = await ReturnRequestModel.findById(returnId)
    .populate("order")
    .populate("user", "name phone email")
    .populate("processedBy", "name role");

  if (!returnRequest) {
    throw new ApiError("Return request not found", 404);
  }

  if (userId && String(returnRequest.user?._id) !== String(userId)) {
    throw new ApiError("Return request not found", 404);
  }

  if (guestId && returnRequest.guestId !== guestId) {
    throw new ApiError("Return request not found", 404);
  }

  // Strip the opposite identity field from the response
  const result = returnRequest.toObject();
  if (guestId) {
    delete result.user;
  } else {
    delete result.guestId;
  }

  return result;
}

// ─── Process Return Request (Admin) ─────────────────────────────────────────

export async function processReturnRequestService({
  returnId,
  action,
  adminUserId,
  rejectionReason,
}) {
  const normalizedAction =
    typeof action === "string" ? action.trim().toLowerCase() : "";

  if (
    ![returnStatusEnum.APPROVED, returnStatusEnum.REJECTED].includes(
      normalizedAction,
    )
  ) {
    throw new ApiError("Action must be approved or rejected", 400);
  }

  if (normalizedAction === returnStatusEnum.REJECTED && !rejectionReason) {
    throw new ApiError("Rejection reason is required", 400);
  }

  const session = await mongoose.startSession();
  let updatedReturn;

  try {
    await session.withTransaction(async () => {
      const returnRequest =
        await ReturnRequestModel.findById(returnId).session(session);

      if (!returnRequest) {
        throw new ApiError("Return request not found", 404);
      }

      if (returnRequest.status !== returnStatusEnum.PENDING) {
        throw new ApiError(
          `Return request is already ${returnRequest.status.toLowerCase()}`,
          400,
        );
      }

      const order = await OrderModel.findById(returnRequest.order).session(
        session,
      );
      if (!order) {
        throw new ApiError("Associated order not found", 404);
      }

      if (normalizedAction === returnStatusEnum.APPROVED) {
        let walletDeductedForPoints = 0;

        // ── Loyalty point deduction (registered users only) ──
        if (returnRequest.user && order.loyaltyPointsAwarded > 0) {
          const deductionResult = await deductLoyaltyPointsOnReturnService({
            userId: returnRequest.user,
            pointsToDeduct: order.loyaltyPointsAwarded,
            session,
          });

          walletDeductedForPoints = deductionResult.walletDeducted;

          const userAfterDeduction = await UserModel.findById(
            returnRequest.user,
          )
            .select("loyaltyPoints")
            .session(session);

          await LoyaltyTransactionModel.create(
            [
              {
                user: returnRequest.user,
                points: -deductionResult.pointsDeducted,
                type: "DEDUCTED",
                referenceType: "ORDER",
                referenceId: order._id,
                balanceAfter: userAfterDeduction?.loyaltyPoints ?? 0,
                description_en:
                  walletDeductedForPoints > 0
                    ? `Deducted ${deductionResult.pointsDeducted} points and ${walletDeductedForPoints} EGP from wallet for returned order ${order.orderNumber}`
                    : `Deducted ${order.loyaltyPointsAwarded} points due to returned order ${order.orderNumber}`,
                description_ar:
                  walletDeductedForPoints > 0
                    ? `خصم ${deductionResult.pointsDeducted} نقطة و ${walletDeductedForPoints} جنيه من المحفظة للطلب المرتجع ${order.orderNumber}`
                    : `خصم ${order.loyaltyPointsAwarded} نقطة بسبب الطلب المرتجع ${order.orderNumber}`,
              },
            ],
            { session },
          );
        }

        // ── Refund by method ──
        if (returnRequest.refundMethod === refundMethodEnum.WALLET) {
          await processWalletRefund({
            returnRequest,
            order,
            walletDeductedForPoints,
            session,
          });
        }
        // Card refund is handled AFTER the transaction (external API call)

        // ── Restore stock ──
        await restoreStockForOrder({ session, order });

        // ── Update order status ──
        order.status = orderStatusEnum.RETURNED;
        order.paymentStatus = paymentStatusEnum.REFUNDED;
        order.history = Array.isArray(order.history) ? order.history : [];
        order.history.push({
          at: new Date(),
          description: `Order returned and refunded`,
          byUserId: adminUserId,
          visibleToUser: true,
        });

        await order.save({ session });
      }

      returnRequest.status = normalizedAction;
      returnRequest.processedAt = new Date();
      returnRequest.processedBy = adminUserId;

      if (normalizedAction === returnStatusEnum.REJECTED) {
        returnRequest.rejectionReason = rejectionReason;
      }

      updatedReturn = await returnRequest.save({ session });
    });
  } finally {
    session.endSession();
  }

  // ── Card refund (external API — must run outside MongoDB transaction) ──
  if (
    updatedReturn &&
    updatedReturn.status === returnStatusEnum.APPROVED &&
    updatedReturn.refundMethod === refundMethodEnum.CARD
  ) {
    await processCardRefund(updatedReturn);
  }

  if (updatedReturn) {
    // Fire-and-forget notification about the return status change
    void sendReturnStatusChangedNotification(updatedReturn);
  }

  return updatedReturn;
}

// ─── Refund Processors ──────────────────────────────────────────────────────

async function processWalletRefund({
  returnRequest,
  order,
  walletDeductedForPoints,
  session,
}) {
  if (returnRequest.walletRefund <= 0 || !returnRequest.user) return;

  const netRefund = Math.max(
    0,
    returnRequest.walletRefund - walletDeductedForPoints,
  );

  if (netRefund > 0) {
    await UserModel.updateOne(
      { _id: returnRequest.user },
      { $inc: { walletBalance: netRefund } },
      { session },
    );
  }

  const userAfterRefund = await UserModel.findById(returnRequest.user)
    .session(session)
    .select("walletBalance");

  await WalletTransactionModel.create(
    [
      {
        user: returnRequest.user,
        amount: netRefund,
        type: "ORDER_REFUND",
        referenceType: "ORDER",
        referenceId: order._id,
        balanceAfter: userAfterRefund?.walletBalance ?? 0,
        description:
          walletDeductedForPoints > 0
            ? `Refund for returned order ${order.orderNumber} (${returnRequest.walletRefund} EGP - ${walletDeductedForPoints} EGP loyalty points recovery)`
            : `Refund for returned order ${order.orderNumber}`,
      },
    ],
    { session },
  );
}

async function processCardRefund(returnRequest) {
  const order = await OrderModel.findById(returnRequest.order);

  if (!order?.paymobTransactionId) {
    console.error(
      `[Return] Cannot card-refund order ${order?.orderNumber || returnRequest.order} — no paymobTransactionId`,
    );
    return;
  }

  const amountCents = Math.round(returnRequest.refundAmount * 100);

  try {
    const result = await refundTransaction({
      transactionId: order.paymobTransactionId,
      amountCents,
    });

    await ReturnRequestModel.updateOne(
      { _id: returnRequest._id },
      { paymobRefundTransactionId: result.refundTransactionId },
    );

    console.log(
      `[Return] Card refund successful for order ${order.orderNumber} — refund txn ${result.refundTransactionId}`,
    );
  } catch (err) {
    console.error(
      `[Return] Card refund FAILED for order ${order.orderNumber}:`,
      err.message,
    );
    // The return is already approved and stock restored.
    // Admin will need to manually resolve the failed card refund.
  }
}
