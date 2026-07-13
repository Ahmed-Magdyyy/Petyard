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

function buildBroadcastAcceptedResponse(deviceCount) {
  return {
    message: `Notifications sending to ${deviceCount} devices is in progress.`,
  };
}

export async function dispatchAdminBroadcastNotification(payload) {
  const deviceCount = await getBroadcastDeviceCount();

  if (!isNotificationBroadcastQueueConfigured()) {
    if (shouldUseInlineFallback()) {
      console.warn(
        "[Notification Broadcast] BullMQ is not configured; using inline fallback.",
      );
      await dispatchBroadcastNotification(payload);
      return buildBroadcastAcceptedResponse(deviceCount);
    }

    throw new ApiError("Notification broadcast queue is not configured", 503);
  }

  try {
    await enqueueNotificationBroadcast(payload);
    return buildBroadcastAcceptedResponse(deviceCount);
  } catch (err) {
    console.error(
      "[Notification Broadcast] Failed to enqueue broadcast:",
      err?.message || err,
    );

    if (shouldUseInlineFallback()) {
      console.warn("[Notification Broadcast] Using inline fallback.");
      await dispatchBroadcastNotification(payload);
      return buildBroadcastAcceptedResponse(deviceCount);
    }

    throw mapQueueError(err);
  }
}
