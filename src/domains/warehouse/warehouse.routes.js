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
  createWarehouseValidator,
  updateWarehouseValidator,
  warehouseIdParamValidator,
} from "./warehouse.validators.js";

const router = Router();

// Admin-only routes for managing warehouses
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN)
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

router.patch(
  "/:id/toggle-active",
  warehouseIdParamValidator,
  toggleWarehouseActive
);

export default router;
