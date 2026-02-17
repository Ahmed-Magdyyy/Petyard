import { Router } from "express";
import {
  protect,
  allowedTo,
  enabledControls,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnums,
} from "../../shared/constants/enums.js";
import {
  getOrdersOverview,
  getTopProducts,
  getServicesOverview,
  getStats,
  getSalesChart,
} from "./analytics.controller.js";
import {
  ordersOverviewValidator,
  topProductsValidator,
  servicesOverviewValidator,
  statsValidator,
  salesChartValidator,
} from "./analytics.validator.js";

const router = Router();

// All analytics routes require admin or superAdmin
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControls(enabledControlsEnums.ANALYTICS),
);

// ─── Order analytics (filters by warehouse) ─────────────────────────────────
router.get("/orders", ordersOverviewValidator, getOrdersOverview);
router.get("/orders/top-products", topProductsValidator, getTopProducts);

// ─── Service analytics (filters by location) ────────────────────────────────
router.get("/services", servicesOverviewValidator, getServicesOverview);

// ─── Global stats ────────────────────────────────────────────────────────────
router.get("/stats", statsValidator, getStats);

// ─── Combined sales chart ────────────────────────────────────────────────────
router.get("/sales-chart", salesChartValidator, getSalesChart);

export default router;
