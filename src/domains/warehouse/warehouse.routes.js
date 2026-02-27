// src/domains/warehouse/warehouse.routes.js
import { Router } from "express";
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

router
  .route("/")
  .get(
    protect,
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
    enabledControlsMiddleware(enabledControlsEnum.WAREHOUSES),
    getWarehouses,
  )
  .post(createWarehouseValidator, createWarehouse);

router
  .route("/:id")
  .get(
    protect,
    allowedTo(
      roles.SUPER_ADMIN,
      roles.ADMIN,
      roles.MODERATOR,
      roles.USER,
      roles.GUEST,
    ),
    enabledControlsMiddleware(enabledControlsEnum.WAREHOUSES),
    warehouseIdParamValidator,
    getWarehouse,
  )
  .patch(
    protect,
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
    enabledControlsMiddleware(enabledControlsEnum.WAREHOUSES),
    updateWarehouseValidator,
    updateWarehouse,
  )
  .delete(
    protect,
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
    enabledControlsMiddleware(enabledControlsEnum.WAREHOUSES),
    warehouseIdParamValidator,
    deleteWarehouse,
  );

router.patch(
  "/:id/toggle-active",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.WAREHOUSES),
  warehouseIdParamValidator,
  toggleWarehouseActive,
);

export default router;
