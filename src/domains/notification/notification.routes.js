import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  registerDevice,
  adminSendNotification,
  devSendTestPush,
} from "./notification.controller.js";
import {
  registerDeviceValidator,
  adminSendNotificationValidator,
  devSendTestPushValidator,
} from "./notification.validators.js";

const router = Router();

router.post(
  "/devices/register",
  protect,
  registerDeviceValidator,
  registerDevice
);

router.post(
  "/admin/send",
  protect,
  allowedTo(roles.ADMIN, roles.SUPER_ADMIN),
  adminSendNotificationValidator,
  adminSendNotification
);

router.post(
  "/admin/dev/send-test",
  protect,
  allowedTo(roles.ADMIN, roles.SUPER_ADMIN),
  devSendTestPushValidator,
  devSendTestPush
);

export default router;
