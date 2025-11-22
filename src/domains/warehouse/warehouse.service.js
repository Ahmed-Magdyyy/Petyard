// src/domains/warehouse/warehouse.service.js
import { WarehouseModel } from "./warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { buildPagination, buildSort, buildRegexFilter } from "../../shared/utils/apiFeatures.js";

export async function getWarehousesService(queryParams = {}) {
  const { page, limit, ...rawQuery } = queryParams;

  const filter = buildRegexFilter(rawQuery, []);

  const totalCount = await WarehouseModel.countDocuments(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);
  const sort = buildSort(queryParams, "-createdAt");

  const q = WarehouseModel.find(filter).skip(skip).limit(limitNum);
  if (sort) q.sort(sort);

  const data = await q;
  const totalPages = Math.ceil(totalCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

export async function getWarehouseByIdService(id) {
  const warehouse = await WarehouseModel.findById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }
  return warehouse;
}

export async function createWarehouseService(payload) {
  const warehouse = await WarehouseModel.create(payload);
  return warehouse;
}

export async function updateWarehouseService(id, payload) {
  const warehouse = await WarehouseModel.findById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  const { name, code, country, governorate, address, location, active } = payload;

  if (name !== undefined) warehouse.name = name;
  if (code !== undefined) warehouse.code = code;
  if (country !== undefined) warehouse.country = country;
  if (governorate !== undefined) warehouse.governorate = governorate;
  if (address !== undefined) warehouse.address = address;
  if (location !== undefined) warehouse.location = location;
  if (active !== undefined) warehouse.active = active;

  const updated = await warehouse.save();
  return updated;
}

export async function toggleWarehouseActiveService(id) {
  const warehouse = await WarehouseModel.findById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  warehouse.active = !warehouse.active;
  const updated = await warehouse.save();
  return updated;
}

export async function deleteWarehouseService(id) {
  const warehouse = await WarehouseModel.findById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  // TODO: later, prevent delete if warehouse has stock/orders

  await WarehouseModel.deleteOne({ _id: id });
}
