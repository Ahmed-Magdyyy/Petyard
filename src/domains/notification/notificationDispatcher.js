/**
 * Unified Notification Dispatcher
 * 
 * Single entry point for sending notifications across all channels:
 * - Push (Firebase Cloud Messaging)
 * - In-App (Persistent notifications stored in DB)
 * 
 * Usage:
 *   await dispatchNotification({
 *     userId: "...",
 *     notification: { title_en: "...", body_en: "..." },
 *     icon: "order",
 *     action: { type: "order_detail", screen: "OrderDetailScreen", params: { orderId: "..." } },
 *     source: { domain: "order", event: "status_changed", referenceId: "..." },
 *     channels: { push: true, inApp: true }
 *   });
 */

import { NotificationDeviceModel } from "./notification.model.js";
import { getFirebaseAdmin } from "../../config/firebase.js";
import {
  createInAppNotificationService,
  createBulkInAppNotificationsService,
} from "./inAppNotification.service.js";

/**
 * Build FCM data payload (all values must be strings)
 */
function buildDataPayload(data) {
  if (!data || typeof data !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Send push notification to specific tokens
 */
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
      totalSuccess += response.successCount;
      totalFailure += response.failureCount;
    } catch (err) {
      console.error("[Notification] Failed to send push batch:", err.message);
      totalFailure += batchTokens.length;
    }
  }

  return { successCount: totalSuccess, failureCount: totalFailure };
}

/**
 * Auto-expiry days based on notification source domain
 * Order/return: 6 months (important for reference)
 * Others: shorter TTLs based on relevance
 */
const EXPIRY_DAYS_BY_DOMAIN = {
  order: 180,           // 6 months
  return: 180,          // 6 months
  reservation: 14,      // 2 weeks after service
  loyalty: 30,          // 1 month
  pet: 7,               // 1 week (birthday)
  admin: 30,            // 1 month (promos)
  default: 30,          // 1 month fallback
};

/**
 * Compute expiresAt date based on source domain
 */
