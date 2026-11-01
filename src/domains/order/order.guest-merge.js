import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { OrderModel } from "./order.model.js";
import { ReturnRequestModel } from "../return/return.model.js";
import { SubstitutionRequestModel } from "../substitution/substitutionRequest.model.js";
import { OrderPaymentAttemptModel } from "../payment/orderPaymentAttempt.model.js";
import { RefundOperationModel } from "../payment/refundOperation.model.js";
import { NotificationOutboxModel } from "../notification/notificationOutbox.model.js";
import { InAppNotificationModel } from "../notification/inAppNotification.model.js";
import { ensureExpiredSubstitutionRefundOperation } from "../substitution/substitution.expiration.service.js";
import { substitutionRequestStatusEnum } from "../../shared/constants/enums.js";

export async function mergeGuestOrdersService({ userId, guestId }) {
  if (!mongoose.isObjectIdOrHexString(userId) || typeof guestId !== "string" || !guestId.trim()) {
    throw new ApiError("A valid userId and guestId are required", 400);
  }
  guestId = guestId.trim();

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const owner = { guestId, user: null };
      const orders = await OrderModel.find(owner)
        .select("_id guestId paymentMethod paymobTransactionId currency settlement").session(session).lean();
      if (!orders.length) return { mergedCount: 0 };

      const orderIds = orders.map(order => order._id);
      const transfer = { $set: { user: userId }, $unset: { guestId: 1 } };
      // Ownership changes must not reset the legacy return-window fallback date.
      const options = { session, timestamps: false };
      const result = await OrderModel.updateMany({ ...owner, _id: { $in: orderIds } }, transfer, options);

      // Materialize outstanding guest refunds before removing them from guest-only recovery.
      const unresolvedRefunds = await SubstitutionRequestModel.find({
        ...owner, order: { $in: orderIds }, isActive: false,
        status: { $in: [substitutionRequestStatusEnum.COMPLETED, substitutionRequestStatusEnum.REJECTED, substitutionRequestStatusEnum.EXPIRED] },
        "pricingSnapshot.refundOrCreditPiastres": { $gt: 0 }, refundOperation: null,
      }).session(session).lean();
      const ordersById = new Map(orders.map(order => [String(order._id), order]));
      for (const request of unresolvedRefunds) {
        const refund = await ensureExpiredSubstitutionRefundOperation({
          order: ordersById.get(String(request.order)), request, session,
        });
        if (refund) await SubstitutionRequestModel.updateOne(
          { _id: request._id }, { $set: { refundOperation: refund.operation._id } }, options,
        );
      }

      for (const model of [ReturnRequestModel, SubstitutionRequestModel, OrderPaymentAttemptModel, RefundOperationModel]) {
        await model.updateMany({ ...owner, order: { $in: orderIds } }, transfer, options);
      }

      const notificationScope = {
        "source.domain": "order",
        "action.params.orderId": { $in: orderIds.map(String) },
      };
      await NotificationOutboxModel.updateMany(
        { ...notificationScope, recipientGuestId: guestId, recipientUser: null },
        { $set: { recipientUser: userId }, $unset: { recipientGuestId: 1 } },
        options,
      );
      await InAppNotificationModel.updateMany({ ...notificationScope, ...owner }, transfer, options);

      return { mergedCount: result.modifiedCount };
    });
  } finally {
    await session.endSession();
  }
}
