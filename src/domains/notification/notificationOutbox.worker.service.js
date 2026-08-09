import {
  claimNextNotificationOutbox,
  markNotificationOutboxDeadLetter,
  markNotificationOutboxRetryable,
  markNotificationOutboxSent,
} from "./notificationOutbox.service.js";
import { dispatchNotification } from "./notificationDispatcher.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function deliveryError(message, code = "DELIVERY_FAILED", permanent = false) {
  const error = new Error(message);
  error.code = code;
  error.permanent = permanent;
  return error;
}

function retryDelayMs(attempts, baseRetryDelayMs) {
  const base = boundedInteger(
    baseRetryDelayMs,
    DEFAULT_BASE_RETRY_DELAY_MS,
    1_000,
    MAX_RETRY_DELAY_MS,
  );
  return Math.min(MAX_RETRY_DELAY_MS, base * (2 ** Math.max(0, attempts - 1)));
}

function resultRequiresRetry(result) {
  if (!result || typeof result !== "object") return true;
  if (result.inApp?.success === false) return true;
  const push = result.push;
  if (push?.success === false) return true;
  return Boolean(
    push &&
      Number(push.deviceCount || 0) > 0 &&
      Number(push.failureCount || 0) > 0 &&
      Number(push.successCount || 0) === 0,
  );
}

function isPermanentFailure(error) {
  return Boolean(
    error?.permanent ||
      /^(?:UNSAFE_NOTIFICATION_PAYLOAD|VALIDATION_ERROR|RECIPIENT_INVALID)$/i.test(
        String(error?.code || ""),
      ),
  );
}

/** Deliver a previously claimed record. The outbox dedupe key is passed to
 * in-app storage, so retrying a failed push never creates a second record. */
export async function deliverClaimedNotificationOutbox({
  outbox,
  dispatch = dispatchNotification,
  markSent = markNotificationOutboxSent,
  markRetryable = markNotificationOutboxRetryable,
  markDeadLetter = markNotificationOutboxDeadLetter,
  now = new Date(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseRetryDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
}) {
  if (!outbox?._id || !outbox?.leaseToken) {
    throw deliveryError("Outbox must be claimed before delivery", "RECIPIENT_INVALID", true);
  }

  const completion = (operation) =>
    operation({
      outboxId: outbox._id,
      leaseToken: outbox.leaseToken,
      now,
    });

  try {
    const result = await dispatch({
      userId: outbox.recipientUser || undefined,
      guestId: outbox.recipientGuestId || undefined,
      notification: {
        title_en: outbox.title_en,
        title_ar: outbox.title_ar,
        body_en: outbox.body_en,
        body_ar: outbox.body_ar,
      },
      icon: outbox.icon,
      action: outbox.action,
      source: outbox.source,
      dedupeKey: outbox.dedupeKey,
      channels: { push: true, inApp: true },
    });

    if (resultRequiresRetry(result)) {
      throw deliveryError("Notification provider delivery failed", "PUSH_DELIVERY_FAILED");
    }

    await completion(markSent);
    return { status: "sent", result };
  } catch (error) {
    const attempts = Number(outbox.attempts || 0);
    if (isPermanentFailure(error) || attempts >= maxAttempts) {
      await completion((params) => markDeadLetter({ ...params, error }));
      return { status: "dead_letter", errorCode: error?.code || "DELIVERY_FAILED" };
    }

    await completion((params) =>
      markRetryable({
        ...params,
        error,
        retryDelayMs: retryDelayMs(attempts, baseRetryDelayMs),
      }),
    );
    return { status: "retryable", errorCode: error?.code || "DELIVERY_FAILED" };
  }
}

/** Claim and process a bounded batch. Claims are atomic and one record can
 * only be held by one lease token, even when multiple worker processes run. */
export async function drainNotificationOutbox({
  maxRecords = 25,
  concurrency = 3,
  claim = claimNextNotificationOutbox,
  deliver = deliverClaimedNotificationOutbox,
  claimOptions,
  deliveryOptions,
} = {}) {
  const limit = boundedInteger(maxRecords, 25, 1, 500);
  const workerConcurrency = boundedInteger(concurrency, 3, 1, 20);
  const summary = { claimed: 0, sent: 0, retryable: 0, dead_letter: 0 };

  let remaining = limit;
  while (remaining > 0) {
    const batchSize = Math.min(workerConcurrency, remaining);
    const claimed = (await Promise.all(
      Array.from({ length: batchSize }, () => claim(claimOptions)),
    )).filter(Boolean);
    if (!claimed.length) break;
    remaining -= claimed.length;
    summary.claimed += claimed.length;

    const results = await Promise.all(claimed.map((outbox) => deliver({ outbox, ...deliveryOptions })));
    for (const result of results) {
      if (result?.status && Object.hasOwn(summary, result.status)) summary[result.status] += 1;
    }
  }

  return summary;
}

export const notificationOutboxWorkerInternals = Object.freeze({
  retryDelayMs,
  resultRequiresRetry,
  isPermanentFailure,
});