function computeExpiresAt(source, providedExpiresAt) {
  // If explicitly provided, use that
  if (providedExpiresAt) {
    return providedExpiresAt;
  }

  const domain = source?.domain || "default";
  const days = EXPIRY_DAYS_BY_DOMAIN[domain] ?? EXPIRY_DAYS_BY_DOMAIN.default;
  
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

/**
 * Dispatch notification to a single user
 * 
 * @param {Object} params
 * @param {string} params.userId - Target user ID
 * @param {Object} params.notification - { title_en, title_ar, body_en, body_ar }
 * @param {string} params.icon - Icon type for in-app display
 * @param {Object} params.action - { type, screen, params } for deep linking
 * @param {Object} params.source - { domain, event, referenceId } for tracking
 * @param {Object} params.channels - { push: boolean, inApp: boolean }
 * @param {Date} params.expiresAt - Optional expiry for in-app notification
 */
export async function dispatchNotification({
  userId,
  notification,
  icon = "system",
  action,
  source,
  channels = { push: true, inApp: true },
  expiresAt,
}) {
  if (!userId) {
    return { push: null, inApp: null };
  }

  const results = { push: null, inApp: null };

  // 1. Store In-App Notification
  if (channels.inApp) {
    try {
      const inAppResult = await createInAppNotificationService({
        userId,
        title_en: notification?.title_en || notification?.title || "",
        title_ar: notification?.title_ar,
        body_en: notification?.body_en || notification?.body || "",
        body_ar: notification?.body_ar,
        icon,
        action,
        source,
        expiresAt: computeExpiresAt(source, expiresAt),
      });
      results.inApp = { success: !!inAppResult };
    } catch (err) {
      console.error("[Dispatcher] Failed to create in-app notification:", err.message);
      results.inApp = { success: false, error: err.message };
    }
  }

  // 2. Send Push Notification
  if (channels.push) {
    try {
      const devices = await NotificationDeviceModel.find({ user: userId });
      const tokens = devices.map((d) => d.token).filter(Boolean);

      // Use English as default for push (could be enhanced to use user's preferred lang)
      const pushResult = await sendPushToTokens({
        tokens,
        notification: {
          title: notification?.title_en || notification?.title || "",
          body: notification?.body_en || notification?.body || "",
        },
        data: {
          type: action?.type || source?.event || "notification",
          screen: action?.screen || "",
          ...(action?.params || {}),
          ...(source?.referenceId ? { referenceId: source.referenceId } : {}),
        },
      });

      results.push = {
        deviceCount: devices.length,
        ...pushResult,
      };
    } catch (err) {
      console.error("[Dispatcher] Failed to send push notification:", err.message);
      results.push = { success: false, error: err.message };
    }
  }

  return results;
}

/**
 * Dispatch notification to multiple users
 * 
 * @param {Object} params
 * @param {string[]} params.userIds - Target user IDs
 * @param {Object} params.notification - { title_en, title_ar, body_en, body_ar }
 * @param {string} params.icon - Icon type
 * @param {Object} params.action - { type, screen, params }
 * @param {Object} params.source - { domain, event }
 * @param {Object} params.channels - { push: boolean, inApp: boolean }
 */
export async function dispatchNotificationToUsers({
  userIds,
  notification,
  icon = "system",
  action,
  source,
  channels = { push: true, inApp: true },
  expiresAt,
}) {
  const ids = Array.isArray(userIds)
    ? Array.from(new Set(userIds.map((id) => String(id))))
    : [];

  if (!ids.length) {
    return { push: null, inApp: null };
  }

  const results = { push: null, inApp: null };

  // 1. Bulk create In-App Notifications
  if (channels.inApp) {
    try {
      const inAppResult = await createBulkInAppNotificationsService({
        userIds: ids,
        title_en: notification?.title_en || notification?.title || "",
        title_ar: notification?.title_ar,
        body_en: notification?.body_en || notification?.body || "",
        body_ar: notification?.body_ar,
        icon,
        action,
        source,
        expiresAt: computeExpiresAt(source, expiresAt),
      });
      results.inApp = inAppResult;
    } catch (err) {
      console.error("[Dispatcher] Failed to create bulk in-app notifications:", err.message);
      results.inApp = { success: false, error: err.message };
    }
  }

  // 2. Send Push to all users' devices
  if (channels.push) {
    try {
      const devices = await NotificationDeviceModel.find({ user: { $in: ids } });
      const tokens = devices.map((d) => d.token).filter(Boolean);

      const pushResult = await sendPushToTokens({
        tokens,
        notification: {
          title: notification?.title_en || notification?.title || "",
          body: notification?.body_en || notification?.body || "",
        },
        data: {
          type: action?.type || source?.event || "notification",
          screen: action?.screen || "",
          ...(action?.params || {}),
        },
      });

      results.push = {
        userCount: ids.length,
        deviceCount: devices.length,
        ...pushResult,
      };
    } catch (err) {
      console.error("[Dispatcher] Failed to send push to users:", err.message);
      results.push = { success: false, error: err.message };
    }
  }

  return results;
}

/**
 * Broadcast notification to all devices (push only for guests too)
 * In-app only created for registered users
 */
export async function dispatchBroadcastNotification({
  notification,
  icon = "system",
  action,
  source,
  channels = { push: true, inApp: true },
  expiresAt,
}) {
  const results = { push: null, inApp: null };

  // 1. Create in-app for all users with registered devices
  if (channels.inApp) {
    try {
      // Get unique user IDs from devices
      const devices = await NotificationDeviceModel.find({ user: { $exists: true, $ne: null } })
        .distinct("user");

      if (devices.length > 0) {
        const inAppResult = await createBulkInAppNotificationsService({
          userIds: devices,
          title_en: notification?.title_en || notification?.title || "",
          title_ar: notification?.title_ar,
          body_en: notification?.body_en || notification?.body || "",
          body_ar: notification?.body_ar,
          icon,
          action,
          source,
          expiresAt: computeExpiresAt(source, expiresAt),
        });
        results.inApp = { ...inAppResult, userCount: devices.length };
      } else {
        results.inApp = { insertedCount: 0, userCount: 0 };
      }
    } catch (err) {
      console.error("[Dispatcher] Failed to create broadcast in-app notifications:", err.message);
      results.inApp = { success: false, error: err.message };
    }
  }

  // 2. Send push to ALL devices (including guests)
  if (channels.push) {
    try {
      const devices = await NotificationDeviceModel.find({});
      const tokens = devices.map((d) => d.token).filter(Boolean);

      const pushResult = await sendPushToTokens({
        tokens,
        notification: {
          title: notification?.title_en || notification?.title || "",
          body: notification?.body_en || notification?.body || "",
        },
        data: {
          type: action?.type || source?.event || "notification",
          screen: action?.screen || "",
          ...(action?.params || {}),
        },
      });

      results.push = {
        deviceCount: devices.length,
        ...pushResult,
      };
    } catch (err) {
      console.error("[Dispatcher] Failed to send broadcast push:", err.message);
      results.push = { success: false, error: err.message };
    }
  }

  return results;
}
