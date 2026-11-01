import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";

const invalid = () => { throw new ApiError("Cart contents are unavailable. Refresh the cart before merging.", 409); };
const id = value => mongoose.isObjectIdOrHexString(value);
const sum = (a, b) => {
  if (!Number.isSafeInteger(a) || a < 1 || !Number.isSafeInteger(b) || b < 1 || !Number.isSafeInteger(a + b)) invalid();
  return a + b;
};

// Combine requested quantities only; normal cart pricing/availability remains authoritative.
export function combineGuestCartContents(account, guest) {
  const items = [], itemKeys = new Map(), itemIds = new Set();
  for (const cart of [account, guest]) {
    if (!cart) continue;
    if (!Array.isArray(cart.items)) invalid();
    for (const value of cart.items) {
      if (!id(value?._id) || !id(value.product) || !["SIMPLE", "VARIANT"].includes(value.productType) ||
          !Number.isSafeInteger(value.quantity) || value.quantity < 1 ||
          (value.productType === "VARIANT" ? !id(value.variantId) : value.variantId != null)) invalid();
      const key = `${value.product}:${value.productType}:${value.variantId ?? ""}`;
      const existing = itemKeys.get(key);
      if (existing) existing.quantity = sum(existing.quantity, value.quantity);
      else {
        const item = { ...value };
        if (itemIds.has(String(item._id))) item._id = new mongoose.Types.ObjectId();
        items.push(item); itemKeys.set(key, item); itemIds.add(String(item._id));
      }
    }
  }
  const bundles = [], bundleKeys = new Map(), groupIds = new Set(), bundleConflicts = [];
  for (const cart of [account, guest]) {
    if (cart?.bundles === undefined) continue;
    if (!Array.isArray(cart.bundles)) invalid();
    for (const value of cart.bundles) {
      if (!id(value?.id) || !id(value.bundleId) || !Number.isSafeInteger(value.quantity) || value.quantity < 1 ||
          !Number.isSafeInteger(value.bundleRevision) || value.bundleRevision < 1 ||
          !Number.isSafeInteger(value.unitPricePiastres) || value.unitPricePiastres < 1) invalid();
      const key = String(value.bundleId), existing = bundleKeys.get(key);
      if (existing) {
        if (existing.bundleRevision !== value.bundleRevision || existing.unitPricePiastres !== value.unitPricePiastres) bundleConflicts.push({ ...value });
        existing.quantity = sum(existing.quantity, value.quantity);
      }
      else {
        const group = { ...value };
        if (groupIds.has(String(group.id))) group.id = String(new mongoose.Types.ObjectId());
        bundles.push(group); bundleKeys.set(key, group); groupIds.add(String(group.id));
      }
    }
  }
  return { items, bundles, bundleConflicts };
}
