import { Router } from "express";
import { getHomeLayout, updateHomeLayout } from "./homeLayout.controller.js";
import {
  protect,
  allowedTo,
  optionalProtect,
  enabledControls as enabledControlsMiddleware,
} from "../auth/auth.middleware.js";
import { roles, enabledControls } from "../../shared/constants/enums.js";
import { updateHomeLayoutValidator } from "./homeLayout.validators.js";

const router = Router();

// Public — returns sections ordered by position (localized name, or all if admin)
router.get("/", optionalProtect, getHomeLayout);

// Admin routes

router.patch(
  "/",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControls.HOME_LAYOUT),
  updateHomeLayoutValidator,
  updateHomeLayout,
);

export default router;
