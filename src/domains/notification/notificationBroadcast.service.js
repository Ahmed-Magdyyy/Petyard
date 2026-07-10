import { ApiError } from "../../shared/utils/ApiError.js";
import { parseBoolean } from "../../shared/utils/env.js";
import {
  dispatchBroadcastNotification,
  getBroadcastDeviceCount,
} from "./notificationDispatcher.js";
import {
  enqueueNotificationBroadcast,
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

  return new ApiError(
    "Notification broadcast service is unavailable. Please try again later.",
    503,
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
    const deviceCount = await getBroadcastDeviceCount();
    await enqueueNotificationBroadcast(payload);

    return {
      message: `Notifications sending to ${deviceCount} devices is in progress.`,
    };
  } catch (err) {
    console.error(
      "[Notification Broadcast] Failed to enqueue broadcast:",
      err?.message || err,
    );

    if (shouldUseInlineFallback()) {
      console.warn("[Notification Broadcast] Using inline fallback.");
      return dispatchBroadcastNotification(payload);
    }

    throw mapQueueError(err);
  }
}
