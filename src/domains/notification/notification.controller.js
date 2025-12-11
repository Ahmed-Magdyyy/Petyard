import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/ApiError.js";
import {
  registerDeviceForUserService,
  registerDeviceForGuestService,
  sendAdminCustomNotificationToUsers,
  sendBroadcastNotificationToAllDevices,
} from "./notification.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

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

export const adminSendNotification = asyncHandler(async (req, res) => {
  const { target, notification, data } = req.body || {};

  const targetType = target && target.type;

  if (targetType === "users") {
    const userIds = Array.isArray(target.userIds) ? target.userIds : [];

    if (!userIds.length) {
      throw new ApiError("target.userIds must be a non-empty array", 400);
    }

    const result = await sendAdminCustomNotificationToUsers({
      userIds,
      notification,
      data,
    });

    res.status(200).json({ data: result });
    return;
  }

  if (targetType === "all_devices") {
    const result = await sendBroadcastNotificationToAllDevices({
      notification,
      data,
    });

    res.status(200).json({ data: result });
    return;
  }

  throw new ApiError("Invalid target.type", 400);
});
