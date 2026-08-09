import crypto from "node:crypto";
import { ApiError } from "../../shared/utils/ApiError.js";
import { notificationOutboxStatusEnum } from "../../shared/constants/enums.js";
import { NotificationOutboxModel } from "./notificationOutbox.model.js";

const SAFE_ACTION_PARAM_KEYS = new Set([
  "orderId",
  "substitutionRequestId",
  "requestId",
  "notificationId",
  "returnId",
  "reservationId",
  "productId",
]);

const SENSITIVE_KEY_PATTERN = /token|secret|proof|url|authorization|card|payment/i;
const URL_VALUE_PATTERN = /^(?:https?:)?\/\//i;
const MAX_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

function fail(message, statusCode = 400, code) {
  const error = new ApiError(message, statusCode);
  if (code) error.code = code;
  throw error;
}

function asTrimmedString(value, field, { required = false, maxLength = 512 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return undefined;
  }

  if (typeof value !== "string") fail(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) fail(`${field} is required`);
  if (normalized.length > maxLength) fail(`${field} is too long`);
  if (URL_VALUE_PATTERN.test(normalized)) {
    fail(`${field} must not contain a URL`, 400, "UNSAFE_NOTIFICATION_PAYLOAD");
  }
  return normalized || undefined;
}

function asPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field} must be a plain object`);
  }
  return value;
}

function sanitizeAction(action) {
  if (action === undefined || action === null) return undefined;
  const candidate = asPlainObject(action, "action");
  const params = candidate.params === undefined ? {} : asPlainObject(candidate.params, "action.params");

  for (const [key, value] of Object.entries(params)) {
    if (
      !SAFE_ACTION_PARAM_KEYS.has(key) ||
      SENSITIVE_KEY_PATTERN.test(key) ||
      typeof value === "object" ||
      typeof value === "function" ||
      (typeof value === "string" && URL_VALUE_PATTERN.test(value.trim()))
    ) {
      fail("action.params contains an unsafe value", 400, "UNSAFE_NOTIFICATION_PAYLOAD");
    }
  }

  return {
    ...(asTrimmedString(candidate.type, "action.type", { maxLength: 80 })
      ? { type: asTrimmedString(candidate.type, "action.type", { maxLength: 80 }) }
      : {}),
    ...(asTrimmedString(candidate.screen, "action.screen", { maxLength: 120 })
      ? { screen: asTrimmedString(candidate.screen, "action.screen", { maxLength: 120 }) }
      : {}),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

function sanitizeSource(source) {
  if (source === undefined || source === null) return undefined;
  const candidate = asPlainObject(source, "source");
  const allowed = ["domain", "event", "referenceId"];
  for (const key of Object.keys(candidate)) {
    if (!allowed.includes(key)) fail("source contains an unsupported field");
  }
  return {
    ...(asTrimmedString(candidate.domain, "source.domain", { maxLength: 80 })
      ? { domain: asTrimmedString(candidate.domain, "source.domain", { maxLength: 80 }) }
      : {}),
    ...(asTrimmedString(candidate.event, "source.event", { maxLength: 120 })
      ? { event: asTrimmedString(candidate.event, "source.event", { maxLength: 120 }) }
      : {}),
    ...(asTrimmedString(candidate.referenceId, "source.referenceId", { maxLength: 120 })
      ? { referenceId: asTrimmedString(candidate.referenceId, "source.referenceId", { maxLength: 120 }) }
      : {}),
  };
}

function buildRecipient({ recipientUser, recipientGuestId }) {
  const hasUser = Boolean(recipientUser);
  const guestId =
    typeof recipientGuestId === "string" ? recipientGuestId.trim() : "";
  const hasGuest = Boolean(guestId);
  if (hasUser === hasGuest) {
    fail("Exactly one outbox recipient (recipientUser or recipientGuestId) is required");
  }
  return hasUser ? { recipientUser } : { recipientGuestId: guestId };
}

function numberWithin(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) fail("Notification timing value must be a finite number");
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function sanitizeDeliveryError(error) {
  const rawCode = String(error?.code || "DELIVERY_FAILED").trim();
  const code = /^[A-Z0-9_.-]{1,80}$/i.test(rawCode)
    ? rawCode
    : "DELIVERY_FAILED";
  // Persist a generic bounded diagnostic only. Provider text can include tokens,
  // URLs, or payload fragments and must not become durable notification data.
  const rawMessage = String(error?.message || "Delivery failed")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(?:token|secret|authorization|card|proof)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .trim();
  return {
    code,
    message: (rawMessage || "Delivery failed").slice(0, 512),
  };
}

function withSession(options, session) {
  return session ? { ...options, session } : options;
}

/**
 * Enqueue one recipient-specific notification. The caller supplies a stable
 * dedupe key (for example, substitution-request-id + recipient + event).
 */
export async function enqueueNotificationOutbox({
  recipientUser,
  recipientGuestId,
  dedupeKey,
  title_en,
  title_ar,
  body_en,
  body_ar,
  icon = "system",
  action,
  source,
  session,
  model = NotificationOutboxModel,
}) {
  const document = {
    ...buildRecipient({ recipientUser, recipientGuestId }),
    dedupeKey: asTrimmedString(dedupeKey, "dedupeKey", { required: true, maxLength: 256 }),
    title_en: asTrimmedString(title_en, "title_en", { required: true, maxLength: 256 }),
    ...(asTrimmedString(title_ar, "title_ar", { maxLength: 256 }) ? { title_ar: asTrimmedString(title_ar, "title_ar", { maxLength: 256 }) } : {}),
    body_en: asTrimmedString(body_en, "body_en", { required: true, maxLength: 1024 }),
    ...(asTrimmedString(body_ar, "body_ar", { maxLength: 1024 }) ? { body_ar: asTrimmedString(body_ar, "body_ar", { maxLength: 1024 }) } : {}),
    icon: asTrimmedString(icon, "icon", { required: true, maxLength: 40 }),
    ...(sanitizeAction(action) ? { action: sanitizeAction(action) } : {}),
    ...(sanitizeSource(source) ? { source: sanitizeSource(source) } : {}),
  };

  try {
    const created = await model.create([document], withSession({}, session));
    return Array.isArray(created) ? created[0] : created;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await model.findOne(
      { dedupeKey: document.dedupeKey },
      null,
      withSession({}, session),
    );
    if (existing) return existing;
    throw error;
  }
}

export async function findNotificationOutboxByDedupeKey({
  dedupeKey,
  session,
  model = NotificationOutboxModel,
}) {
  const normalized = asTrimmedString(dedupeKey, "dedupeKey", { required: true, maxLength: 256 });
  return model.findOne(
    { dedupeKey: normalized },
    null,
    withSession({}, session),
  );
}

/** Claim exactly one due record, or reclaim one whose worker lease expired. */
export async function claimNextNotificationOutbox({
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  session,
  model = NotificationOutboxModel,
} = {}) {
  const claimedAt = new Date(now);
  if (Number.isNaN(claimedAt.getTime())) fail("now must be a valid date");
  const effectiveLeaseMs = numberWithin(leaseMs, DEFAULT_LEASE_MS, 1_000, MAX_LEASE_MS);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(claimedAt.getTime() + effectiveLeaseMs);

  return model.findOneAndUpdate(
    {
      $or: [
        {
          status: notificationOutboxStatusEnum.PENDING,
          nextAttemptAt: { $lte: claimedAt },
        },
        {
          status: notificationOutboxStatusEnum.RETRYABLE,
          nextAttemptAt: { $lte: claimedAt },
        },
        {
          status: notificationOutboxStatusEnum.PROCESSING,
          leaseExpiresAt: { $lte: claimedAt },
        },
      ],
    },
    {
      $set: {
        status: notificationOutboxStatusEnum.PROCESSING,
        leaseToken,
        leaseExpiresAt,
      },
      $inc: { attempts: 1 },
    },
    withSession(
      {
        new: true,
        sort: { nextAttemptAt: 1, createdAt: 1 },
        select: "+leaseToken",
      },
      session,
    ),
  );
}

function processingLeaseFilter({ outboxId, leaseToken }) {
  if (!outboxId) fail("outboxId is required");
  const normalizedLeaseToken = asTrimmedString(leaseToken, "leaseToken", {
    required: true,
    maxLength: 128,
  });
  return {
    _id: outboxId,
    status: notificationOutboxStatusEnum.PROCESSING,
    leaseToken: normalizedLeaseToken,
  };
}

export async function markNotificationOutboxSent({
  outboxId,
  leaseToken,
  now = new Date(),
  session,
  model = NotificationOutboxModel,
}) {
  return model.findOneAndUpdate(
    processingLeaseFilter({ outboxId, leaseToken }),
    {
      $set: {
        status: notificationOutboxStatusEnum.SENT,
        sentAt: new Date(now),
      },
      $unset: { leaseToken: 1, leaseExpiresAt: 1 },
    },
    withSession({ new: true }, session),
  );
}

export async function markNotificationOutboxRetryable({
  outboxId,
  leaseToken,
  error,
  retryDelayMs = 60_000,
  now = new Date(),
  session,
  model = NotificationOutboxModel,
}) {
  const retryAt = new Date(new Date(now).getTime() + numberWithin(retryDelayMs, 60_000, 0, MAX_RETRY_DELAY_MS));
  const sanitizedError = sanitizeDeliveryError(error);
  return model.findOneAndUpdate(
    processingLeaseFilter({ outboxId, leaseToken }),
    {
      $set: {
        status: notificationOutboxStatusEnum.RETRYABLE,
        nextAttemptAt: retryAt,
        lastErrorCode: sanitizedError.code,
        lastErrorMessage: sanitizedError.message,
      },
      $unset: { leaseToken: 1, leaseExpiresAt: 1 },
    },
    withSession({ new: true }, session),
  );
}

export async function markNotificationOutboxDeadLetter({
  outboxId,
  leaseToken,
  error,
  now = new Date(),
  session,
  model = NotificationOutboxModel,
}) {
  const sanitizedError = sanitizeDeliveryError(error);
  return model.findOneAndUpdate(
    processingLeaseFilter({ outboxId, leaseToken }),
    {
      $set: {
        status: notificationOutboxStatusEnum.DEAD_LETTER,
        deadLetteredAt: new Date(now),
        lastErrorCode: sanitizedError.code,
        lastErrorMessage: sanitizedError.message,
      },
      $unset: { leaseToken: 1, leaseExpiresAt: 1 },
    },
    withSession({ new: true }, session),
  );
}

export const notificationOutboxInternals = Object.freeze({
  SAFE_ACTION_PARAM_KEYS,
  sanitizeAction,
  sanitizeDeliveryError,
});
