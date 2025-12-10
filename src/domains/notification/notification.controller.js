import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/ApiError.js";
import {
  registerDeviceForUserService,
  sendAdminCustomNotificationToUsers,
  sendBroadcastNotificationToAllDevices,
} from "./notification.service.js";

export const registerDevice = asyncHandler(async (req, res) => {
  if (!req.user || !req.user._id) {
    throw new ApiError("Authentication required", 401);
  }

  const { token, platform, lang } = req.body || {};

  const device = await registerDeviceForUserService({
    userId: req.user._id,
    token,
    platform,
    lang,
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
