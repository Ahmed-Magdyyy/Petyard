// src/domains/zone/zone.routes.js
import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getZones,
  getZone,
  createZone,
  updateZone,
  toggleZoneActive,
  deleteZone,
} from "./zone.controller.js";
import { createZoneValidator, updateZoneValidator, zoneIdParamValidator } from "./zone.validators.js";

const router = Router();

// Public list for dropdowns / location selection (can be filtered via query)
router.get("/", getZones);

// Admin-only routes
router.use(protect, allowedTo(roles.SUPER_ADMIN));

router.post("/", createZoneValidator, createZone);
router.get("/:id", zoneIdParamValidator, getZone);
router.patch("/:id", updateZoneValidator, updateZone);
router.patch("/:id/toggle-active", zoneIdParamValidator, toggleZoneActive);
router.delete("/:id", zoneIdParamValidator, deleteZone);

export default router;
