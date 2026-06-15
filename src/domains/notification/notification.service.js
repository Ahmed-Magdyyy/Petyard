import { ApiError } from "../../shared/utils/ApiError.js";
import { getFirebaseAdmin } from "../../config/firebase.js";
import { NotificationDeviceModel } from "./notification.model.js";
import {
  dispatchNotification,
  dispatchNotificationToUsers,
} from "./notificationDispatcher.js";
import { UserModel } from "../user/user.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import {
  toCairoDateISO,
  toCairoHour24,
  formatHourLabel12,
} from "../serviceReservation/reservations/serviceReservation.utils.js";
import { roles, enabledControls, paymentMethodEnum, orderStatusEnum } from "../../shared/constants/enums.js";

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
  const isGuest = !order.user;
  const paymentMethod = order.paymentMethod || "";

  // Build personalized i18n messages based on the current status
  let title_en, title_ar, body_en, body_ar;

  switch (status) {
    case orderStatusEnum.ACCEPTED:
      title_en = `Order #${orderNumber} Confirmed`;
      title_ar = `تم تأكيد الطلب #${orderNumber}`;
      body_en = `Your order has been placed and is being processed. We'll notify you when it's on its way!`;
      body_ar = `تم استلام طلبك وجاري تجهيزه. هنبلغك أول ما يطلع للتوصيل! 🐾`;
      break;

    case orderStatusEnum.SHIPPED:
      title_en = `Order #${orderNumber} Out for Delivery`;
      title_ar = `طلبك #${orderNumber} في الطريق إليك`;
      body_en = `Your order is out for delivery. It will arrive soon!`;
      body_ar = `طلبك طلع للتوصيل وفي الطريق إليك. و هيوصلك قريب! 🚚`;
      break;

    case orderStatusEnum.DELIVERED:
      title_en = `Order #${orderNumber} Delivered`;
      title_ar = `تم توصيل الطلب #${orderNumber}`;
      body_en = `Your order has been delivered. We hope your pet enjoys it! 🐾`;
      body_ar = `طلبك وصل! نتمنى يعجب أليفك ويستمتع بيه 🐾❤️`;
      break;

    case orderStatusEnum.CANCELLED:
      title_en = `Order #${orderNumber} Cancelled`;
      title_ar = `تم إلغاء الطلب #${orderNumber}`;
      body_en = `Your order has been cancelled. We hope to see you again soon!`;
      body_ar = `للأسف تم إلغاء طلبك. نتمنى نشوفك تاني قريب! 🙏`;
      break;

    case orderStatusEnum.RETURNED:
      title_en = `Order #${orderNumber} Returned`;
      title_ar = `تم إرجاع الطلب #${orderNumber}`;

      if (isGuest && paymentMethod === paymentMethodEnum.CARD) {
        // Guest paid with card → refund to card
        body_en = `Your order has been returned. The refund will be returned to your payment card.`;
        body_ar = `تم إرجاع طلبك. المبلغ هيترد على الكارت اللي دفعت بيه.`;
      } else if (!isGuest && paymentMethod === paymentMethodEnum.CARD) {
        // Registered user paid with card → refund to wallet
        body_en = `Your order has been returned. The refund has been credited to your wallet.`;
        body_ar = `تم إرجاع طلبك. المبلغ اترد إلى محفظتك في التطبيق.`;
      } else {
        // Guest or user paid with COD/POS/InstaPay → manual refund
        body_en = `Your order has been returned. Our team will contact you regarding the refund.`;
        body_ar = `تم إرجاع طلبك. فريقنا هيتواصل معاك بخصوص استرداد المبلغ.`;
      }
      break;

    default:
      // No push for pending/awaiting_payment/failed — FE already handles these
      return { skipped: true, reason: "no_notification_for_status" };
  }

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

    // 1. Find all superAdmins + admins with "orders" control — fetch name & role too
    const admins = await UserModel.find({
      active: true,
      $or: [
        { role: roles.SUPER_ADMIN },
        { role: roles.ADMIN, enabledControls: enabledControls.ORDERS },
      ],
    }).select("_id name email role");

    // Build userId → { name, role } map from admins
    const userDetailsMap = new Map(
      admins.map((a) => [String(a._id), { name: a.name, role: a.role }])
    );

    const adminIds = admins.map((a) => String(a._id));

    // 2. Find moderators for the order's warehouse (if any)
    let moderatorIds = [];
    if (order.warehouse) {
      const warehouse = await WarehouseModel.findById(order.warehouse).select("moderators");
      if (warehouse && Array.isArray(warehouse.moderators)) {
        moderatorIds = warehouse.moderators.filter(Boolean).map((id) => String(id));

        // Fetch name & role for moderators not already in the map
        const unknownModIds = moderatorIds.filter((id) => !userDetailsMap.has(id));
        if (unknownModIds.length) {
          const mods = await UserModel.find({ _id: { $in: unknownModIds } }).select("_id email name role");
          mods.forEach((m) => userDetailsMap.set(String(m._id), { name: m.name, role: m.role }));
        }
      }
    }

    // 3. Merge and deduplicate
    const allRecipientIds = [...new Set([...adminIds, ...moderatorIds])];

    if (!allRecipientIds.length) {
      return { skipped: true, reason: "no_recipients" };
    }

    // 4. Fetch device tokens for all recipients and log the full picture
    const devices = await NotificationDeviceModel.find({ user: { $in: allRecipientIds } }).select("user token platform");

    // userId → [token, ...]
    const userTokensMap = new Map();
    for (const device of devices) {
      if (!device.token) continue;
      const uid = String(device.user);
      if (!userTokensMap.has(uid)) userTokensMap.set(uid, []);
      userTokensMap.get(uid).push({ token: `...${device.token.slice(-12)}`, platform: device.platform });
    }

    const recipients = allRecipientIds.map((uid) => {
      const { name = "unknown", role = "unknown" } = userDetailsMap.get(uid) || {};
      const tokens = userTokensMap.get(uid) || [];
      return {
        userId: uid,
        name,
        role,
        deviceCount: tokens.length,
        tokens: tokens.length ? tokens : "⚠️ no registered device",
      };
    });

    console.log(
      `[Push] New order #${orderNumber} — notifying ${allRecipientIds.length} recipient(s):\n` +
      JSON.stringify(recipients, null, 2)
    );

    // 5. Dispatch notification
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
 * Send notification to all admins with "orders" control enabled
 * and to all moderators of the order's warehouse when a return request is submitted.
 *
 * @param {Object} order - The order document
 * @param {Object} returnRequest - The return document
 */
