import { ApiError } from "../../shared/utils/ApiError.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";

// Expand a backend-loaded definition; this does not establish eligibility or reserve stock.
export function buildFixedBundleInventoryDemands({ warehouseId, components, quantity }) {
  if (typeof warehouseId !== "string" || !/^[a-f\d]{24}$/i.test(warehouseId)) {
    const error = new ApiError("An exact warehouse is required", 400);
    error.code = "BUNDLE_INVALID_WAREHOUSE"; throw error;
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    const error = new ApiError("Bundle quantity must be a positive safe integer", 400);
    error.code = "BUNDLE_INVALID_QUANTITY"; throw error;
  }
  const demands = normalizeFixedBundleComponents(components).map(component => {
    const expandedQuantity = component.quantity * quantity;
    if (!Number.isSafeInteger(expandedQuantity)) {
      const error = new ApiError("Expanded component quantity is too large", 400);
      error.code = "BUNDLE_INVALID_QUANTITY"; throw error;
    }
    return { ...component, quantity: expandedQuantity };
  });
  return { warehouseId: warehouseId.toLowerCase(), demands };
}
