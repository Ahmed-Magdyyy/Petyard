import { Router } from "express";
import {
  getBrands,
  getBrand,
  createBrand,
  updateBrand,
  deleteBrand,
} from "./brand.controller.js";
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
  createBrandValidator,
  updateBrandValidator,
  brandIdParamValidator,
} from "./brand.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getBrands);
router.get("/:id", brandIdParamValidator, getBrand);

// Admin-only routes
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.BRANDS)
);

router.post(
  "/",
  uploadSingleImage("image"),
  createBrandValidator,
  createBrand
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateBrandValidator,
  updateBrand
);

router.delete("/:id", brandIdParamValidator, deleteBrand);

export default router;