export async function sendNewReturnRequestNotificationToAdminsAndModerators(
  order,
  returnRequest,
) {
  if (!order || !returnRequest) return { skipped: true };

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

    // 2. Find moderators for the return's warehouse (if any)
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
        title_en: "New Return Request",
        title_ar: "طلب إرجاع جديد",
        body_en: `A return request for order ${orderNumber} has been submitted and is awaiting review.`,
        body_ar: `تم تقديم طلب إرجاع للاوردر ${orderNumber} وينتظر المراجعة.`,
      },
      icon: "order",
      action: {
        type: "return_detail",
        screen: "ReturnDetailScreen",
        params: { returnId: String(returnRequest._id) },
      },
      source: {
        domain: "return",
        event: "new_return_request",
        referenceId: String(returnRequest._id),
      },
      channels: { push: true, inApp: true },
    });

    return result;
  } catch (err) {
    console.error(
      "[Notification] Failed to send new return request notification to admins/moderators:",
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

    // Compute local date/time from startsAt (Cairo timezone)
    const localDate = toCairoDateISO(reservation.startsAt);
    const hour24 = toCairoHour24(reservation.startsAt);
    const label = formatHourLabel12(hour24);

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

    const result = await dispatchNotificationToUsers({
      userIds: recipientIds,
      notification: {
        title_en: "New Service Reservation",
        title_ar: "حجز خدمة جديد",
        body_en: `${ownerName} booked a ${serviceName} reservation on ${localDate} at ${label}.`,
        body_ar: `قام ${ownerName} بحجز خدمة ${reservation.serviceName_ar || serviceName} ليوم ${localDate} في ${label}.`,
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
