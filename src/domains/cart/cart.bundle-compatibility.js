import { ApiError } from "../../shared/utils/ApiError.js";

export function assertOrdinaryCart(cart) {
  if (cart?.bundles === undefined || (Array.isArray(cart.bundles) && cart.bundles.length === 0)) return;
  const error = new ApiError("This cart contains bundles. Refresh your cart and try again.", 409);
  error.code = "BUNDLE_CART_FLOW_REQUIRED"; throw error;
}

// This predicate is checked by MongoDB at write time, including after a competing bundle addition.
export function ordinaryCartFilter(filter) {
  return { ...filter, $and: [...(filter.$and ?? []), { $or: [{ bundles: { $exists: false } }, { bundles: { $size: 0 } }] }] };
}
