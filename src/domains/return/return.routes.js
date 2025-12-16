import { Router } from "express";
import {
  createReturnRequest,
  getMyReturnRequests,
  getMyReturnRequest,
  listReturnRequestsForAdmin,
  getReturnRequestForAdmin,
  processReturnRequest,
} from "./return.controller.js";
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
  createReturnRequestValidator,
  getReturnRequestValidator,
  listReturnRequestsValidator,
  processReturnRequestValidator,
} from "./return.validators.js";

const router = Router();

router.post(
  "/orders/:orderId/return",
  protect,
  // allowedTo(roles.USER),
  createReturnRequestValidator,
  createReturnRequest
);

router.get(
  "/me",
  protect,
  // allowedTo(roles.USER),
  listReturnRequestsValidator,
  getMyReturnRequests
);

router.get(
  "/me/:returnId",
  protect,
  // allowedTo(roles.USER),
  getReturnRequestValidator,
  getMyReturnRequest
);

router.get(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  listReturnRequestsValidator,
  listReturnRequestsForAdmin
);

router.get(
  "/admin/:returnId",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  getReturnRequestValidator,
  getReturnRequestForAdmin
);

router.patch(
  "/admin/:returnId/status",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  processReturnRequestValidator,
  processReturnRequest
);

export default router;
