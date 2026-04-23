import { Router } from "express";
import {
  getStandaloneProfileBanner,
  createStandaloneProfileBanner,
  updateStandaloneProfileBanner,
} from "./standaloneProfileBanner.controller.js";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getStandaloneProfileBanner);

router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.BANNERS)
);

router.post(
  "/",
  uploadSingleImage("image"),
  createStandaloneProfileBanner
);

router.patch(
  "/",
  uploadSingleImage("image"),
  updateStandaloneProfileBanner
);

export default router;
