import { Router } from "express";
import {
  getCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
} from "./coupon.controller.js";
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
  createCouponValidator,
  updateCouponValidator,
  couponIdParamValidator,
} from "./coupon.validators.js";

const router = Router();

router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.COUPONS)
);

router.get("/", getCoupons);
router.get("/:id", couponIdParamValidator, getCoupon);

router.post("/", createCouponValidator, createCoupon);

router.patch("/:id", updateCouponValidator, updateCoupon);

router.delete("/:id", couponIdParamValidator, deleteCoupon);

export default router;
