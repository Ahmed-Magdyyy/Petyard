import { Router } from "express";
import {
  getBrands,
  getBrand,
  createBrand,
  updateBrand,
  deleteBrand,
  updateBrandPositions,
} from "./brand.controller.js";
import {
  protect,
  optionalProtect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import {
  brandListQueryValidator,
  createBrandValidator,
  updateBrandValidator,
  brandIdParamValidator,
  updateBrandPositionsValidator,
} from "./brand.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", optionalProtect, brandListQueryValidator, getBrands);
router.get("/:id", optionalProtect, brandIdParamValidator, getBrand);

router.delete(
  "/:id",
  protect,
  allowedTo(roles.SUPER_ADMIN),
  brandIdParamValidator,
  deleteBrand
);

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
  "/positions",
  updateBrandPositionsValidator,
  updateBrandPositions
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateBrandValidator,
  updateBrand
);



export default router;
