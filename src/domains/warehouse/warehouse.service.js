// src/domains/warehouse/warehouse.service.js
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";
import { roles } from "../../shared/constants/enums.js";
import { UserModel } from "../user/user.model.js";
import {
  countWarehouses,
  findWarehouses,
  findWarehouseById,
  createWarehouse,
  clearAllDefaultWarehouses,
  clearDefaultForOtherWarehouses,
  deleteWarehouseById,
} from "./warehouse.repository.js";

import { warehouseFulfillmentStatusEnum } from '../../shared/constants/enums.js';
import {
  assertMaintenanceFallbackAvailable,
  assertWarehouseNotInUseAsFallback,
  validateFallbackWarehouse,
} from './warehouse.fulfillment.js';
import { validatePrimeConfiguration } from './warehouse.delivery.js';

function geometryValue(geometry) {
  if (!geometry || (geometry.type === undefined && geometry.coordinates === undefined)) return null;
  return { type: geometry.type, coordinates: geometry.coordinates };
}

function mergedDeliveryConfiguration(warehouse, payload) {
  const defaultPrice = hasOwn(payload, 'defaultShippingPrice')
    ? payload.defaultShippingPrice : warehouse?.defaultShippingPrice ?? 0;
  return {
    boundaryGeometry: hasOwn(payload, 'boundaryGeometry')
      ? payload.boundaryGeometry : geometryValue(warehouse?.boundaryGeometry),
    primeBoundaryGeometry: hasOwn(payload, 'primeBoundaryGeometry')
      ? payload.primeBoundaryGeometry : geometryValue(warehouse?.primeBoundaryGeometry),
    primeShippingPrice: hasOwn(payload, 'primeShippingPrice')
      ? payload.primeShippingPrice : warehouse?.primeShippingPrice ?? null,
    defaultShippingPrice: defaultPrice == null ? defaultPrice : Number(defaultPrice),
  };
}

async function validateModeratorsOrThrow(moderators) {
  if (moderators === undefined) return undefined;
  if (!Array.isArray(moderators)) return undefined;

  const uniqueIds = [
    ...new Set(moderators.map((id) => String(id)).filter(Boolean)),
  ];

  if (uniqueIds.length === 0) return [];

  const found = await UserModel.find({
    _id: { $in: uniqueIds },
    role: roles.MODERATOR,
  }).select("_id");

  if (found.length !== uniqueIds.length) {
    throw new ApiError("Invalid moderator ids", 400);
  }

  return found.map((u) => u._id);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeBoolean(value, fallback, fieldName) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ApiError(`${fieldName} must be a boolean`, 400);
}

function normalizeFulfillmentConfiguration({
  currentFulfillment,
  fulfillment,
}) {
  if (fulfillment === undefined) return undefined;

  const next = {
    status:
      fulfillment.status ||
      currentFulfillment?.status ||
      warehouseFulfillmentStatusEnum.OPERATIONAL,
    fallbackWarehouse: hasOwn(fulfillment, 'fallbackWarehouse')
      ? fulfillment.fallbackWarehouse
      : currentFulfillment?.fallbackWarehouse || null,
    statusReason: hasOwn(fulfillment, 'statusReason')
      ? fulfillment.statusReason
      : currentFulfillment?.statusReason || null,
  };

  return next;
}

