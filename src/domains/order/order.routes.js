import { Router } from "express";
import {
  createOrderForGuest,
  createOrderForUser,
  getMyOrders,
  getMyOrder,
  getGuestOrders,
  getGuestOrder,
  listOrdersForAdmin,
  getOrderForAdmin,
  updateOrderStatusForAdmin,
  reorderForUser,
  reorderForGuest,
} from "./order.controller.js";
import { scopeOrdersToModeratorWarehouses } from "./order.middleware.js";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
  requireSystemPhoneVerifiedForSensitiveActions,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import {
  createOrderForGuestValidator,
  createOrderForUserValidator,
  orderIdParamValidator,
  updateOrderStatusValidator,
} from "./order.validators.js";
import {
  guestLimiter,
  paymentLimiter,
} from "../../shared/middlewares/rateLimitMiddleware.js";

const router = Router();

// Guest checkout order (rate-limited)
router.post("/guest", guestLimiter, paymentLimiter, createOrderForGuestValidator, createOrderForGuest);
router.get("/guest", guestLimiter, getGuestOrders);
router.get("/guest/:id", guestLimiter, orderIdParamValidator, getGuestOrder);
router.post("/guest/:id/reorder", guestLimiter, orderIdParamValidator, reorderForGuest);

// Logged-in user orders
router.use("/me", protect);

router.post(
  "/me",
  paymentLimiter,
  requireSystemPhoneVerifiedForSensitiveActions,
  createOrderForUserValidator,
  createOrderForUser,
);
router.get("/me", getMyOrders);
router.get("/me/:id", orderIdParamValidator, getMyOrder);
router.post("/me/:id/reorder", orderIdParamValidator, reorderForUser);

// Admin orders
router.use(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.ORDERS),
  scopeOrdersToModeratorWarehouses,
);

router.get("/admin", listOrdersForAdmin);
router.get("/admin/:id", orderIdParamValidator, getOrderForAdmin);
router.patch(
  "/admin/:id/status",
  orderIdParamValidator,
  updateOrderStatusValidator,
  updateOrderStatusForAdmin,
);

export default router;
