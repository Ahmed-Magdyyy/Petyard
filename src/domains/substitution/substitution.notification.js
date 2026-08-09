import { enabledControls, roles } from "../../shared/constants/enums.js";
import { enqueueNotificationOutbox } from "../notification/notificationOutbox.service.js";
import { UserModel } from "../user/user.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";

const CUSTOMER_MESSAGES = Object.freeze({
  offered: {
    title_en: "Substitutes are available",
    title_ar: "بدائل المنتجات متاحة",
    body_en: "Some items in your order need your review. Choose substitutes or continue without them.",
    body_ar: "بعض منتجات طلبك تحتاج إلى مراجعتك. اختر البدائل أو أكمل بدونها.",
  },
  awaiting_card_payment: {
    title_en: "Additional payment needed",
    title_ar: "مطلوب دفع إضافي",
    body_en: "Your substitute choices are reserved. Complete the additional payment to confirm them.",
    body_ar: "تم حجز البدائل التي اخترتها. أكمل الدفع الإضافي لتأكيدها.",
  },
  instapay_submitted: {
    title_en: "Additional InstaPay payment submitted",
    title_ar: "تم إرسال دفعة إنستاباي إضافية",
    body_en: "Your substitute request is awaiting payment review.",
    body_ar: "طلب البدائل الخاص بك بانتظار مراجعة الدفع.",
  },
  completed: {
    title_en: "Your substitute choices were confirmed",
    title_ar: "تم تأكيد البدائل التي اخترتها",
    body_en: "Your order has been updated with your selected substitutes.",
    body_ar: "تم تحديث طلبك بالبدائل التي اخترتها.",
  },
  rejected: {
    title_en: "You continued without substitutes",
    title_ar: "تمت متابعة الطلب بدون البدائل",
    body_en: "Your order will continue with the remaining available items.",
    body_ar: "سيستمر طلبك بالمنتجات المتاحة المتبقية.",
  },
  expired: {
    title_en: "Your substitute offer expired",
    title_ar: "انتهت صلاحية عرض البدائل",
    body_en: "Your order will continue with the remaining available items.",
    body_ar: "سيستمر طلبك بالمنتجات المتاحة المتبقية.",
  },
  cancelled: {
    title_en: "Your substitute request was cancelled",
    title_ar: "تم إلغاء طلب البدائل",
    body_en: "Your order will continue with the remaining available items.",
    body_ar: "سيستمر طلبك بالمنتجات المتاحة المتبقية.",
  },
});

const STAFF_MESSAGES = Object.freeze({
  customer_accepted: {
    title_en: "Customer accepted substitutes",
    title_ar: "العميل وافق على البدائل",
    body_en: "Review the updated order and any required payment confirmation.",
    body_ar: "راجع الطلب المحدث وأي تأكيد دفع مطلوب.",
  },
  customer_rejected: {
    title_en: "Customer declined substitutes",
    title_ar: "العميل رفض البدائل",
    body_en: "The order will continue with the remaining available items.",
    body_ar: "سيستمر الطلب بالمنتجات المتاحة المتبقية.",
  },
  offer_expired: {
    title_en: "Substitute offer expired",
    title_ar: "انتهت صلاحية عرض البدائل",
    body_en: "The customer did not respond before the offer deadline.",
    body_ar: "لم يرد العميل قبل انتهاء مهلة العرض.",
  },
  card_payment_received: {
    title_en: "Additional card payment received",
    title_ar: "تم استلام دفع بطاقة إضافي",
    body_en: "Review the updated substitution request.",
    body_ar: "راجع طلب البدائل المحدث.",
  },
  instapay_submitted: {
    title_en: "Additional InstaPay proof submitted",
    title_ar: "تم إرسال إثبات إنستاباي إضافي",
    body_en: "Review the payment proof in the order workflow.",
    body_ar: "راجع إثبات الدفع من خلال مسار الطلب.",
  },
});

