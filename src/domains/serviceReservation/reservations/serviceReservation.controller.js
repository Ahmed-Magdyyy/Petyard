import asyncHandler from "express-async-handler";
import { ApiError } from "../../../shared/utils/ApiError.js";
import {
  adminUpdateReservationStatusService,
  cancelReservationService,
  createReservationService,
  getAvailabilityService,
  adminListReservationsByDateService,
  listReservationsForGuestService,
  listReservationsForUserService,
} from "./serviceReservation.service.js";
import { getServiceCatalog as getServiceCatalogData } from "../catalog/serviceCatalog.js";

function getGuestId(req) {
  const headerValue = req.headers["x-guest-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  return null;
}

export const getServiceCatalog = asyncHandler(async (req, res) => {
  const data = getServiceCatalogData(req.lang);
  res.status(200).json({ data });
});

export const getAvailability = asyncHandler(async (req, res) => {
  const result = await getAvailabilityService({
    locationId: req.query.locationId,
    serviceType: req.query.serviceType,
    date: req.query.date,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const adminUpdateReservationStatus = asyncHandler(async (req, res) => {
  const dto = await adminUpdateReservationStatusService({
    id: req.params.id,
    status: req.body.status,
    lang: req.lang,
  });

  res.status(200).json({ data: dto });
});

export const adminListReservationsByDate = asyncHandler(async (req, res) => {
  const { date, locationId, status } = req.query;

  const result = await adminListReservationsByDateService({
    date,
    locationId: locationId || undefined,
    status: status || undefined,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const createReservationForUser = asyncHandler(async (req, res) => {
  const dto = await createReservationService({
    userId: req.user._id,
    guestId: null,
    payload: req.body,
    lang: req.lang,
  });

  res.status(201).json({ data: dto });
});

export const createReservationForGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const dto = await createReservationService({
    userId: null,
    guestId,
    payload: req.body,
    lang: req.lang,
  });

  res.status(201).json({ data: dto });
});

export const listMyReservations = asyncHandler(async (req, res) => {
  const { scope, status } = req.query;

  const result = await listReservationsForUserService({
    userId: req.user._id,
    scope,
    status,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const listGuestReservations = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const { scope, status } = req.query;

  const result = await listReservationsForGuestService({
    guestId,
    scope: scope || "upcoming",
    status,
    lang: req.lang,
  });

  res.status(200).json(result);
});

export const cancelReservationForUser = asyncHandler(async (req, res) => {
  const dto = await cancelReservationService({
    id: req.params.id,
    userId: req.user._id,
    guestId: null,
    lang: req.lang,
  });

  res.status(200).json({ data: dto });
});

export const cancelReservationForGuest = asyncHandler(async (req, res) => {
  const guestId = getGuestId(req);
  if (!guestId) {
    throw new ApiError("x-guest-id header is required", 400);
  }

  const dto = await cancelReservationService({
    id: req.params.id,
    userId: null,
    guestId,
    lang: req.lang,
  });

  res.status(200).json({ data: dto });
});
