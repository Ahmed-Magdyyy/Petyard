import { Router } from "express";
import { protectUserOrGuest } from "../auth/auth.middleware.js";
import {
  getMySubcategorySubscriptions,
  getSubcategorySubscriptionStatus,
  subscribe,
  unsubscribe,
} from "./subcategorySubscription.controller.js";
import { subcategoryIdParamValidator } from "./subcategorySubscription.validators.js";

const router = Router();

router.use(protectUserOrGuest);

// This must stay before /:subcategoryId so "me" is never parsed as an ID.
router.get("/me", getMySubcategorySubscriptions);
router.get("/:subcategoryId", subcategoryIdParamValidator, getSubcategorySubscriptionStatus);
router.post("/:subcategoryId", subcategoryIdParamValidator, subscribe);
router.delete("/:subcategoryId", subcategoryIdParamValidator, unsubscribe);

export default router;
