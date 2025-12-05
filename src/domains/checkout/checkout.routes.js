import { Router } from "express";
import { protect } from "../auth/auth.middleware.js";
import { warehouseIdParamValidator } from "../cart/cart.validators.js";
import { applyCouponValidator } from "./checkout.validators.js";
import {
  applyCouponForGuest,
  applyCouponForUser,
} from "./checkout.controller.js";

const router = Router();

router.post(
  "/guest/:warehouseId/apply-coupon",
  warehouseIdParamValidator,
  applyCouponValidator,
  applyCouponForGuest
);

router.post(
  "/me/:warehouseId/apply-coupon",
  protect,
  warehouseIdParamValidator,
  applyCouponValidator,
  applyCouponForUser
);

export default router;
