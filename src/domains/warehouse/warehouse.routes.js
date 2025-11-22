// src/domains/warehouse/warehouse.routes.js
import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  toggleWarehouseActive,
  deleteWarehouse,
} from "./warehouse.controller.js";
import {
  generateWarehouseGrid,
  getWarehouseZonesGrid,
  updateWarehouseZonesGrid,
} from "../zone/zone.controller.js";
import {
  createWarehouseValidator,
  updateWarehouseValidator,
  warehouseIdParamValidator,
  generateWarehouseGridValidator,
  updateWarehouseZonesGridValidator,
} from "./warehouse.validators.js";

const router = Router();

// Admin-only routes for managing warehouses
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN)
);

router
  .route("/")
  .get(getWarehouses)
  .post(createWarehouseValidator, createWarehouse);

router
  .route("/:id")
  .get(warehouseIdParamValidator, getWarehouse)
  .patch(updateWarehouseValidator, updateWarehouse)
  .delete(warehouseIdParamValidator, deleteWarehouse);

router.post(
  "/:id/zones-grid/generate",
  generateWarehouseGridValidator,
  generateWarehouseGrid
);

router.get(
  "/:id/zones-grid",
  warehouseIdParamValidator,
  getWarehouseZonesGrid
);

router.put(
  "/:id/zones-grid",
  updateWarehouseZonesGridValidator,
  updateWarehouseZonesGrid
);

router.patch(
  "/:id/toggle-active",
  warehouseIdParamValidator,
  toggleWarehouseActive
);

export default router;
