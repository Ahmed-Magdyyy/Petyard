import { ApiError } from "../../shared/utils/ApiError.js";
import { getFirebaseAdmin } from "../../config/firebase.js";
import { NotificationDeviceModel } from "./notification.model.js";
import {
  dispatchNotification,
  dispatchNotificationToUsers,
} from "./notificationDispatcher.js";
import { UserModel } from "../user/user.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { roles, enabledControls } from "../../shared/constants/enums.js";

function normalizePlatform(value) {
  const v = typeof value === "string" ? value.toLowerCase().trim() : "";
  if (v === "ios" || v === "web") return v;
  return "android";
}

async function sendPushToGuest({ guestId, notification, data }) {
  if (!guestId) {
    throw new ApiError("guestId is required", 400);
  }

  const devices = await NotificationDeviceModel.find({ guestId });
  const tokens = devices.map((d) => d.token).filter(Boolean);

  const result = await sendPushToTokens({ tokens, notification, data });

  return {
    deviceCount: devices.length,
    ...result,
  };
}

function normalizeLang(value) {
  return value === "ar" ? "ar" : "en";
}

export async function registerDeviceForUserService({
  userId,
  token,
  platform,
  lang,
}) {
  if (!userId) {
    throw new ApiError("userId is required", 400);
  }
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new ApiError("token is required", 400);
  }

  const normalizedToken = token.trim();
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedLang = normalizeLang(lang);

  const now = new Date();

  let device = await NotificationDeviceModel.findOne({
    token: normalizedToken,
  });

  if (device) {
    device.user = userId;
    device.guestId = undefined;
    device.platform = normalizedPlatform;
    device.lang = normalizedLang;
    device.lastUsedAt = now;
    await device.save();
  } else {
    device = await NotificationDeviceModel.create({
      user: userId,
      guestId: undefined,
      token: normalizedToken,
      platform: normalizedPlatform,
      lang: normalizedLang,
      lastUsedAt: now,
    });
  }

  return {
    id: device._id,
    userId: device.user,
    token: device.token,
    platform: device.platform,
    lang: device.lang,
    lastUsedAt: device.lastUsedAt,
  };
}

export async function registerDeviceForGuestService({
  guestId,
  token,
  platform,
  lang,
}) {
  if (!guestId) {
    throw new ApiError("guestId is required", 400);
  }
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new ApiError("token is required", 400);
  }

  const normalizedToken = token.trim();
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedLang = normalizeLang(lang);

  const now = new Date();

  let device = await NotificationDeviceModel.findOne({
    token: normalizedToken,
  });

  if (device) {
    device.user = undefined;
    device.guestId = guestId;
    device.platform = normalizedPlatform;
    device.lang = normalizedLang;
    device.lastUsedAt = now;
    await device.save();
  } else {
    device = await NotificationDeviceModel.create({
      guestId,
      token: normalizedToken,
      platform: normalizedPlatform,
      lang: normalizedLang,
      lastUsedAt: now,
    });
  }

  return {
    id: device._id,
    guestId: device.guestId,
    token: device.token,
    platform: device.platform,
    lang: device.lang,
    lastUsedAt: device.lastUsedAt,
  };
}

export async function detachDevicesForUserService({ userId, token } = {}) {
  if (!userId) {
    throw new ApiError("userId is required", 400);
  }

  const hasToken = typeof token === "string" && token.trim();
  const normalizedToken = hasToken ? token.trim() : null;

  if (normalizedToken) {
    const result = await NotificationDeviceModel.updateOne(
      { user: userId, token: normalizedToken },
      { $unset: { user: 1 } },
    );

    return {
      detachedOne: true,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0,
    };
  }

  const result = await NotificationDeviceModel.updateMany(
    { user: userId },
    { $unset: { user: 1 } },
  );

  return {
    detachedOne: false,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
  };
}

function buildDataPayload(data) {
  if (!data || typeof data !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

async function sendPushToTokens({ tokens, notification, data }) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return { skipped: true, successCount: 0, failureCount: 0 };
  }

  const uniqueTokens = Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean),
    ),
  );

  if (!uniqueTokens.length) {
    return { successCount: 0, failureCount: 0 };
  }
  const payloadData = buildDataPayload(data);

  let totalSuccess = 0;
  let totalFailure = 0;

  const batchSize = 500;

  for (let start = 0; start < uniqueTokens.length; start += batchSize) {
    const batchTokens = uniqueTokens.slice(start, start + batchSize);

    const message = {
      tokens: batchTokens,
      notification: notification || undefined,
      data: payloadData,
      android: { priority: "high" },
      apns: {
        payload: { aps: { "content-available": 1 } },
        headers: { "apns-priority": "10" },
      },
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);

      console.log(
        "[Notification] FCM responses (batch starting at index %d):",
        start,
        response.responses.map((r, i) => ({
          index: start + i,
          success: r.success,
          error: r.error
            ? { code: r.error.code, message: r.error.message }
            : null,
        })),
      );

      totalSuccess += response.successCount;
      totalFailure += response.failureCount;
    } catch (err) {
      console.error("[Notification] Failed to send push batch:", err.message);
      totalFailure += batchTokens.length;
    }
  }

  return {
    successCount: totalSuccess,
    failureCount: totalFailure,
  };
}

