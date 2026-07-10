import { ApiError } from "../../shared/utils/ApiError.js";
import { parseBoolean } from "../../shared/utils/env.js";
import { dispatchBroadcastNotification } from "./notificationDispatcher.js";
import {
  enqueueNotificationBroadcastAndWait,
  isNotificationBroadcastQueueConfigured,
} from "./notificationBroadcast.queue.js";

function shouldUseInlineFallback() {
  return parseBoolean(
    process.env.NOTIFICATION_BROADCAST_INLINE_FALLBACK,
    process.env.NODE_ENV !== "production",
  );
}

function mapQueueError(err) {
  if (err instanceof ApiError) return err;

  const message = err?.message || "Notification broadcast queue failed";
  const isTimeout = /timed out|timeout/i.test(message);

  return new ApiError(
    isTimeout
      ? "Notification broadcast timed out. Please try again later."
      : "Notification broadcast service is unavailable. Please try again later.",
    isTimeout ? 504 : 503,
  );
}

export async function dispatchAdminBroadcastNotification(payload) {
  if (!isNotificationBroadcastQueueConfigured()) {
    if (shouldUseInlineFallback()) {
      console.warn(
        "[Notification Broadcast] BullMQ is not configured; using inline fallback.",
      );
      return dispatchBroadcastNotification(payload);
    }

    throw new ApiError("Notification broadcast queue is not configured", 503);
  }

  try {
    return await enqueueNotificationBroadcastAndWait(payload);
  } catch (err) {
    console.error(
      "[Notification Broadcast] Queued execution failed:",
      err?.message || err,
    );

    if (shouldUseInlineFallback()) {
      console.warn("[Notification Broadcast] Using inline fallback.");
      return dispatchBroadcastNotification(payload);
    }

    throw mapQueueError(err);
  }
}
