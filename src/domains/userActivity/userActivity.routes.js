// src/domains/userActivity/userActivity.routes.js
import { Router } from "express";
import { getUserActivity, getProductOrderHistory } from "./userActivity.controller.js";
import { getUserActivityValidator, getProductOrderHistoryValidator } from "./userActivity.validators.js";

// This router is mounted with mergeParams so it receives :id from the parent
const router = Router({ mergeParams: true });

router.get("/", getUserActivityValidator, getUserActivity);

export default router;

// Standalone product order-history router (mounted separately)
export const productOrderHistoryRouter = Router();

productOrderHistoryRouter.get(
  "/:productId/order-history",
  getProductOrderHistoryValidator,
  getProductOrderHistory,
);
