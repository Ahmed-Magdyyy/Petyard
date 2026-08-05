import { Router } from "express";
import { protectUserOrGuest } from "../auth/auth.middleware.js";
import {
  getMyRestockSubscriptions,
  getRestockSubscriptionStatus,
  subscribeToRestock,
  unsubscribeFromRestock,
} from "./restockSubscription.controller.js";
import {
  restockSubscriptionStatusValidator,
  subscribeToRestockValidator,
  unsubscribeFromRestockValidator,
} from "./restockSubscription.validators.js";

const router = Router();

router.use(protectUserOrGuest);
router.post("/", subscribeToRestockValidator, subscribeToRestock);
// Keep the root GET as a compatibility alias for clients already calling it.
router.get("/", getMyRestockSubscriptions);
// This must stay before /:productId so "me" is never parsed as an ID.
router.get("/me", getMyRestockSubscriptions);
router.get("/:productId", restockSubscriptionStatusValidator, getRestockSubscriptionStatus);
router.delete("/:productId", unsubscribeFromRestockValidator, unsubscribeFromRestock);

export default router;
