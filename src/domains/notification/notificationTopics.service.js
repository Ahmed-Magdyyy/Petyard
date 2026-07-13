import crypto from "crypto";
import { getFirebaseAdmin } from "../../config/firebase.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import { NotificationDeviceModel } from "./notification.model.js";

const INVALID_TOKEN_ERROR_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/sender-id-mismatch",
]);

const DEFAULT_TOPIC_PREFIX = `petyard-${process.env.NODE_ENV || "development"}-broadcast-bucket`;

export const broadcastTopicConfig = {
  bucketCount: parseBoundedInt(
    process.env.FCM_BROADCAST_TOPIC_BUCKET_COUNT,
    60,
    1,
    500,
  ),
  spreadWindowMs: parseBoundedInt(
    process.env.FCM_BROADCAST_SPREAD_WINDOW_MS,
    5 * 60 * 1000,
    0,
    60 * 60 * 1000,
  ),
  subscriptionBatchSize: parseBoundedInt(
    process.env.FCM_TOPIC_SUBSCRIBE_BATCH_SIZE,
    1000,
    1,
    1000,
  ),
  topicPrefix: sanitizeTopicName(
    process.env.FCM_BROADCAST_TOPIC_PREFIX || DEFAULT_TOPIC_PREFIX,
  ),
};

function sanitizeTopicName(value) {
  return String(value || DEFAULT_TOPIC_PREFIX)
    .trim()
    .replace(/[^A-Za-z0-9_.~%-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function padBucket(bucket) {
  const width = Math.max(2, String(broadcastTopicConfig.bucketCount - 1).length);
  return String(bucket).padStart(width, "0");
}

function normalizeTokens(tokens) {
  return Array.from(
    new Set(
      (Array.isArray(tokens) ? tokens : [tokens])
        .map((token) => (typeof token === "string" ? token.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function isInvalidRegistrationTokenError(error) {
  const code = error?.code || error?.errorInfo?.code;
  if (INVALID_TOKEN_ERROR_CODES.has(code)) return true;

  if (code !== "messaging/invalid-argument") return false;

  const message = String(error?.message || "");
  return /registration token|token is not valid/i.test(message);
}

async function deleteInvalidDeviceTokens(tokens) {
  const uniqueTokens = normalizeTokens(tokens);
  if (!uniqueTokens.length) return 0;

  const result = await NotificationDeviceModel.deleteMany({
    token: { $in: uniqueTokens },
  });

  return result.deletedCount || 0;
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

export function getBroadcastTopicBucketForToken(token) {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken) return null;

  const digest = crypto.createHash("sha256").update(normalizedToken).digest();
  const hash = digest.readUInt32BE(0);
  return hash % broadcastTopicConfig.bucketCount;
}

export function getBroadcastTopicNameForBucket(bucket) {
  return `${broadcastTopicConfig.topicPrefix}-${padBucket(bucket)}`;
}

export function getBroadcastTopicForToken(token) {
  const bucket = getBroadcastTopicBucketForToken(token);
  if (bucket === null) return null;

  return {
    bucket,
    topic: getBroadcastTopicNameForBucket(bucket),
  };
}

export function getBroadcastTopicBuckets() {
  return Array.from({ length: broadcastTopicConfig.bucketCount }, (_, bucket) => ({
    bucket,
    topic: getBroadcastTopicNameForBucket(bucket),
  }));
}

export function getBroadcastBucketDelayMs(bucketIndex) {
  if (broadcastTopicConfig.bucketCount <= 1) return 0;
  return Math.floor(
    (broadcastTopicConfig.spreadWindowMs * bucketIndex) /
      broadcastTopicConfig.bucketCount,
  );
}

export async function subscribeTokensToBroadcastTopic(tokens, topic) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return {
      skipped: true,
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0,
      deletedInvalidTokenCount: 0,
    };
  }

  const uniqueTokens = normalizeTokens(tokens);
  if (!uniqueTokens.length) {
    return {
      successCount: 0,
      failureCount: 0,
      invalidTokenCount: 0,
      deletedInvalidTokenCount: 0,
    };
  }

  const response = await admin.messaging().subscribeToTopic(uniqueTokens, topic);
  const invalidTokens = [];

  for (const item of response.errors || []) {
    const token = uniqueTokens[item.index];
    if (token && isInvalidRegistrationTokenError(item.error)) {
      invalidTokens.push(token);
    }
  }

  const deletedInvalidTokenCount = invalidTokens.length
    ? await deleteInvalidDeviceTokens(invalidTokens)
    : 0;

  return {
    successCount: response.successCount || 0,
    failureCount: response.failureCount || 0,
    invalidTokenCount: invalidTokens.length,
    deletedInvalidTokenCount,
  };
}

export async function subscribeDeviceToBroadcastTopic(token) {
  const topicInfo = getBroadcastTopicForToken(token);
  if (!topicInfo) {
    return {
      skipped: true,
      reason: "empty_token",
    };
  }

  return subscribeTokensToBroadcastTopic([token], topicInfo.topic);
}

export function subscribeDeviceToBroadcastTopicInBackground(token) {
  subscribeDeviceToBroadcastTopic(token).catch((err) => {
    console.error(
      "[Notification Topics] Failed to subscribe device to broadcast topic:",
      err?.message || err,
    );
  });
}

export async function syncBroadcastTopicsForDevices() {
  const buckets = new Map();
  for (const { bucket, topic } of getBroadcastTopicBuckets()) {
    buckets.set(bucket, { topic, tokens: [] });
  }

  const cursor = NotificationDeviceModel.find(
    { token: { $exists: true, $nin: ["", null] } },
    { token: 1 },
  )
    .lean()
    .cursor();

  let scannedDeviceCount = 0;
  for await (const device of cursor) {
    const topicInfo = getBroadcastTopicForToken(device.token);
    if (!topicInfo) continue;

    scannedDeviceCount += 1;
    buckets.get(topicInfo.bucket)?.tokens.push(device.token);
  }

  let successCount = 0;
  let failureCount = 0;
  let invalidTokenCount = 0;
  let deletedInvalidTokenCount = 0;
  let subscribedBatchCount = 0;

  for (const { topic, tokens } of buckets.values()) {
    for (let start = 0; start < tokens.length; start += broadcastTopicConfig.subscriptionBatchSize) {
      const batchTokens = tokens.slice(
        start,
        start + broadcastTopicConfig.subscriptionBatchSize,
      );

      const result = await subscribeTokensToBroadcastTopic(batchTokens, topic);
      successCount += result.successCount || 0;
      failureCount += result.failureCount || 0;
      invalidTokenCount += result.invalidTokenCount || 0;
      deletedInvalidTokenCount += result.deletedInvalidTokenCount || 0;
      subscribedBatchCount += 1;
    }
  }

  return {
    scannedDeviceCount,
    bucketCount: broadcastTopicConfig.bucketCount,
    subscribedBatchCount,
    successCount,
    failureCount,
    invalidTokenCount,
    deletedInvalidTokenCount,
  };
}

export async function sendPushToBroadcastTopic({
  topic,
  notification,
  data,
  pushOptions,
}) {
  const admin = getFirebaseAdmin();
  if (!admin) {
    return {
      skipped: true,
      topicMessageCount: 0,
      successCount: 0,
      failureCount: 0,
    };
  }

  const message = {
    topic,
    notification: notification || undefined,
    data: buildDataPayload(data),
    ...buildPushPlatformConfig(pushOptions),
  };

  const messageId = await admin.messaging().send(message);

  return {
    topic,
    messageId,
    topicMessageCount: 1,
    successCount: 1,
    failureCount: 0,
  };
}
