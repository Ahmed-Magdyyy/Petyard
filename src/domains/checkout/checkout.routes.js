import { Router } from "express";
import {
  protect,
  requireSystemPhoneVerifiedForSensitiveActions,
} from "../auth/auth.middleware.js";
import {
  getCheckoutSummaryForGuest,
  getCheckoutSummaryForUser,
} from "./checkout.controller.js";
import { guestLimiter } from "../../shared/middlewares/rateLimitMiddleware.js";
import { checkoutSummaryValidator } from "./checkout.validators.js";

const router = Router();

router.get("/guest/summary", guestLimiter, getCheckoutSummaryForGuest);

router.get(
  "/me/summary",
  protect,
  requireSystemPhoneVerifiedForSensitiveActions,
  checkoutSummaryValidator,
  getCheckoutSummaryForUser
);

export default router;
