import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  registerDevice,
  registerGuestDevice,
  adminSendNotification,
  getMyNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} from "./notification.controller.js";
import {
  registerDeviceValidator,
  registerGuestDeviceValidator,
  adminSendNotificationValidator,
  notificationIdParamValidator,
  listNotificationsQueryValidator,
} from "./notification.validators.js";

const router = Router();

// =====================
// Device Registration
// =====================

router.post(
  "/devices/register",
  protect,
  registerDeviceValidator,
  registerDevice
);

router.post(
  "/devices/register-guest",
  registerGuestDeviceValidator,
  registerGuestDevice
);

// =====================
// User In-App Notifications
// =====================

router.get(
  "/me",
  protect,
  listNotificationsQueryValidator,
  getMyNotifications
);

router.get(
  "/me/unread-count",
  protect,
  getUnreadCount
);

router.patch(
  "/me/:id/read",
  protect,
  notificationIdParamValidator,
  markNotificationAsRead
);

router.patch(
  "/me/read-all",
  protect,
  markAllNotificationsAsRead
);

router.delete(
  "/me/:id",
  protect,
  notificationIdParamValidator,
  deleteNotification
);

// =====================
// Admin Send Notification
// =====================

router.post(
  "/admin/send",
  protect,
  allowedTo(roles.ADMIN, roles.SUPER_ADMIN),
  adminSendNotificationValidator,
  adminSendNotification
);

export default router;

