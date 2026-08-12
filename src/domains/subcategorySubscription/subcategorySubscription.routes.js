import { Router } from "express";
import {
  allowedTo,
  enabledControls as enabledControlsMiddleware,
  protect,
  protectUserOrGuest,
} from '../auth/auth.middleware.js';
import { scopeProductsToModeratorWarehouses } from '../product/product.middleware.js';
import {
  enabledControls as enabledControlsEnum,
  roles,
} from '../../shared/constants/enums.js';
import {
  getAdminDemand,
  getAdminDemandSubscribers,
  getMySubcategorySubscriptions,
  getSubcategorySubscriptionStatus,
  subscribe,
  unsubscribe,
} from "./subcategorySubscription.controller.js";
import { subcategoryIdParamValidator } from "./subcategorySubscription.validators.js";
import {
  demandSubscribersQueryValidator,
  demandQueryValidator,
  warehouseIdBodyValidator,
  warehouseQueryValidator,
} from './subcategorySubscription.validators.js';

const router = Router();

router.get(
  '/admin/demand',
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.SUBCATEGORIES),
  scopeProductsToModeratorWarehouses,
  demandQueryValidator,
  getAdminDemand,
);
router.get(
  '/admin/demand/:subcategoryId/subscribers',
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.SUBCATEGORIES),
  scopeProductsToModeratorWarehouses,
  demandSubscribersQueryValidator,
  getAdminDemandSubscribers,
);

router.use(protectUserOrGuest);

// This must stay before /:subcategoryId so "me" is never parsed as an ID.
router.get("/me", getMySubcategorySubscriptions);
router.get(
  '/:subcategoryId',
  subcategoryIdParamValidator,
  warehouseQueryValidator,
  getSubcategorySubscriptionStatus,
);
router.post(
  '/:subcategoryId',
  subcategoryIdParamValidator,
  warehouseIdBodyValidator,
  subscribe,
);
router.delete(
  '/:subcategoryId',
  subcategoryIdParamValidator,
  warehouseQueryValidator,
  unsubscribe,
);

export default router;
