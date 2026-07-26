import { warehouseFulfillmentStatusEnum } from '../../shared/constants/enums.js';
import { ApiError } from '../../shared/utils/ApiError.js';
import { WarehouseModel } from './warehouse.model.js';

export function getWarehouseFulfillmentStatus(warehouse) {
  return (
    warehouse?.fulfillment?.status ||
    warehouseFulfillmentStatusEnum.OPERATIONAL
  );
}

export function isWarehouseOperational(warehouse) {
  return (
    Boolean(warehouse?.active) &&
    getWarehouseFulfillmentStatus(warehouse) ===
      warehouseFulfillmentStatusEnum.OPERATIONAL
  );
}

function assertUsableFallback(sourceWarehouse, fallbackWarehouse) {
  if (!fallbackWarehouse) {
    throw new ApiError(
      'No operational fallback warehouse is configured for this warehouse',
      409,
    );
  }

  if (String(sourceWarehouse._id) === String(fallbackWarehouse._id)) {
    throw new ApiError('A warehouse cannot fall back to itself', 409);
  }

  if (!isWarehouseOperational(fallbackWarehouse)) {
    throw new ApiError(
      'The configured fallback warehouse is not active and operational',
      409,
    );
  }

  return fallbackWarehouse;
}

async function findOperationalDefaultWarehouse(sourceWarehouseId) {
  const defaultWarehouse = await WarehouseModel.findOne({
    _id: { $ne: sourceWarehouseId },
    isDefault: true,
    active: true,
  });

  return isWarehouseOperational(defaultWarehouse) ? defaultWarehouse : null;
}

export async function validateFallbackWarehouse({
  sourceWarehouseId,
  fallbackWarehouseId,
}) {
  if (fallbackWarehouseId === undefined || fallbackWarehouseId === null) {
    return null;
  }

  if (
    sourceWarehouseId &&
    String(sourceWarehouseId) === String(fallbackWarehouseId)
  ) {
    throw new ApiError('A warehouse cannot fall back to itself', 400);
  }

  const fallbackWarehouse = await WarehouseModel.findById(fallbackWarehouseId);

  if (!fallbackWarehouse) {
    throw new ApiError(
      `No fallback warehouse found for this id: ${fallbackWarehouseId}`,
      400,
    );
  }

  if (!isWarehouseOperational(fallbackWarehouse)) {
    throw new ApiError(
      'Fallback warehouse must be active and operational',
      400,
    );
  }

  return fallbackWarehouse;
}

export async function assertMaintenanceFallbackAvailable({
  sourceWarehouseId,
  fallbackWarehouseId,
}) {
  if (fallbackWarehouseId) {
    return validateFallbackWarehouse({
      sourceWarehouseId,
      fallbackWarehouseId,
    });
  }

  const defaultWarehouse =
    await findOperationalDefaultWarehouse(sourceWarehouseId);

  if (!defaultWarehouse) {
    throw new ApiError(
      'MAINTENANCE requires an operational fallback warehouse or an operational default warehouse',
      400,
    );
  }

  return defaultWarehouse;
}

export async function assertWarehouseNotInUseAsFallback(warehouseId) {
  if (!warehouseId) return;

  const dependentWarehouseExists = await WarehouseModel.exists({
    active: true,
    'fulfillment.status': warehouseFulfillmentStatusEnum.MAINTENANCE,
    'fulfillment.fallbackWarehouse': warehouseId,
  });

  if (dependentWarehouseExists) {
    throw new ApiError(
      'This warehouse is currently required as an active maintenance fallback',
      409,
    );
  }
}

export async function resolveEffectiveWarehouse(warehouseOrId) {
  const hasWarehouseState =
    warehouseOrId &&
    typeof warehouseOrId === 'object' &&
    warehouseOrId._id &&
    typeof warehouseOrId.active === 'boolean';
  const lookupId =
    warehouseOrId && typeof warehouseOrId === 'object' && warehouseOrId._id
      ? warehouseOrId._id
      : warehouseOrId;
  const sourceWarehouse =
    hasWarehouseState
      ? warehouseOrId
      : await WarehouseModel.findById(lookupId);

  if (!sourceWarehouse) {
    throw new ApiError(
      `No warehouse found for this id: ${warehouseOrId}`,
      400,
    );
  }

  if (!sourceWarehouse.active) {
    throw new ApiError('This warehouse and its delivery zone are inactive', 409);
  }

  const status = getWarehouseFulfillmentStatus(sourceWarehouse);

  if (status === warehouseFulfillmentStatusEnum.OPERATIONAL) {
    return {
      zoneWarehouse: sourceWarehouse,
      effectiveWarehouse: sourceWarehouse,
      rerouted: false,
    };
  }

  if (status === warehouseFulfillmentStatusEnum.CLOSED) {
    throw new ApiError(
      'This warehouse is closed and cannot fulfill orders',
      409,
    );
  }

  const configuredFallbackId =
    sourceWarehouse.fulfillment?.fallbackWarehouse || null;

  const fallbackWarehouse = configuredFallbackId
    ? await WarehouseModel.findById(configuredFallbackId)
    : await findOperationalDefaultWarehouse(sourceWarehouse._id);

  return {
    zoneWarehouse: sourceWarehouse,
    effectiveWarehouse: assertUsableFallback(
      sourceWarehouse,
      fallbackWarehouse,
    ),
    rerouted: true,
  };
}
