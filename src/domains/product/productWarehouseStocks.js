import { ApiError } from "../../shared/utils/ApiError.js";

function normalizeQuantity(value) {
  if (typeof value === "number") return value;
  return Number(value) || 0;
}

/**
 * Produces exactly one stock record for every warehouse. Quantities supplied
 * by the admin are preserved; omitted warehouses default to zero.
 */
export function completeWarehouseStocks(rawStocks, warehouseIds) {
  const canonicalWarehouses = new Map();
  for (const warehouseId of Array.isArray(warehouseIds) ? warehouseIds : []) {
    const key = String(warehouseId);
    if (key && !canonicalWarehouses.has(key)) {
      canonicalWarehouses.set(key, warehouseId);
    }
  }

  if (canonicalWarehouses.size === 0) {
    throw new ApiError(
      "At least one warehouse must exist before creating product stock",
      400,
    );
  }

  const suppliedQuantities = new Map();
  for (const stock of Array.isArray(rawStocks) ? rawStocks : []) {
    if (!stock?.warehouse) {
      throw new ApiError(
        "Each warehouseStocks entry must include a warehouse",
        400,
      );
    }

    const key = String(stock.warehouse);
    if (!canonicalWarehouses.has(key)) {
      throw new ApiError("One or more warehouses do not exist", 400);
    }
    if (suppliedQuantities.has(key)) {
      throw new ApiError(
        "warehouseStocks cannot contain duplicate warehouses",
        400,
      );
    }

    suppliedQuantities.set(key, normalizeQuantity(stock.quantity));
  }

  return [...canonicalWarehouses.entries()].map(([key, warehouse]) => ({
    warehouse,
    quantity: suppliedQuantities.get(key) ?? 0,
  }));
}
