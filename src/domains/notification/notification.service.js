import { ApiError } from "../../shared/ApiError.js";
import { getFirebaseAdmin } from "../../shared/firebaseAdmin.js";
import { NotificationDeviceModel } from "./notification.model.js";

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
        .filter(Boolean)
    )
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
        }))
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

  const title = `Order ${order.orderNumber || ""}`.trim();
  const body = `Your order is now ${order.status}`;

  const data = {
    type: "order_status",
    orderId: String(order._id),
    orderNumber: order.orderNumber || "",
    status: order.status || "",
  };

  try {
    if (order.user) {
      const result = await sendPushToUser({
        userId: order.user,
        notification: { title, body },
        data,
      });
      return result;
    }

    if (order.guestId) {
      const result = await sendPushToGuest({
        guestId: order.guestId,
        notification: { title, body },
        data,
      });
      return result;
    }

    return { skipped: true };
  } catch (err) {
    console.error(
      "[Notification] Failed to send order status notification:",
      err.message
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

export async function sendBroadcastNotificationToAllDevices({ notification, data }) {
  const devices = await NotificationDeviceModel.find({});
  const tokens = devices.map((d) => d.token).filter(Boolean);

  const result = await sendPushToTokens({ tokens, notification, data });

  return {
    deviceCount: devices.length,
    ...result,
  };
}
