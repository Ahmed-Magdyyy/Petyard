import { Router } from "express";

import {
  getProducts,
  getProductsForAdmin,
  getProduct,
  createProduct,
  updateProduct,
  updateProductStock,
  deleteProduct,
  searchProducts,
  searchProductsForAdmin,
  commitProductSearch,
  getProductSearchHistory,
  removeProductSearchHistoryTerm,
  getPopularProductSearches,
} from "./product.controller.js";

import {
  protect,
  protectUserOrGuest,
  optionalProtect,
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
  updateProductStockValidator,
  productIdParamValidator,
  listProductsQueryValidator,
  searchProductsQueryValidator,
  adminSearchProductsQueryValidator,
  commitProductSearchValidator,
  removeProductSearchHistoryTermValidator,
  popularProductSearchesQueryValidator,
} from "./product.validators.js";

import { uploadMultipleImages } from "../../shared/middlewares/uploadMiddleware.js";

import {
  scopeProductsToModeratorWarehouses,
  restrictModeratorProductUpdate,
} from "./product.middleware.js";

import reviewRoutes from "../review/review.routes.js";

const router = Router();

// ─── Public routes ───────────────────────────────────────────────────────────

router.get("/", optionalProtect, listProductsQueryValidator, getProducts);

// ─── Admin listing — admins + moderators ─────────────────────────────────────
// Must be before /:id to avoid Express treating "admin" as a product ID

router.get(
  "/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  listProductsQueryValidator,
  getProductsForAdmin,
);

// Must be before /:id to avoid Express treating "search" as a product ID
router.get(
  "/search",
  optionalProtect,
  searchProductsQueryValidator,
  searchProducts,
);

router.get(
  "/search/admin",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  adminSearchProductsQueryValidator,
  searchProductsForAdmin,
);

// These routes intentionally sit apart from GET /search: live typeahead is
// read-only, while history is only written after an explicit committed search.
router.post(
  "/search/history",
  protectUserOrGuest,
  commitProductSearchValidator,
  commitProductSearch,
);

router.get("/search/history", protectUserOrGuest, getProductSearchHistory);

router.delete(
  "/search/history",
  protectUserOrGuest,
  removeProductSearchHistoryTermValidator,
  removeProductSearchHistoryTerm,
);

router.get(
  "/search/popular",
  popularProductSearchesQueryValidator,
  getPopularProductSearches,
);

router.get("/:id", optionalProtect, productIdParamValidator, getProduct);

router.use("/:id/reviews", reviewRoutes);

// ─── Create product — admins only ────────────────────────────────────────────

router.post(
  "/",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  uploadMultipleImages("images", 10),
  createProductValidator,
  createProduct,
);

// ─── Stock-only update (merge) — admins + moderators ─────────────────────────
// FE should use this for stock adjustments. Only touches the specific
// warehouse entries sent; all other variants/warehouses stay intact.

router.patch(
  "/:id/stock",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  updateProductStockValidator,
  updateProductStock,
);

// ─── Full product update — admins + moderators (moderators restricted to stock)

router.patch(
  "/:id",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR),
  enabledControlsMiddleware(enabledControlsEnum.PRODUCTS),
  scopeProductsToModeratorWarehouses,
  uploadMultipleImages("images", 5),
  restrictModeratorProductUpdate,
  updateProductValidator,
  updateProduct,
);

router.delete(
  "/:id",
  protect,
  allowedTo(roles.SUPER_ADMIN),
  productIdParamValidator,
  deleteProduct,
);

export default router;
