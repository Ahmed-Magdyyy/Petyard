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
 *     channels: { push: true, inApp: true },
 *     pushOptions: { android: { channelId: "...", sound: "..." }, apns: { sound: "...", headers: {} } }
 *   });
 */

import { NotificationDeviceModel } from "./notification.model.js";
import { getFirebaseAdmin } from "../../config/firebase.js";
import {
  createInAppNotificationService,
  createBulkInAppNotificationsService,
} from "./inAppNotification.service.js";
import { parseBoundedInt } from "../../shared/utils/env.js";

const FCM_BATCH_SIZE = parseBoundedInt(
  process.env.FCM_PUSH_BATCH_SIZE,
  500,
  1,
  500,
);

const BROADCAST_BATCH_DELAY_MS = parseBoundedInt(
  process.env.FCM_BROADCAST_BATCH_DELAY_MS,
  250,
  0,
  10000,
);

const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/sender-id-mismatch",
]);

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUniqueTokens(tokens) {
  return Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [])
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
    )
  );
}

async function getDistinctDeviceTokens(filter = {}) {
  const tokens = await NotificationDeviceModel.distinct("token", filter);
  return getUniqueTokens(tokens);
}

export async function getBroadcastDeviceCount() {
  return NotificationDeviceModel.countDocuments({
    token: { $exists: true, $nin: ["", null] },
  });
}

function isInvalidRegistrationTokenError(error) {
  const code = error?.code || error?.errorInfo?.code;
  if (INVALID_TOKEN_ERROR_CODES.has(code)) return true;

  if (code !== "messaging/invalid-argument") return false;

  const message = String(error?.message || "");
  return /registration token|token is not valid/i.test(message);
}

async function deleteInvalidDeviceTokens(tokens) {
  const uniqueTokens = getUniqueTokens(tokens);
  if (!uniqueTokens.length) return 0;

  const result = await NotificationDeviceModel.deleteMany({
    token: { $in: uniqueTokens },
  });

  return result.deletedCount || 0;
}

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

function buildPushPlatformConfig(pushOptions = {}) {
  const options = pushOptions && typeof pushOptions === "object" ? pushOptions : {};
  const androidOptions = options.android || {};
  const apnsOptions = options.apns || {};
  const apnsHeaders =
    apnsOptions.headers && typeof apnsOptions.headers === "object"
      ? apnsOptions.headers
      : {};

  const androidNotification = {
    sound: androidOptions.sound || "default",
  };

  if (androidOptions.channelId) {
    androidNotification.channelId = androidOptions.channelId;
  }

  return {
    android: {
      priority: "high",
      notification: androidNotification,
    },
    apns: {
      payload: {
        aps: {
          "content-available": 1,
          "mutable-content": 1,
          sound: apnsOptions.sound || "default",
        },
      },
      headers: { "apns-priority": "10", ...apnsHeaders },
    },
  };
}

/**
 * Send push notification to specific tokens
 */
async function sendPushToTokens({
  tokens,
  notification,
  data,
  pushOptions,
  batchDelayMs = 0,
}) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return { skipped: true, successCount: 0, failureCount: 0 };
  }

  const uniqueTokens = getUniqueTokens(tokens);

  if (!uniqueTokens.length) {
    return { successCount: 0, failureCount: 0 };
  }

  const payloadData = buildDataPayload(data);
  let totalSuccess = 0;
  let totalFailure = 0;
  const batchSize = FCM_BATCH_SIZE;

  for (let start = 0; start < uniqueTokens.length; start += batchSize) {
    const batchTokens = uniqueTokens.slice(start, start + batchSize);

    const message = {
      tokens: batchTokens,
      notification: notification || undefined,
      data: payloadData,
      ...buildPushPlatformConfig(pushOptions),
    };

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFailure += response.failureCount;

      const invalidTokens = [];
      response.responses.forEach((tokenResponse, index) => {
        if (
          !tokenResponse.success &&
          isInvalidRegistrationTokenError(tokenResponse.error)
        ) {
          invalidTokens.push(batchTokens[index]);
        }
      });

      if (invalidTokens.length > 0) {
        await deleteInvalidDeviceTokens(invalidTokens);
      }
    } catch (err) {
      console.error("[Push] Batch send failed:", err.message);
      totalFailure += batchTokens.length;
    }

    if (batchDelayMs > 0 && start + batchSize < uniqueTokens.length) {
      await sleep(batchDelayMs);
    }
  }

  return {
    successCount: totalSuccess,
    failureCount: totalFailure,
  };
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
 * @param {Object} params.pushOptions - Optional platform-specific push settings
 */
export async function dispatchNotification({
  userId,
  notification,
  icon = "system",
  action,
  source,
  channels = { push: true, inApp: true },
  expiresAt,
  pushOptions,
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
      const tokens = await getDistinctDeviceTokens({ user: userId });

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
        pushOptions,
      });

      results.push = {
        deviceCount: tokens.length,
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
 * @param {Object} params.pushOptions - Optional platform-specific push settings
 */
export async function dispatchNotificationToUsers({
  userIds,
  notification,
  icon = "system",
  action,
  source,
  channels = { push: true, inApp: true },
  expiresAt,
  pushOptions,
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
      const tokens = await getDistinctDeviceTokens({ user: { $in: ids } });

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
        pushOptions,
      });

      results.push = {
        userCount: ids.length,
        deviceCount: tokens.length,
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
  pushOptions,
}) {
  const results = { push: null, inApp: null };

  // 1. Create in-app for all users with registered devices
  if (channels.inApp) {
    try {
      // Get unique user IDs from devices
      const userIds = await NotificationDeviceModel.distinct("user", {
        user: { $exists: true, $ne: null },
      });

      if (userIds.length > 0) {
        const inAppResult = await createBulkInAppNotificationsService({
          userIds,
          title_en: notification?.title_en || notification?.title || "",
          title_ar: notification?.title_ar,
          body_en: notification?.body_en || notification?.body || "",
          body_ar: notification?.body_ar,
          icon,
          action,
          source,
          expiresAt: computeExpiresAt(source, expiresAt),
        });
        results.inApp = { ...inAppResult, userCount: userIds.length };
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
      const tokens = await getDistinctDeviceTokens();

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
        pushOptions,
        batchDelayMs: BROADCAST_BATCH_DELAY_MS,
      });

      results.push = {
        deviceCount: tokens.length,
        ...pushResult,
      };
    } catch (err) {
      console.error("[Dispatcher] Failed to send broadcast push:", err.message);
      results.push = { success: false, error: err.message };
    }
  }

  return results;
}
