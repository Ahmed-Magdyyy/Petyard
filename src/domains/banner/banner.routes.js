import { Router } from "express";
import {
  getActiveBanners,
  getAllBanners,
  createBanner,
  updateBanner,
  deleteBanner,
} from "./banner.controller.js";
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
  createBannerValidator,
  updateBannerValidator,
  bannerIdParamValidator,
} from "./banner.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getActiveBanners);

router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.BANNERS)
);

router.get("/admin", getAllBanners);

router.post(
  "/",
  uploadSingleImage("image"),
  createBannerValidator,
  createBanner
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateBannerValidator,
  updateBanner
);

router.delete("/:id", bannerIdParamValidator, deleteBanner);

export default router;
