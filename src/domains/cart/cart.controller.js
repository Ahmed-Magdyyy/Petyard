import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/ApiError.js";
import {
  getCartService,
  upsertCartItemService,
  updateCartItemQuantityService,
  removeCartItemService,
  clearCartService,
  mergeGuestCartService,
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

  res.status(204).json({});
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

  res.status(204).json({});
});