async function sendPushToUser({ userId, notification, data }) {
  if (!userId) {
    throw new ApiError("userId is required", 400);
  }

  const devices = await NotificationDeviceModel.find({ user: userId });
  const tokens = devices.map((d) => d.token).filter(Boolean);

  const result = await sendPushToTokens({ tokens, notification, data });

  return {
    deviceCount: devices.length,
    ...result,
  };
}

export async function sendOrderStatusChangedNotification(order) {
  if (!order) {
    return { skipped: true };
  }

  const orderNumber = order.orderNumber || "";
  const status = order.status || "";

  // i18n messages
  const title_en = `Order ${orderNumber}`.trim();
  const title_ar = `طلب ${orderNumber}`.trim();
  const body_en = `Your order is now ${status}`;
  const body_ar = `طلبك الآن ${status}`;

  try {
    // For registered users: dispatch both push and in-app
    if (order.user) {
      const result = await dispatchNotification({
        userId: order.user,
        notification: { title_en, title_ar, body_en, body_ar },
        icon: "order",
        action: {
          type: "order_detail",
          screen: "OrderDetailScreen",
          params: { orderId: String(order._id) },
        },
        source: {
          domain: "order",
          event: "status_changed",
          referenceId: String(order._id),
        },
        channels: { push: true, inApp: true },
      });
      return result;
    }

    // For guests: push only (no in-app since no user account)
    if (order.guestId) {
      const result = await sendPushToGuest({
        guestId: order.guestId,
        notification: { title: title_en, body: body_en },
        data: {
          type: "order_status",
          orderId: String(order._id),
          orderNumber,
          status,
        },
      });
      return result;
    }

    return { skipped: true };
  } catch (err) {
    console.error(
      "[Notification] Failed to send order status notification:",
      err.message,
    );
    return { skipped: true };
  }
}

export async function sendReturnStatusChangedNotification(returnRequest) {
  if (!returnRequest) {
    return { skipped: true };
  }

  const status = returnRequest.status || "";
  const statusText = status.toLowerCase();
  const refundMethod = returnRequest.refundMethod || "";

  // i18n messages based on status + refund method
  let body_en;
  let body_ar;

  if (statusText === "approved") {
    if (refundMethod === "wallet") {
      body_en =
        "Your return request has been approved. Refund will be credited to your wallet.";
      body_ar = "تم الموافقة على طلب الإرجاع. سيتم إضافة المبلغ إلى محفظتك.";
    } else if (refundMethod === "card") {
      body_en =
        "Your return request has been approved. Refund will be returned to your payment card.";
      body_ar =
        "تم الموافقة على طلب الإرجاع. سيتم إرجاع المبلغ إلى بطاقة الدفع الخاصة بك.";
    } else {
      // manual
      body_en =
        "Your return request has been approved. Our team will contact you regarding the refund.";
      body_ar =
        "تم الموافقة على طلب الإرجاع. سيتواصل معك فريقنا بخصوص استرداد المبلغ.";
    }
  } else if (statusText === "rejected") {
    body_en = `Your return request has been rejected. Reason: ${returnRequest.rejectionReason}`;
    body_ar = `تم رفض طلب الإرجاع. السبب: ${returnRequest.rejectionReason}`;
  } else {
    body_en = `Your return request status: ${statusText}`;
    body_ar = `حالة طلب الإرجاع: ${statusText}`;
  }

  const title_en = "Return Request Update";
  const title_ar = "تحديث طلب الإرجاع";

  try {
    // Registered user: push + in-app
    if (returnRequest.user) {
      const userId =
        typeof returnRequest.user === "object"
          ? returnRequest.user._id
          : returnRequest.user;

      const result = await dispatchNotification({
        userId,
        notification: { title_en, title_ar, body_en, body_ar },
        icon: "order",
        action: {
          type: "return_detail",
          screen: "ReturnDetailScreen",
          params: { returnId: String(returnRequest._id) },
        },
        source: {
          domain: "return",
          event: "status_changed",
          referenceId: String(returnRequest._id),
        },
        channels: { push: true, inApp: true },
      });
      return result;
    }

    // Guest: push only (no in-app since no user account)
    if (returnRequest.guestId) {
      const result = await sendPushToGuest({
        guestId: returnRequest.guestId,
        notification: { title: title_en, body: body_en },
        data: {
          type: "return_status",
          returnId: String(returnRequest._id),
          status: statusText,
          refundMethod,
        },
      });
      return result;
    }

    return { skipped: true };
  } catch (err) {
    console.error(
      "[Notification] Failed to send return status notification:",
      err.message,
    );
    return { skipped: true };
  }
}

