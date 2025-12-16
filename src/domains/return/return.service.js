import mongoose from "mongoose";
import { ApiError } from "../../shared/ApiError.js";
import { ReturnRequestModel } from "./return.model.js";
import { OrderModel } from "../order/order.model.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import { orderStatusEnum, returnStatusEnum, paymentStatusEnum } from "../../shared/constants/enums.js";
import { restoreStockForOrder } from "../order/order.service.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import { sendReturnStatusChangedNotification } from "../notification/notification.service.js";

const RETURN_WINDOW_DAYS = 14;

export async function createReturnRequestService({ userId, orderId, reason }) {
  if (!orderId || !reason || !reason.trim()) {
    throw new ApiError("Order ID and reason are required", 400);
  }

  const order = await OrderModel.findById(orderId).populate("user");
  if (!order) {
    throw new ApiError("Order not found", 404);
  }

  if (!order.user || String(order.user._id) !== String(userId)) {
    throw new ApiError("Order not found", 404);
  }

  if (order.status !== orderStatusEnum.DELIVERED) {
    throw new ApiError("Only delivered orders can be returned", 400);
  }

  const existingReturn = await ReturnRequestModel.findOne({ order: orderId });
  if (existingReturn) {
    throw new ApiError("Return request already exists for this order", 400);
  }

  const deliveredHistoryEntry = order.history.find(
    (h) => h.description && h.description.includes("DELIVERED")
  );

  const deliveredDate = deliveredHistoryEntry
    ? deliveredHistoryEntry.at
    : order.updatedAt;

  const daysSinceDelivery = Math.floor(
    (Date.now() - new Date(deliveredDate).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceDelivery > RETURN_WINDOW_DAYS) {
    throw new ApiError(
      `Return only available within ${RETURN_WINDOW_DAYS} days from delivery date`,
      400
    );
  }


  const subtotal = typeof order.subtotal === "number" ? order.subtotal : 0;
  const discountAmount = typeof order.discountAmount === "number" ? order.discountAmount : 0;
  
  const refundToWallet = Math.max(0, subtotal - discountAmount);

  const returnRequest = await ReturnRequestModel.create({
    order: orderId,
    user: userId,
    reason: reason.trim(),
    status: returnStatusEnum.PENDING,
    refundAmount: refundToWallet,
    walletRefund: refundToWallet,
    requestedAt: new Date(),
  });

  return returnRequest;
}

export async function listReturnRequestsService({ userId, status, page = 1, limit = 20 }) {
  const filter = {};

  if (userId) {
    filter.user = userId;
  }

  if (status) {
    const normalizedStatus = String(status).trim().toLowerCase();
    if ([returnStatusEnum.PENDING, returnStatusEnum.APPROVED, returnStatusEnum.REJECTED].includes(normalizedStatus)) {
      filter.status = normalizedStatus;
    }
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [returnRequests, totalCount] = await Promise.all([
    ReturnRequestModel.find(filter)
      .populate("order", "orderNumber status total walletUsed createdAt")
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

export async function getReturnRequestByIdService({ returnId, userId }) {
  const returnRequest = await ReturnRequestModel.findById(returnId)
    .populate("order")
    .populate("user", "name phone email")
    .populate("processedBy", "name role");

  if (!returnRequest) {
    throw new ApiError("Return request not found", 404);
  }

  if (userId && String(returnRequest.user._id) !== String(userId)) {
    throw new ApiError("Return request not found", 404);
  }

  return returnRequest;
}

export async function processReturnRequestService({
  returnId,
  action,
  adminUserId,
  rejectionReason,
}) {
  const normalizedAction = typeof action === "string" 
    ? action.trim().toLowerCase() 
    : "";

  if (![returnStatusEnum.APPROVED, returnStatusEnum.REJECTED].includes(normalizedAction)) {
    throw new ApiError("Action must be approved or rejected", 400);
  }

  if (normalizedAction === returnStatusEnum.REJECTED && !rejectionReason) {
    throw new ApiError("Rejection reason is required", 400);
  }

  const session = await mongoose.startSession();
  let updatedReturn;

  try {
    await session.withTransaction(async () => {
      const returnRequest = await ReturnRequestModel.findById(returnId).session(
        session
      );

      if (!returnRequest) {
        throw new ApiError("Return request not found", 404);
      }

      if (returnRequest.status !== returnStatusEnum.PENDING) {
        throw new ApiError(
          `Return request is already ${returnRequest.status.toLowerCase()}`,
          400
        );
      }

      const order = await OrderModel.findById(returnRequest.order).session(session);
      if (!order) {
        throw new ApiError("Associated order not found", 404);
      }

      if (normalizedAction === returnStatusEnum.APPROVED) {
        if (returnRequest.walletRefund > 0 && returnRequest.user) {
          await UserModel.updateOne(
            { _id: returnRequest.user },
            { $inc: { walletBalance: returnRequest.walletRefund } },
            { session }
          );

          const userAfterRefund = await UserModel.findById(returnRequest.user)
            .session(session)
            .select("walletBalance");

          await WalletTransactionModel.create(
            [
              {
                user: returnRequest.user,
                amount: returnRequest.walletRefund,
                type: "ORDER_REFUND",
                referenceType: "ORDER",
                referenceId: order._id,
                balanceAfter: userAfterRefund?.walletBalance ?? 0,
                note: `Refund for returned order ${order.orderNumber}`,
              },
            ],
            { session }
          );
        }

        await restoreStockForOrder({ session, order });

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

  if (updatedReturn) {
    // Fire-and-forget notification about the return status change
    void sendReturnStatusChangedNotification(updatedReturn);
  }

  return updatedReturn;
}
