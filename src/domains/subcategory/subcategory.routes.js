import { Router } from "express";
import {
  getSubcategories,
  getSubcategory,
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
} from "./subcategory.controller.js";
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
  createSubcategoryValidator,
  updateSubcategoryValidator,
  subcategoryIdParamValidator,
} from "./subcategory.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getSubcategories);
router.get("/:id", subcategoryIdParamValidator, getSubcategory);

// Admin-only routes
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.SUBCATEGORIES)
);

router.post(
  "/",
  uploadSingleImage("image"),
  createSubcategoryValidator,
  createSubcategory
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateSubcategoryValidator,
  updateSubcategory
);

router.delete("/:id", subcategoryIdParamValidator, deleteSubcategory);

export default router;
