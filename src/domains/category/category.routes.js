import { Router } from "express";
import {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} from "./category.controller.js";
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
  createCategoryValidator,
  updateCategoryValidator,
  categoryIdParamValidator,
} from "./category.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";

const router = Router();

router.get("/", getCategories);
router.get("/:id", categoryIdParamValidator, getCategory);

// Admin-only routes
router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.CATEGORIES)
);

router.post(
  "/",
  uploadSingleImage("image"),
  createCategoryValidator,
  createCategory
);

router.patch(
  "/:id",
  uploadSingleImage("image"),
  updateCategoryValidator,
  updateCategory
);

router.delete("/:id", categoryIdParamValidator, deleteCategory);

export default router;
