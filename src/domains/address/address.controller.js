import asyncHandler from "express-async-handler";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  getGuestAddressesService,
  addGuestAddressService,
  updateGuestAddressService,
  deleteGuestAddressService,
  setDefaultGuestAddressService,
  mergeGuestAddressesService,
} from "./address.service.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

// ── Guest address controllers ──────────────────────────────────────────────

export const getGuestAddresses = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await getGuestAddressesService({ guestId });
  res.status(200).json({ data: addresses });
});

export const addGuestAddress = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await addGuestAddressService({
    guestId,
    payload: req.body,
  });

  res.status(201).json({ data: addresses });
});

export const updateGuestAddress = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await updateGuestAddressService({
    guestId,
    addressId: req.params.addressId,
    payload: req.body,
  });

  res.status(200).json({ data: addresses });
});

export const deleteGuestAddress = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await deleteGuestAddressService({
    guestId,
    addressId: req.params.addressId,
  });

  res.status(200).json({ data: addresses });
});

export const setDefaultGuestAddress = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await setDefaultGuestAddressService({
    guestId,
    addressId: req.params.addressId,
  });

  res.status(200).json({ data: addresses });
});

// ── Merge controller (requires JWT + x-guest-id) ──────────────────────────

export const mergeGuestAddresses = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const addresses = await mergeGuestAddressesService({
    userId: req.user._id,
    guestId,
  });

  res.status(200).json({ data: addresses });
});