function identifier(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function ownerRecipient(order) {
  if (order?.user) return { recipientUser: order.user, key: `user:${order.user}` };
  const guestId = typeof order?.guestId === "string" ? order.guestId.trim() : "";
  if (guestId) return { recipientGuestId: guestId, key: `guest:${guestId}` };
  throw new Error("Substitution order has no notification owner");
}

function messageFor(messages, event) {
  const message = messages[event];
  if (!message) throw new Error(`Unsupported substitution notification event: ${event}`);
  return message;
}

function commonOutboxFields({ order, request, event, message }) {
  const orderId = identifier(order?._id, "order._id");
  const requestId = identifier(request?._id, "request._id");
  return {
    title_en: message.title_en,
    title_ar: message.title_ar,
    body_en: message.body_en,
    body_ar: message.body_ar,
    icon: "order",
    action: {
      type: "order_detail",
      screen: "OrderDetailScreen",
      params: { orderId, substitutionRequestId: requestId },
    },
    source: {
      domain: "order",
      event: `substitution_${event}`,
      referenceId: requestId,
    },
  };
}

/**
 * Enqueue the customer event inside the caller's Mongo transaction.  The
 * durable record, not a push token, is the transaction boundary.
 */
export async function enqueueSubstitutionCustomerNotification({
  order,
  request,
  event,
  session,
  enqueue = enqueueNotificationOutbox,
}) {
  const recipient = ownerRecipient(order);
  const requestId = identifier(request?._id, "request._id");
  const message = messageFor(CUSTOMER_MESSAGES, event);

  return enqueue({
    ...recipient,
    dedupeKey: `substitution:${requestId}:${recipient.key}:${event}`,
    ...commonOutboxFields({ order, request, event, message }),
    session,
  });
}

/** Exact staff routing: global order-capable staff plus active moderators of
 * the order's already-selected warehouse.  It never recalculates fulfillment.
 */
export async function resolveSubstitutionStaffRecipients({
  order,
  userModel = UserModel,
  warehouseModel = WarehouseModel,
}) {
  const warehouseId = identifier(order?.warehouse, "order.warehouse");
  const [privilegedStaff, warehouse] = await Promise.all([
    userModel
      .find({
        active: true,
        $or: [
          { role: roles.SUPER_ADMIN },
          { role: roles.ADMIN, enabledControls: enabledControls.ORDERS },
        ],
      })
      .select("_id"),
    warehouseModel.findById(warehouseId).select("moderators"),
  ]);

  const moderatorIds = Array.isArray(warehouse?.moderators)
    ? warehouse.moderators.filter(Boolean)
    : [];
  const activeModerators = moderatorIds.length
    ? await userModel
        .find({
          _id: { $in: moderatorIds },
          active: true,
          role: roles.MODERATOR,
        })
        .select("_id")
    : [];

  return [...new Set(
    [...privilegedStaff, ...activeModerators].map((staff) => String(staff._id || staff)),
  )];
}

export async function enqueueSubstitutionStaffNotification({
  order,
  request,
  event,
  session,
  enqueue = enqueueNotificationOutbox,
  userModel = UserModel,
  warehouseModel = WarehouseModel,
}) {
  const requestId = identifier(request?._id, "request._id");
  const message = messageFor(STAFF_MESSAGES, event);
  const recipients = await resolveSubstitutionStaffRecipients({
    order,
    userModel,
    warehouseModel,
  });
  const common = commonOutboxFields({ order, request, event, message });

  const entries = await Promise.all(
    recipients.map((recipientUser) =>
      enqueue({
        recipientUser,
        dedupeKey: `substitution:${requestId}:staff:${recipientUser}:${event}`,
        ...common,
        session,
      }),
    ),
  );

  return { recipientUserIds: recipients, entries };
}

export const substitutionNotificationInternals = Object.freeze({
  CUSTOMER_MESSAGES,
  STAFF_MESSAGES,
  ownerRecipient,
  commonOutboxFields,
});
