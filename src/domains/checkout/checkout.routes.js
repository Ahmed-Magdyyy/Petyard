import { Router } from "express";
import { protect } from "../auth/auth.middleware.js";
import { applyCouponValidator } from "./checkout.validators.js";
import {
  applyCouponForGuest,
  applyCouponForUser,
  getCheckoutSummaryForGuest,
  getCheckoutSummaryForUser,
} from "./checkout.controller.js";

const router = Router();

router.post(
  "/guest/apply-coupon",
  applyCouponValidator,
  applyCouponForGuest
);

router.get("/guest/summary", getCheckoutSummaryForGuest);

router.post(
  "/me/apply-coupon",
  protect,
  applyCouponValidator,
  applyCouponForUser
);

router.get("/me/summary", protect, getCheckoutSummaryForUser);

export default router;