async function assertWarehouseStateAllowed({
  warehouseId,
  isDefault,
  active,
  fulfillment,
}) {
  const status =
    fulfillment?.status || warehouseFulfillmentStatusEnum.OPERATIONAL;
  const fallbackWarehouseId = fulfillment?.fallbackWarehouse || null;

  if (
    isDefault &&
    (!active || status !== warehouseFulfillmentStatusEnum.OPERATIONAL)
  ) {
    throw new ApiError(
      'The default warehouse must be active and operational',
      400,
    );
  }

  if (status === warehouseFulfillmentStatusEnum.MAINTENANCE) {
    if (!active) {
      throw new ApiError(
        'A maintenance warehouse must remain active so its delivery zone can use the fallback warehouse',
        400,
      );
    }

    await assertMaintenanceFallbackAvailable({
      sourceWarehouseId: warehouseId,
      fallbackWarehouseId,
    });
  } else if (fallbackWarehouseId) {
    await validateFallbackWarehouse({
      sourceWarehouseId: warehouseId,
      fallbackWarehouseId,
    });
  }

  if (
    warehouseId &&
    (!active || status !== warehouseFulfillmentStatusEnum.OPERATIONAL)
  ) {
    await assertWarehouseNotInUseAsFallback(warehouseId);
  }
}

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
  const { isDefault, active, moderators, fulfillment, ...rest } = payload || {};

  validatePrimeConfiguration(mergedDeliveryConfiguration(null, rest));

  const validatedModerators = await validateModeratorsOrThrow(moderators);
  const validatedFulfillment = normalizeFulfillmentConfiguration({
    currentFulfillment: null,
    fulfillment,
  });

  const normalizedIsDefault = normalizeBoolean(isDefault, false, 'isDefault');
  const normalizedActive = normalizeBoolean(active, true, 'active');
  const resultingFulfillment =
    validatedFulfillment || {
      status: warehouseFulfillmentStatusEnum.OPERATIONAL,
      fallbackWarehouse: null,
      statusReason: null,
    };

  await assertWarehouseStateAllowed({
    warehouseId: null,
    isDefault: normalizedIsDefault,
    active: normalizedActive,
    fulfillment: resultingFulfillment,
  });

  if (normalizedIsDefault) {
    await clearAllDefaultWarehouses();
  }

  if (
    rest.boundaryGeometry &&
    (!rest.boundaryGeometry.coordinates ||
      rest.boundaryGeometry.coordinates.length === 0)
  ) {
    delete rest.boundaryGeometry;
  }

  if (
    rest.location &&
    (!rest.location.coordinates || rest.location.coordinates.length === 0)
  ) {
    delete rest.location;
  }

  const warehouse = await createWarehouse({
    ...rest,
    isDefault: normalizedIsDefault,
    active: normalizedActive,
    ...(validatedModerators !== undefined
      ? { moderators: validatedModerators }
      : {}),
    ...(validatedFulfillment !== undefined
      ? { fulfillment: validatedFulfillment }
      : {}),
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
    email,
    phone,
    location,
    boundaryGeometry,
    active,
    isDefault,
    moderators,
    defaultShippingPrice,
    primeBoundaryGeometry,
    primeShippingPrice,
    fulfillment,
  } = payload;

  const deliveryFields = ['boundaryGeometry', 'defaultShippingPrice', 'primeBoundaryGeometry', 'primeShippingPrice'];
  const previousDelivery = mergedDeliveryConfiguration(warehouse, {});
  const nextDelivery = mergedDeliveryConfiguration(warehouse, payload);
  const changesDelivery = deliveryFields.some((field) => hasOwn(payload, field));
  if (changesDelivery) validatePrimeConfiguration(nextDelivery);
  // Also guard legacy edits: another writer may enable Prime after this read.
  const guardDelivery = changesDelivery;

  const validatedFulfillment = normalizeFulfillmentConfiguration({
    currentFulfillment: warehouse.fulfillment,
    fulfillment,
  });

  const resultingFulfillmentStatus =
    validatedFulfillment?.status ||
    warehouse.fulfillment?.status ||
    warehouseFulfillmentStatusEnum.OPERATIONAL;
  const resultingIsDefault = normalizeBoolean(
    isDefault,
    warehouse.isDefault,
    'isDefault',
  );
  const resultingActive = normalizeBoolean(active, warehouse.active, 'active');
  const resultingFulfillment =
    validatedFulfillment ||
    warehouse.fulfillment || {
      status: resultingFulfillmentStatus,
      fallbackWarehouse: null,
      statusReason: null,
    };

  await assertWarehouseStateAllowed({
    warehouseId: warehouse._id,
    isDefault: resultingIsDefault,
    active: resultingActive,
    fulfillment: resultingFulfillment,
  });

  if (name !== undefined) warehouse.name = name;
  if (code !== undefined) warehouse.code = code;
  if (country !== undefined) warehouse.country = country;
  if (governorate !== undefined) warehouse.governorate = governorate;
  if (address !== undefined) warehouse.address = address;
  if (email !== undefined) warehouse.email = email;
  if (phone !== undefined) warehouse.phone = phone;
  if (defaultShippingPrice !== undefined) warehouse.defaultShippingPrice = defaultShippingPrice;
  if (primeShippingPrice !== undefined) warehouse.primeShippingPrice = primeShippingPrice;
  if (primeBoundaryGeometry !== undefined) {
    warehouse.primeBoundaryGeometry = primeBoundaryGeometry || undefined;
    warehouse.markModified('primeBoundaryGeometry');
  }

  if (location !== undefined) {
    if (
      !location ||
      !location.coordinates ||
      location.coordinates.length === 0
    ) {
      warehouse.location = undefined;
    } else {
      warehouse.location = location;
    }
  }

  if (boundaryGeometry !== undefined) {
    if (
      !boundaryGeometry ||
      !boundaryGeometry.coordinates ||
      boundaryGeometry.coordinates.length === 0
    ) {
      warehouse.boundaryGeometry = undefined;
    } else {
      warehouse.boundaryGeometry = boundaryGeometry;
    }
  }

  if (isDefault !== undefined) {
    if (resultingIsDefault) {
      await clearDefaultForOtherWarehouses(id);
      warehouse.isDefault = true;
    } else {
      warehouse.isDefault = false;
    }
  }

  if (moderators !== undefined) {
    warehouse.moderators = await validateModeratorsOrThrow(moderators);
  }
  if (validatedFulfillment !== undefined) {
    warehouse.fulfillment = validatedFulfillment;
  }
  if (active !== undefined) warehouse.active = resultingActive;

  if (guardDelivery) {
    // Mongoose adds these original-value conditions to this document's save.
    // Competing geometry/price edits must not persist an invalid merged pair.
    warehouse.$where = {
      boundaryGeometry: previousDelivery.boundaryGeometry,
      primeBoundaryGeometry: previousDelivery.primeBoundaryGeometry,
      primeShippingPrice: previousDelivery.primeShippingPrice,
      defaultShippingPrice: previousDelivery.defaultShippingPrice === 0
        ? { $in: [0, null] } : previousDelivery.defaultShippingPrice,
    };
  }
  try {
    return await warehouse.save();
  } catch (error) {
    if (guardDelivery && ['DocumentNotFoundError', 'VersionError'].includes(error.name)) {
      throw new ApiError('Warehouse delivery configuration changed. Reload and retry.', 409);
    }
    throw error;
  }
}

export async function toggleWarehouseActiveService(id) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  const nextActive = !warehouse.active;

  await assertWarehouseStateAllowed({
    warehouseId: warehouse._id,
    isDefault: warehouse.isDefault,
    active: nextActive,
    fulfillment: warehouse.fulfillment,
  });

  warehouse.active = nextActive;
  const updated = await warehouse.save();
  return updated;
}

export async function deleteWarehouseService(id) {
  const warehouse = await findWarehouseById(id);
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${id}`, 404);
  }

  if (warehouse.isDefault) {
    throw new ApiError('The default warehouse cannot be deleted', 409);
  }

  await assertWarehouseNotInUseAsFallback(warehouse._id);

  // TODO: later, prevent delete if warehouse has stock/orders

  await deleteWarehouseById(id);
}
