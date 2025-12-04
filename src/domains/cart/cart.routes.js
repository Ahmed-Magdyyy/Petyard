import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getGuestCart,
  addOrUpdateGuestCartItem,
  updateGuestCartItemQuantity,
  removeGuestCartItem,
  clearGuestCart,
  getMyCart,
  addOrUpdateMyCartItem,
  updateMyCartItemQuantity,
  removeMyCartItem,
  clearMyCart,
  mergeGuestCartIntoMyCart,
  listCartsForAdmin,
} from "./cart.controller.js";
import {
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  upsertCartItemValidator,
  updateCartItemQuantityValidator,
} from "./cart.validators.js";

const router = Router();

router.get("/guest/:warehouseId", warehouseIdParamValidator, getGuestCart);

router.post(
  "/guest/:warehouseId/items",
  warehouseIdParamValidator,
  upsertCartItemValidator,
  addOrUpdateGuestCartItem
);

router.patch(
  "/guest/:warehouseId/items/:itemId",
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  updateCartItemQuantityValidator,
  updateGuestCartItemQuantity
);

router.delete(
  "/guest/:warehouseId/items/:itemId",
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  removeGuestCartItem
);

router.delete(
  "/guest/:warehouseId",
  warehouseIdParamValidator,
  clearGuestCart
);

router.use(
  "/admin",
  protect,
  allowedTo(roles.ADMIN, roles.SUPER_ADMIN)
);

router.get("/admin", listCartsForAdmin);

router.use("/me", protect);

router.get("/me/:warehouseId", warehouseIdParamValidator, getMyCart);

router.post(
  "/me/:warehouseId/items",
  warehouseIdParamValidator,
  upsertCartItemValidator,
  addOrUpdateMyCartItem
);

router.patch(
  "/me/:warehouseId/items/:itemId",
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  updateCartItemQuantityValidator,
  updateMyCartItemQuantity
);

router.delete(
  "/me/:warehouseId/items/:itemId",
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  removeMyCartItem
);

router.delete("/me/:warehouseId", warehouseIdParamValidator, clearMyCart);

router.post(
  "/me/:warehouseId/merge",
  warehouseIdParamValidator,
  mergeGuestCartIntoMyCart
);

export default router;
