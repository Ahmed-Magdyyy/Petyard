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
  optionalProtect,
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

// ─── User / Guest Routes (same endpoints) ───────────────────────────────────
// If Bearer token → authenticated user.
// If no token but guestId in query → guest.
// If neither → 401.

router.post(
  "/orders/:orderId/return",
  optionalProtect,
  createReturnRequestValidator,
  createReturnRequest,
);

router.get(
  "/me",
  optionalProtect,
  listReturnRequestsValidator,
  getMyReturnRequests,
);

router.get(
  "/me/:returnId",
  optionalProtect,
  getReturnRequestValidator,
  getMyReturnRequest,
);

// ─── Admin Routes ───────────────────────────────────────────────────────────

router.get(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  listReturnRequestsValidator,
  listReturnRequestsForAdmin,
);

router.get(
  "/admin/:returnId",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  getReturnRequestValidator,
  getReturnRequestForAdmin,
);

router.patch(
  "/admin/:returnId/status",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware([enabledControlsEnum.ORDERS]),
  processReturnRequestValidator,
  processReturnRequest,
);

export default router;
