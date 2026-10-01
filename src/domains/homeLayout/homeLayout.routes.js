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
import { getPublishedLayout } from "../uiLayout/uiLayout.controller.js";
import { uiLayoutErrorHandler } from "../uiLayout/uiLayout.middleware.js";
import { publishedLayoutValidator } from "../uiLayout/uiLayout.validators.js";

const router = Router();

// Public — returns sections ordered by position (localized name, or all if admin)
router.get(
  "/",
  optionalProtect,
  (req, res, next) => process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED === "true"
    ? publishedLayoutValidator(req, res, next)
    : next(),
  (req, res, next) => process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED === "true"
    ? getPublishedLayout(req, res, next)
    : getHomeLayout(req, res, next),
);

// Admin routes

router.patch(
  "/",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControls.HOME_LAYOUT),
  updateHomeLayoutValidator,
  updateHomeLayout,
);

router.use(uiLayoutErrorHandler);

export default router;
