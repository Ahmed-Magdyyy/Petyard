import {
  claimNextNotificationOutbox,
  markNotificationOutboxDeadLetter,
  markNotificationOutboxRetryable,
  markNotificationOutboxSent,
} from "./notificationOutbox.service.js";
import { dispatchNotification } from "./notificationDispatcher.js";
import { UserModel } from "../user/user.model.js";
import { OrderModel } from "../order/order.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { accountStatus, enabledControls, roles } from "../../shared/constants/enums.js";
import { buildStaffAlertPushOptions } from "./notificationPushOptions.js";
import { assistantReviewAlertIsCurrent, isAssistantReviewNotification } from "../assistant/review/assistant.notifications.js";
import mongoose from "mongoose";

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

const isAssistantBookingAlert = source => source?.domain === "assistant" && source?.event === "booking_created";
function isKnownStaffAlert(source) {
  return isAssistantReviewNotification(source) || isAssistantBookingAlert(source) || (source?.domain === "videos" && source?.event === "youtube_player_error") ||
    (source?.domain === "order" && source?.event === "new_order_placed");
}

function invalidRecipient() {
  return deliveryError("Notification recipient is no longer eligible", "RECIPIENT_INVALID", true);
}

async function requireCurrentStaffRecipient(outbox, { userModel, orderModel, warehouseModel }) {
  const source = outbox.source;
  if (!isKnownStaffAlert(source)) return;
  if (!outbox.recipientUser) throw invalidRecipient();

  const user = await userModel.findById(outbox.recipientUser)
    .select("_id role active deletedAt account_status enabledControls phoneVerified").lean();
  if (!user || user.active !== true || user.deletedAt ||
    [accountStatus.BANNED, accountStatus.DELETED].includes(user.account_status)) {
    throw invalidRecipient();
  }

  if (isAssistantReviewNotification(source)) {
    if (user.role !== roles.SUPER_ADMIN || user.phoneVerified !== true) throw invalidRecipient();
    return;
  }
  if (user.role === roles.SUPER_ADMIN) return;
  if (user.role === roles.ADMIN && (
    (source.domain === "videos" && user.enabledControls?.includes(enabledControls.VIDEOS)) ||
    (source.domain === "order" && user.enabledControls?.includes(enabledControls.ORDERS))
    || (isAssistantBookingAlert(source) && user.enabledControls?.includes(enabledControls.SERVICE_RESERVATIONS))
  )) return;

  if (source.domain === "order" && user.role === roles.MODERATOR && source.referenceId) {
    const order = await orderModel.findById(source.referenceId).select("warehouse").lean();
    if (order?.warehouse) {
      const warehouse = await warehouseModel.findById(order.warehouse).select("moderators").lean();
      if (warehouse?.moderators?.some((id) => String(id) === String(user._id))) return;
    }
  }

  throw invalidRecipient();
}

/** Deliver a previously claimed record. The outbox dedupe key is passed to
 * in-app storage, so retrying a failed push never creates a second record. */
export async function deliverClaimedNotificationOutbox({
  outbox,
  dispatch = dispatchNotification,
  markSent = markNotificationOutboxSent,
  markRetryable = markNotificationOutboxRetryable,
  markDeadLetter = markNotificationOutboxDeadLetter,
  userModel = UserModel,
  orderModel = OrderModel,
  warehouseModel = WarehouseModel,
  reservationModel,
  now = new Date(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseRetryDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
  validateAssistantReview = assistantReviewAlertIsCurrent,
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
    await requireCurrentStaffRecipient(outbox, { userModel, orderModel, warehouseModel });
    if (isAssistantReviewNotification(outbox.source) && !await validateAssistantReview(outbox)) throw invalidRecipient();
    if (isAssistantBookingAlert(outbox.source)) {
      if (!/^[a-f\d]{24}$/i.test(outbox.source.referenceId ?? "") || outbox.action?.params?.reservationId !== outbox.source.referenceId) throw invalidRecipient();
      // Read without registering the ordinary booking model and triggering automatic schema setup in this worker.
      const reservation = reservationModel
        ? await reservationModel.findById(outbox.source.referenceId).select("status").maxTimeMS(5000).lean()
        : await mongoose.connection.db.collection("servicereservations").findOne(
          { _id: new mongoose.Types.ObjectId(outbox.source.referenceId) }, { projection: { status: 1 }, maxTimeMS: 5000 });
      if (!reservation || !["BOOKED", "IN_PROGRESS"].includes(reservation.status)) throw deliveryError("Booking alert is no longer current", "EVENT_STALE", true);
    }
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
      ...((outbox.source?.domain === "order" && outbox.source?.event === "new_order_placed") || isAssistantBookingAlert(outbox.source)
        ? { pushOptions: buildStaffAlertPushOptions() }
        : {}),
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

