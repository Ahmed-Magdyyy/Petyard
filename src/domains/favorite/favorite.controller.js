import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/ApiError.js";
import {
  getFavoriteService,
  addToFavoriteService,
  removeFromFavoriteService,
  clearFavoriteService,
  mergeGuestFavoriteService,
} from "./favorite.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const getFavorite = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const lang = req.lang || "en";

  const result = await getFavoriteService({ userId, lang });

  res.status(200).json({ data: result });
});

export const addToFavorite = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;
  const lang = req.lang || "en";

  const result = await addToFavoriteService({
    userId,
    productId,
    lang,
  });

  res.status(200).json({ data: result });
});

export const removeFromFavorite = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;

  const result = await removeFromFavoriteService({
    userId,
    productId,
  });

  res.status(200).json({ data: result });
});

export const clearFavorite = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const result = await clearFavoriteService({ userId });

  res.status(200).json({ data: result });
});

export const getFavoriteGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const lang = req.lang || "en";

  const result = await getFavoriteService({ guestId, lang });

  res.status(200).json({ data: result });
});

export const addToFavoriteGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { productId } = req.params;
  const lang = req.lang || "en";

  const result = await addToFavoriteService({
    guestId,
    productId,
    lang,
  });

  res.status(200).json({ data: result });
});

export const removeFromFavoriteGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { productId } = req.params;

  const result = await removeFromFavoriteService({
    guestId,
    productId,
  });

  res.status(200).json({ data: result });
});

export const clearFavoriteGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const result = await clearFavoriteService({ guestId });

  res.status(200).json({ data: result });
});

export const mergeGuestFavoriteIntoMyFavorite = asyncHandler(
  async (req, res) => {
    const guestId = getGuestId(req);
    if (!guestId) {
      throw new ApiError("x-guest-id header is required", 400);
    }

    const lang = req.lang || "en";

    const result = await mergeGuestFavoriteService({
      userId: req.user._id,
      guestId,
      lang,
    });

    res.status(200).json({ data: result });
  }
);
