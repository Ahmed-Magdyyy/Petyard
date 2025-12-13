import { Router } from "express";
import {
  createOrderForGuest,
  createOrderForUser,
  getMyOrders,
  getMyOrder,
  listOrdersForAdmin,
  getOrderForAdmin,
  updateOrderStatusForAdmin,
} from "./order.controller.js";
import { scopeOrdersToModeratorWarehouses } from "./order.middleware.js";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
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

const router = Router();

// Guest checkout order
router.post("/guest", createOrderForGuestValidator, createOrderForGuest);

// Logged-in user orders
router.use("/me", protect);

router.post("/me", createOrderForUserValidator, createOrderForUser);
router.get("/me", getMyOrders);
router.get("/me/:id", orderIdParamValidator, getMyOrder);

// Admin orders
router.use(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.ORDERS),
  scopeOrdersToModeratorWarehouses
);

router.get("/admin", listOrdersForAdmin);
router.get("/admin/:id", orderIdParamValidator, getOrderForAdmin);
router.patch(
  "/admin/:id/status",
  orderIdParamValidator,
  updateOrderStatusValidator,
  updateOrderStatusForAdmin
);

export default router;
