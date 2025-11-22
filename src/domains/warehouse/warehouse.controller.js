// src/domains/warehouse/warehouse.controller.js
import asyncHandler from "express-async-handler";
import {
  getWarehousesService,
  getWarehouseByIdService,
  createWarehouseService,
  updateWarehouseService,
  toggleWarehouseActiveService,
  deleteWarehouseService,
} from "./warehouse.service.js";

// GET /warehouses (admin list)
export const getWarehouses = asyncHandler(async (req, res) => {
  const result = await getWarehousesService(req.query);
  res.status(200).json(result);
});

// GET /warehouses/:id
export const getWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await getWarehouseByIdService(req.params.id);
  res.status(200).json({ data: warehouse });
});

// POST /warehouses
export const createWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await createWarehouseService(req.body);
  res.status(201).json({ data: warehouse });
});

// PATCH /warehouses/:id
export const updateWarehouse = asyncHandler(async (req, res) => {
  const warehouse = await updateWarehouseService(req.params.id, req.body);
  res.status(200).json({ data: warehouse });
});

// PATCH /warehouses/:id/toggle-active
export const toggleWarehouseActive = asyncHandler(async (req, res) => {
  const warehouse = await toggleWarehouseActiveService(req.params.id);
  res
    .status(200)
    .json({ message: "Warehouse active status changed successfully", data: warehouse });
});

// DELETE /warehouses/:id
export const deleteWarehouse = asyncHandler(async (req, res) => {
  await deleteWarehouseService(req.params.id);
  res.status(204).json({ message: "Warehouse deleted successfully" });
});
