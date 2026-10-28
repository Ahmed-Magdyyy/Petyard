import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getGuestCart,
  addOrUpdateGuestCartItem,
  updateGuestCartItemQuantity,
  removeGuestCartItem,
  clearGuestCart,
  setGuestCartAddress,
  getMyCart,
  addOrUpdateMyCartItem,
  updateMyCartItemQuantity,
  removeMyCartItem,
  clearMyCart,
  mergeGuestCartIntoMyCart,
  listCartsForAdmin,
  setMyCartAddress,
  addMyCartBundle,
  updateMyCartBundle,
  removeMyCartBundle,
  rebindMyBundleCart,
} from "./cart.controller.js";
import {
  warehouseIdParamValidator,
  cartItemIdParamValidator,
  upsertCartItemValidator,
  updateCartItemQuantityValidator,
  setUserCartAddressValidator,
  setGuestCartAddressValidator,
  upsertCartBundleValidator,
  cartBundleIdValidator,
  updateCartBundleValidator,
  emptyBundleCartBodyValidator,
} from "./cart.validators.js";

const router = Router();

router.get("/guest/:warehouseId", warehouseIdParamValidator, getGuestCart);

router.patch(
  "/guest/address",
  setGuestCartAddressValidator,
  setGuestCartAddress
);

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

router.post("/me/:warehouseId/bundles", warehouseIdParamValidator, upsertCartBundleValidator, addMyCartBundle);
router.patch("/me/:warehouseId/bundles/:groupId", warehouseIdParamValidator, cartBundleIdValidator, updateCartBundleValidator, updateMyCartBundle);
router.delete("/me/:warehouseId/bundles/:groupId", warehouseIdParamValidator, cartBundleIdValidator, emptyBundleCartBodyValidator, removeMyCartBundle);
router.post("/me/:warehouseId/rebind", warehouseIdParamValidator, emptyBundleCartBodyValidator, rebindMyBundleCart);

router.patch(
  "/me/address",
  setUserCartAddressValidator,
  setMyCartAddress
);

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
