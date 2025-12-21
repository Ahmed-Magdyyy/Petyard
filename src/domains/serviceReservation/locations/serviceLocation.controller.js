import asyncHandler from "express-async-handler";
import {
  adminListServiceLocationsService,
  createServiceLocationService,
  deleteServiceLocationService,
  getServiceLocationAdminByIdService,
  listServiceLocationsService,
  toggleServiceLocationActiveService,
  updateServiceLocationService,
} from "./serviceLocation.service.js";

export const listServiceLocations = asyncHandler(async (req, res) => {
  const result = await listServiceLocationsService(req.lang);
  res.status(200).json(result);
});

export const adminListServiceLocations = asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const result = await adminListServiceLocationsService({ includeInactive });
  res.status(200).json(result);
});

export const adminGetServiceLocation = asyncHandler(async (req, res) => {
  const location = await getServiceLocationAdminByIdService(req.params.id);
  res.status(200).json({ data: location });
});

export const adminCreateServiceLocation = asyncHandler(async (req, res) => {
  const location = await createServiceLocationService(req.body);
  res.status(201).json({ data: location });
});

export const adminUpdateServiceLocation = asyncHandler(async (req, res) => {
  const location = await updateServiceLocationService(req.params.id, req.body);
  res.status(200).json({ data: location });
});

export const adminToggleServiceLocationActive = asyncHandler(async (req, res) => {
  const location = await toggleServiceLocationActiveService(req.params.id);
  res
    .status(200)
    .json({ message: "Service location active status changed successfully", data: location });
});

export const adminDeleteServiceLocation = asyncHandler(async (req, res) => {
  await deleteServiceLocationService(req.params.id);
  res.status(204).json({ message: "Service location deleted successfully" });
});
