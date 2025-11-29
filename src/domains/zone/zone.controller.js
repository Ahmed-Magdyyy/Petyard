// src/domains/zone/zone.controller.js
import asyncHandler from "express-async-handler";
import {
  getZonesService,
  getZoneByIdService,
  createZoneService,
  updateZoneService,
  toggleZoneActiveService,
  deleteZoneService,
  generateWarehouseGridService,
  getWarehouseZonesGridService,
  updateWarehouseZonesGridService,
  applyWarehouseBoundaryService,
} from "./zone.service.js";

// GET /zones (public list, can be filtered)
export const getZones = asyncHandler(async (req, res) => {
  const result = await getZonesService(req.query);
  res.status(200).json(result);
});

// GET /zones/:id
export const getZone = asyncHandler(async (req, res) => {
  const zone = await getZoneByIdService(req.params.id);
  res.status(200).json({ data: zone });
});

// POST /zones
export const createZone = asyncHandler(async (req, res) => {
  const zone = await createZoneService(req.body);
  res.status(201).json({ data: zone });
});

// PATCH /zones/:id
export const updateZone = asyncHandler(async (req, res) => {
  const zone = await updateZoneService(req.params.id, req.body);
  res.status(200).json({ data: zone });
});

// PATCH /zones/:id/toggle-active
export const toggleZoneActive = asyncHandler(async (req, res) => {
  const zone = await toggleZoneActiveService(req.params.id);
  res
    .status(200)
    .json({ message: "Zone active status changed successfully", data: zone });
});

// DELETE /zones/:id
export const deleteZone = asyncHandler(async (req, res) => {
  await deleteZoneService(req.params.id);
  res.status(204).json({ message: "Zone deleted successfully" });
});

// POST /warehouses/:id/zones-grid/generate
export const generateWarehouseGrid = asyncHandler(async (req, res) => {
  const { radiusKm, cellSideKm, overwrite } = req.body || {};

  const result = await generateWarehouseGridService(req.params.id, {
    radiusKm,
    cellSideKm,
    overwrite,
  });

  res.status(201).json(result);
});

// GET /warehouses/:id/zones-grid
export const getWarehouseZonesGrid = asyncHandler(async (req, res) => {
  const result = await getWarehouseZonesGridService(req.params.id);
  res.status(200).json(result);
});

// PUT /warehouses/:id/zones-grid
export const updateWarehouseZonesGrid = asyncHandler(async (req, res) => {
  const { zones } = req.body || {};

  const result = await updateWarehouseZonesGridService(req.params.id, { zones });

  res.status(200).json(result);
});

// POST /warehouses/:id/apply-boundary
export const applyWarehouseBoundary = asyncHandler(async (req, res) => {
  const result = await applyWarehouseBoundaryService(req.params.id);

  res.status(200).json(result);
});
