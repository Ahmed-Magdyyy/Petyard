import { Router } from "express";
import {
  allowedTo,
  enabledControls as enabledControlsMiddleware,
  protect,
  protectUserOrGuest,
} from "../auth/auth.middleware.js";
import {
  enabledControls as enabledControlsEnum,
  roles,
} from "../../shared/constants/enums.js";
import { scopeProductsToModeratorWarehouses } from "../product/product.middleware.js";
import {
  getRestockDemandSubscribers,
  getMyRestockSubscriptions,
  getRestockDemandSummary,
  getRestockSubscriptionStatus,
  subscribeToRestock,
  unsubscribeFromRestock,
} from "./restockSubscription.controller.js";
import {
  restockDemandSubscribersValidator,
  restockDemandSummaryValidator,
  restockSubscriptionStatusValidator,
  subscribeToRestockValidator,
  unsubscribeFromRestockValidator,
} from "./restockSubscription.validators.js";

const router = Router();

router.get(
  "/admin/demand",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  restockDemandSummaryValidator,
  getRestockDemandSummary,
);
router.get(
  "/admin/demand/:productId/subscribers",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  restockDemandSubscribersValidator,
  getRestockDemandSubscribers,
);

router.use(protectUserOrGuest);
router.post("/", subscribeToRestockValidator, subscribeToRestock);
// Keep the root GET as a compatibility alias for clients already calling it.
router.get("/", getMyRestockSubscriptions);
// This must stay before /:productId so "me" is never parsed as an ID.
router.get("/me", getMyRestockSubscriptions);
router.get("/:productId", restockSubscriptionStatusValidator, getRestockSubscriptionStatus);
router.delete("/:productId", unsubscribeFromRestockValidator, unsubscribeFromRestock);

export default router;
