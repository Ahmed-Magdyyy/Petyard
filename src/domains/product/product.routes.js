import { Router } from "express";
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from "./product.controller.js";
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
  createProductValidator,
  updateProductValidator,
  productIdParamValidator,
  listProductsQueryValidator,
} from "./product.validators.js";
import { uploadMultipleImages } from "../../shared/middlewares/uploadMiddleware.js";
import reviewRoutes from "../review/review.routes.js";

const router = Router();

router.get("/", listProductsQueryValidator, getProducts);
router.get("/:id", productIdParamValidator, getProduct);

router.use("/:id/reviews", reviewRoutes);

router.use(
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS)
);

router.post(
  "/",
  uploadMultipleImages("images", 10),
  createProductValidator,
  createProduct
);

router.patch(
  "/:id",
  uploadMultipleImages("images", 10),
  updateProductValidator,
  updateProduct
);

router.delete("/:id", productIdParamValidator, deleteProduct);

export default router;
