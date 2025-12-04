// src/domains/warehouse/warehouse.service.js
import { ApiError } from "../../shared/ApiError.js";
import { buildPagination, buildSort, buildRegexFilter } from "../../shared/utils/apiFeatures.js";
import {
  countWarehouses,
  findWarehouses,
  findWarehouseById,
  createWarehouse,
  clearAllDefaultWarehouses,
  clearDefaultForOtherWarehouses,
  deleteWarehouseById,
} from "./warehouse.repository.js";

export async function getWarehousesService(queryParams = {}) {
  const { page, limit, lang, isDefault, ...rawQuery } = queryParams;

  const filter = buildRegexFilter(rawQuery, []);

  if (typeof isDefault === "string") {
    const v = isDefault.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") {
      filter.isDefault = true;
    } else if (v === "false" || v === "0" || v === "no" || v === "off") {
      filter.isDefault = false;
    }
  } else if (typeof isDefault === "boolean") {
    filter.isDefault = isDefault;
  }

  console.log(filter);
  
  const totalCount = await countWarehouses(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);
  const sort = buildSort(queryParams, "-createdAt");

  const data = await findWarehouses(filter, { skip, limit: limitNum, sort });
  const totalPages = Math.ceil(totalCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: data.length,
    data,
  };
}

export async function getWarehouseByIdService(id) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }
  return warehouse;
}

export async function createWarehouseService(payload) {
  const { isDefault, ...rest } = payload || {};
console.log(payload);

  if (isDefault) {
    await clearAllDefaultWarehouses();
  }

  const warehouse = await createWarehouse({
    ...rest,
    ...(typeof isDefault === "boolean" ? { isDefault } : {}),
  });

  return warehouse;
}

export async function updateWarehouseService(id, payload) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  const {
    name,
    code,
    country,
    governorate,
    address,
    location,
    boundaryGeometry,
    active,
    isDefault,
  } = payload;

  if (name !== undefined) warehouse.name = name;
  if (code !== undefined) warehouse.code = code;
  if (country !== undefined) warehouse.country = country;
  if (governorate !== undefined) warehouse.governorate = governorate;
  if (address !== undefined) warehouse.address = address;
  if (location !== undefined) warehouse.location = location;
  if (boundaryGeometry !== undefined) warehouse.boundaryGeometry = boundaryGeometry;
  if (typeof isDefault === "boolean") {
    if (isDefault) {
      await clearDefaultForOtherWarehouses(id);
      warehouse.isDefault = true;
    } else {
      warehouse.isDefault = false;
    }
  }
  if (active !== undefined) warehouse.active = active;

  const updated = await warehouse.save();
  return updated;
}

export async function toggleWarehouseActiveService(id) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  warehouse.active = !warehouse.active;
  const updated = await warehouse.save();
  return updated;
}

export async function deleteWarehouseService(id) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  // TODO: later, prevent delete if warehouse has stock/orders

  await deleteWarehouseById(id);
}
