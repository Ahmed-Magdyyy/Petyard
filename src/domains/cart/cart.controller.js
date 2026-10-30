import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  getCartService,
  upsertCartItemService,
  updateCartItemQuantityService,
  removeCartItemService,
  clearCartService,
  mergeGuestCartService,
  listCartsForAdminService,
  setCartAddressFromUserService,
  setCartAddressForGuestService,
  upsertCartBundleService,
  updateCartBundleService,
  removeCartBundleService,
  rebindCartWithBundlesService,
} from "./cart.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const getGuestCart = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const warehouseId = req.params.warehouseId;

  const cart = await getCartService({
    userId: null,
    guestId,
    warehouseId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const addOrUpdateGuestCartItem = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const warehouseId = req.params.warehouseId;
  const { productId, productType, variantId, quantity } = req.body;

  const cart = await upsertCartItemService({
    userId: null,
    guestId,
    warehouseId,
    productId,
    productType,
    variantId,
    quantity,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const updateGuestCartItemQuantity = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const warehouseId = req.params.warehouseId;
  const itemId = req.params.itemId;
  const { quantity } = req.body;

  const cart = await updateCartItemQuantityService({
    userId: null,
    guestId,
    warehouseId,
    itemId,
    quantity,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const removeGuestCartItem = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const warehouseId = req.params.warehouseId;
  const itemId = req.params.itemId;

  const cart = await removeCartItemService({
    userId: null,
    guestId,
    warehouseId,
    itemId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const clearGuestCart = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const warehouseId = req.params.warehouseId;

  await clearCartService({
    userId: null,
    guestId,
    warehouseId,
  });

  res.status(200).json({});
});

export const setGuestCartAddress = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { guestAddressId, warehouseId } = req.body;

  const cart = await setCartAddressForGuestService({
    guestId,
    guestAddressId,
    warehouseId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const listCartsForAdmin = asyncHandler(async (req, res) => {
  const result = await listCartsForAdminService(req.query);
  res.status(200).json(result);
});

export const mergeGuestCartIntoMyCart = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  const warehouseId = req.params.warehouseId;

  const cart = await mergeGuestCartService({
    userId: req.user._id,
    guestId,
    warehouseId,
  });

  res.status(200).json({ data: cart });
});

export const getMyCart = asyncHandler(async (req, res) => {
  const warehouseId = req.params.warehouseId;

  const cart = await getCartService({
    userId: req.user._id,
    guestId: null,
    warehouseId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const addOrUpdateMyCartItem = asyncHandler(async (req, res) => {
  const warehouseId = req.params.warehouseId;
  const { productId, productType, variantId, quantity } = req.body;

  const cart = await upsertCartItemService({
    userId: req.user._id,
    guestId: null,
    warehouseId,
    productId,
    productType,
    variantId,
    quantity,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const updateMyCartItemQuantity = asyncHandler(async (req, res) => {
  const warehouseId = req.params.warehouseId;
  const itemId = req.params.itemId;
  const { quantity } = req.body;

  const cart = await updateCartItemQuantityService({
    userId: req.user._id,
    guestId: null,
    warehouseId,
    itemId,
    quantity,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const removeMyCartItem = asyncHandler(async (req, res) => {
  const warehouseId = req.params.warehouseId;
  const itemId = req.params.itemId;

  const cart = await removeCartItemService({
    userId: req.user._id,
    guestId: null,
    warehouseId,
    itemId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const clearMyCart = asyncHandler(async (req, res) => {
  const warehouseId = req.params.warehouseId;

  await clearCartService({
    userId: req.user._id,
    guestId: null,
    warehouseId,
  });

  res.status(200).json({});
});

export const setMyCartAddress = asyncHandler(async (req, res) => {
  const { userAddressId, warehouseId } = req.body;

  const cart = await setCartAddressFromUserService({
    userId: req.user._id,
    userAddressId,
    warehouseId,
    lang: req.lang,
  });

  res.status(200).json({ data: cart });
});

export const addMyCartBundle = asyncHandler(async (req, res) => {
  const { bundleId, expectedRevision, quantity } = req.body;
  const cart = await upsertCartBundleService({ userId: req.user._id, warehouseId: req.params.warehouseId,
    bundleId, expectedRevision, quantity, lang: req.lang });
  res.status(200).json({ data: cart });
});
export const updateMyCartBundle = asyncHandler(async (req, res) => {
  const cart = await updateCartBundleService({ userId: req.user._id, warehouseId: req.params.warehouseId,
    groupId: req.params.groupId, quantity: req.body.quantity, lang: req.lang });
  res.status(200).json({ data: cart });
});
export const removeMyCartBundle = asyncHandler(async (req, res) => {
  const cart = await removeCartBundleService({ userId: req.user._id, warehouseId: req.params.warehouseId,
    groupId: req.params.groupId, lang: req.lang });
  res.status(200).json({ data: cart });
});
export const rebindMyBundleCart = asyncHandler(async (req, res) => {
  const cart = await rebindCartWithBundlesService({ userId: req.user._id, warehouseId: req.params.warehouseId, lang: req.lang });
  res.status(200).json({ data: cart });
});

function guestBundleAction(service, input) {
  return asyncHandler(async (req, res) => {
    const guestId = getGuestId(req);
    if (!guestId) throw new ApiError("x-guest-id header is required", 400);
    const cart = await service({ guestId, warehouseId: req.params.warehouseId, lang: req.lang, ...input(req) });
    res.status(200).json({ data: cart });
  });
}
export const addGuestCartBundle = guestBundleAction(upsertCartBundleService, req => ({
  bundleId: req.body.bundleId, expectedRevision: req.body.expectedRevision, quantity: req.body.quantity,
}));
export const updateGuestCartBundle = guestBundleAction(updateCartBundleService, req => ({
  groupId: req.params.groupId, quantity: req.body.quantity,
}));
export const removeGuestCartBundle = guestBundleAction(removeCartBundleService, req => ({ groupId: req.params.groupId }));
export const rebindGuestBundleCart = guestBundleAction(rebindCartWithBundlesService, () => ({}));
