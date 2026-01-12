import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  registerDeviceForUserService,
  registerDeviceForGuestService,
} from "./notification.service.js";
import {
  getMyNotificationsService,
  getUnreadCountService,
  markNotificationAsReadService,
  markAllNotificationsAsReadService,
  deleteNotificationService,
} from "./inAppNotification.service.js";
import {
  dispatchNotificationToUsers,
  dispatchBroadcastNotification,
} from "./notificationDispatcher.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

// =====================
// Device Registration
// =====================

export const registerDevice = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { token, platform, lang } = req.body || {};

  const device = await registerDeviceForUserService({
    userId: req.user._id,
    token,
    platform,
    lang: lang || "en",
  });

  res.status(200).json({ data: device });
});

export const registerGuestDevice = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { token, platform, lang } = req.body || {};

  const device = await registerDeviceForGuestService({
    guestId,
    token,
    platform,
    lang: lang || "en",
  });

  res.status(200).json({ data: device });
});

// =====================
// User In-App Notifications
// =====================

export const getMyNotifications = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { page = 1, limit = 20, isRead } = req.query;

  const result = await getMyNotificationsService({
    userId: req.user._id,
    lang: req.lang,
    page: parseInt(page, 10) || 1,
    limit: Math.min(parseInt(limit, 10) || 20, 50),
    isRead,
  });

  res.status(200).json(result);
});

export const getUnreadCount = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const result = await getUnreadCountService(req.user._id);

  res.status(200).json({ data: result });
});

export const markNotificationAsRead = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { id } = req.params;

  const result = await markNotificationAsReadService({
    userId: req.user._id,
    notificationId: id,
  });

  if (!result.success) {
    throw new ApiError("Notification not found", 404);
  }

  res.status(200).json({ data: { message: "Marked as read" } });
});

export const markAllNotificationsAsRead = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const result = await markAllNotificationsAsReadService(req.user._id);

  res.status(200).json({ data: result });
});

export const deleteNotification = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { id } = req.params;

  const result = await deleteNotificationService({
    userId: req.user._id,
    notificationId: id,
  });

  if (!result.deleted) {
    throw new ApiError("Notification not found", 404);
  }

  res.status(200).json({ data: { message: "Deleted" } });
});

// =====================
// Admin Notification Send
// =====================

export const adminSendNotification = asyncHandler(async (req, res) => {
  const { target, notification, icon, action, channels } = req.body || {};

  const targetType = target && target.type;

  // Default channels: both push and inApp
  const effectiveChannels = {
    push: channels?.push !== false,
    inApp: channels?.inApp !== false,
  };

  // Build source for tracking
  const source = {
    domain: "admin",
    event: "custom",
  };

  if (targetType === "users") {
    const userIds = Array.isArray(target.userIds) ? target.userIds : [];

    if (!userIds.length) {
      throw new ApiError("target.userIds must be a non-empty array", 400);
    }

    const result = await dispatchNotificationToUsers({
      userIds,
      notification: {
        title_en: notification?.title_en || notification?.title || "",
        title_ar: notification?.title_ar,
        body_en: notification?.body_en || notification?.body || "",
        body_ar: notification?.body_ar,
      },
      icon: icon || "promo",
      action,
      source,
      channels: effectiveChannels,
    });

    res.status(200).json({ data: result });
    return;
  }

  if (targetType === "all_users" || targetType === "all_devices") {
    const result = await dispatchBroadcastNotification({
      notification: {
        title_en: notification?.title_en || notification?.title || "",
        title_ar: notification?.title_ar,
        body_en: notification?.body_en || notification?.body || "",
        body_ar: notification?.body_ar,
      },
      icon: icon || "promo",
      action,
      source,
      channels: effectiveChannels,
    });

    res.status(200).json({ data: result });
    return;
  }

  throw new ApiError("Invalid target.type. Use 'users', 'all_users', or 'all_devices'", 400);
});

