import { Router } from "express";
import {
  protect,
  protectAllowUnverifiedPhone,
  allowedTo,
} from "../auth/auth.middleware.js";
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
  getGuestNotifications,
  getGuestUnreadCount,
  markGuestNotificationAsRead,
  markAllGuestNotificationsAsRead,
  deleteGuestNotification,
} from "./notification.controller.js";
import {
  registerDeviceValidator,
  registerGuestDeviceValidator,
  adminSendNotificationValidator,
  notificationIdParamValidator,
  listNotificationsQueryValidator,
  guestNotificationHeaderValidator,
} from "./notification.validators.js";
import { guestLimiter } from "../../shared/middlewares/rateLimitMiddleware.js";

const router = Router();

// =====================
// Device Registration
// =====================

router.post(
  "/devices/register",
  protectAllowUnverifiedPhone,
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
// Guest In-App Notifications
// =====================

router.get(
  "/guest",
  guestLimiter,
  guestNotificationHeaderValidator,
  listNotificationsQueryValidator,
  getGuestNotifications,
);

router.get(
  "/guest/unread-count",
  guestLimiter,
  guestNotificationHeaderValidator,
  getGuestUnreadCount,
);

router.patch(
  "/guest/:id/read",
  guestLimiter,
  guestNotificationHeaderValidator,
  notificationIdParamValidator,
  markGuestNotificationAsRead,
);

router.patch(
  "/guest/read-all",
  guestLimiter,
  guestNotificationHeaderValidator,
  markAllGuestNotificationsAsRead,
);

router.delete(
  "/guest/:id",
  guestLimiter,
  guestNotificationHeaderValidator,
  notificationIdParamValidator,
  deleteGuestNotification,
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