export async function sendAdminCustomNotificationToUsers({
  userIds,
  notification,
  data,
}) {
  const ids = Array.isArray(userIds)
    ? Array.from(new Set(userIds.map((id) => String(id))))
    : [];

  if (!ids.length) {
    throw new ApiError("target.userIds must be a non-empty array", 400);
  }

  const devices = await NotificationDeviceModel.find({ user: { $in: ids } });
  const tokens = devices.map((d) => d.token).filter(Boolean);

  const result = await sendPushToTokens({ tokens, notification, data });

  return {
    userCount: ids.length,
    deviceCount: devices.length,
    ...result,
  };
}

export async function sendBroadcastNotificationToAllDevices({
  notification,
  data,
}) {
  const devices = await NotificationDeviceModel.find({});
  const tokens = devices.map((d) => d.token).filter(Boolean);

  const result = await sendPushToTokens({ tokens, notification, data });

  return {
    deviceCount: devices.length,
    ...result,
  };
}

/**
 * Send notification to all admins with "orders" control enabled
 * and to all moderators of the order's warehouse.
 *
 * @param {Object} order - The order document (must have orderNumber, warehouse, _id)
 */
export async function sendNewOrderNotificationToAdminsAndModerators(order) {
  if (!order) return { skipped: true };

  try {
    const orderNumber = order.orderNumber || "";

    // 1. Find all superAdmins (full access) + admins with "orders" control enabled
    const admins = await UserModel.find({
      active: true,
      $or: [
        { role: roles.SUPER_ADMIN },
        { role: roles.ADMIN, enabledControls: enabledControls.ORDERS },
      ],
    }).select("_id");

    const adminIds = admins.map((a) => String(a._id));

    // 2. Find moderators for the order's warehouse (if any)
    let moderatorIds = [];
    if (order.warehouse) {
      const warehouse = await WarehouseModel.findById(order.warehouse).select(
        "moderators",
      );
      if (warehouse && Array.isArray(warehouse.moderators)) {
        moderatorIds = warehouse.moderators
          .filter(Boolean)
          .map((id) => String(id));
      }
    }

    // 3. Merge and deduplicate
    const allRecipientIds = [...new Set([...adminIds, ...moderatorIds])];

    if (!allRecipientIds.length) {
      return { skipped: true, reason: "no_recipients" };
    }

    // 4. Dispatch notification
    const result = await dispatchNotificationToUsers({
      userIds: allRecipientIds,
      notification: {
        title_en: "New Order Placed",
        title_ar: "طلب جديد",
        body_en: `Order ${orderNumber} has been placed and is awaiting processing.`,
        body_ar: `تم تقديم الطلب ${orderNumber} وينتظر المعالجة.`,
      },
      icon: "order",
      action: {
        type: "order_detail",
        screen: "OrderDetailScreen",
        params: { orderId: String(order._id) },
      },
      source: {
        domain: "order",
        event: "new_order_placed",
        referenceId: String(order._id),
      },
      channels: { push: true, inApp: true },
    });

    return result;
  } catch (err) {
    console.error(
      "[Notification] Failed to send new order notification to admins/moderators:",
      err.message,
    );
    return { skipped: true };
  }
}

/**
 * Send notification to all superadmins and admins with "service_reservations"
 * control enabled when a new service reservation is submitted.
 *
 * @param {Object} reservation - The reservation document (must have _id, serviceType, serviceName_en, serviceName_ar, ownerName)
 */
export async function sendNewServiceReservationNotificationToAdmins(
  reservation,
) {
  if (!reservation) return { skipped: true };

  try {
    const serviceName =
      reservation.serviceName_en || reservation.serviceType || "";
    const ownerName = reservation.ownerName || "";

    // Find all superAdmins + admins with "service_reservations" control enabled
    const admins = await UserModel.find({
      active: true,
      $or: [
        { role: roles.SUPER_ADMIN },
        {
          role: roles.ADMIN,
          enabledControls: enabledControls.SERVICE_RESERVATIONS,
        },
      ],
    }).select("_id");

    const recipientIds = [...new Set(admins.map((a) => String(a._id)))];

    if (!recipientIds.length) {
      return { skipped: true, reason: "no_recipients" };
    }
console.log("reservation",reservation);
    const result = await dispatchNotificationToUsers({
      userIds: recipientIds,
      notification: {
        title_en: "New Service Reservation",
        title_ar: "حجز خدمة جديد",
        body_en: `${ownerName} booked a ${reservation.serviceName_en} reservation on ${reservation.localDate} at ${reservation.localTime}.`,
        body_ar: `قام ${ownerName} بحجز خدمة ${reservation.serviceName_ar} ليوم ${reservation.localDate} في ${reservation.localTime}.`,
      },
      icon: "service",
      action: {
        type: "service_reservation_detail",
        screen: "ServiceReservationDetailScreen",
        params: { reservationId: String(reservation._id) },
      },
      source: {
        domain: "service_reservation",
        event: "new_reservation",
        referenceId: String(reservation._id),
      },
      channels: { push: true, inApp: true },
    });

    return result;
  } catch (err) {
    console.error(
      "[Notification] Failed to send new service reservation notification to admins:",
      err.message,
    );
    return { skipped: true };
  }
}
