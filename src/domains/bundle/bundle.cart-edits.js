import mongoose from "mongoose";
import { AddressModel } from "../address/address.model.js";
import { buildCartDeliveryAddressSnapshot } from "../cart/cartAddressSnapshot.js";
import { resolveEffectiveWarehouse } from "../warehouse/warehouse.fulfillment.js";
import { bundleId, bundleInputError, exactBundleFields } from "./bundle.draft-input.js";
import { prepareBundleReorder } from "./bundle.reorder.js";

export const bundleCartEditActions = ["ordinary_add", "ordinary_set", "ordinary_remove", "rebind", "address", "reorder"];
const fail = message => bundleInputError(message, "BUNDLE_CART_REVIEW_REQUIRED", 409);
export function normalizeBundleCartEdit(value) {
  const action = value?.action;
  if (!bundleCartEditActions.includes(action)) bundleInputError("Invalid cart edit action");
  const extras = { ordinary_add: ["productId", "productType", "variantId", "quantity", "newItemId"],
    ordinary_set: ["itemId", "quantity"], ordinary_remove: ["itemId"], rebind: [], address: ["userAddressId"], reorder: ["orderId"] };
  exactBundleFields(value, ["action", "cartId", "expectedCartVersion", ...extras[action]]);
  if (!Number.isSafeInteger(value.expectedCartVersion) || value.expectedCartVersion < 0 || value.expectedCartVersion >= Number.MAX_SAFE_INTEGER) bundleInputError("Invalid cart version");
  const result = { action, cartId: bundleId(value.cartId), expectedCartVersion: value.expectedCartVersion };
  if (["ordinary_add", "ordinary_set"].includes(action)) {
    if (!Number.isSafeInteger(value.quantity) || value.quantity < 1) bundleInputError("Invalid quantity");
    result.quantity = value.quantity;
  }
  if (["ordinary_set", "ordinary_remove"].includes(action)) result.itemId = bundleId(value.itemId);
  if (action === "ordinary_add") {
    if (!["SIMPLE", "VARIANT"].includes(value.productType) || value.productType === "SIMPLE" && value.variantId != null) bundleInputError("Invalid product type or variant");
    Object.assign(result, { productId: bundleId(value.productId), productType: value.productType,
      variantId: value.productType === "VARIANT" ? bundleId(value.variantId) : null, newItemId: bundleId(value.newItemId) });
  }
  if (action === "address") result.userAddressId = bundleId(value.userAddressId);
  if (action === "reorder") result.orderId = bundleId(value.orderId);
  return result;
}

// Copy only: all pricing and stock validation still runs through private ordinary refresh and the shared plan.
export async function prepareBundleCartEdit(raw, input, session) {
  const change = input.change;
  if (!raw || String(raw._id) !== change.cartId || raw.__v !== change.expectedCartVersion || !Array.isArray(raw.items)) fail("Cart changed; reload before editing");
  bundleId(String(raw.warehouse));
  if (change.action === "reorder") return prepareBundleReorder(raw, input, session);
  const candidate = { ...raw, items: raw.items.map(row => ({ ...row })) };
  let targetItemId = null, targetQuantity = null, address = null;
  if (change.action === "ordinary_add") {
    const matches = candidate.items.filter(row => String(row.product) === change.productId && row.productType === change.productType &&
      (row.variantId == null ? null : String(row.variantId)) === change.variantId);
    if (matches.length > 1) fail("Ordinary item identity is ambiguous");
    const item = matches[0];
    if (item) {
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.quantity + change.quantity)) fail("Invalid combined quantity");
      item.quantity += change.quantity; targetItemId = String(item._id); targetQuantity = item.quantity;
    } else {
      if (candidate.items.some(row => String(row._id) === change.newItemId)) fail("Cart item identifier already exists");
      candidate.items.push({ _id: new mongoose.Types.ObjectId(change.newItemId), product: new mongoose.Types.ObjectId(change.productId),
        productType: change.productType, variantId: change.variantId == null ? undefined : new mongoose.Types.ObjectId(change.variantId),
        quantity: change.quantity, itemPrice: 0 });
      targetItemId = change.newItemId; targetQuantity = change.quantity;
    }
  }
  if (["ordinary_set", "ordinary_remove"].includes(change.action)) {
    const matches = candidate.items.filter(row => String(row._id) === change.itemId);
    if (matches.length !== 1) bundleInputError("Ordinary cart item not found", "BUNDLE_CART_ITEM_NOT_FOUND", 404);
    if (change.action === "ordinary_remove") candidate.items = candidate.items.filter(row => String(row._id) !== change.itemId);
    else { matches[0].quantity = change.quantity; targetItemId = change.itemId; targetQuantity = change.quantity; }
  }
  if (change.action === "address") {
    address = await AddressModel.findOne({ _id: new mongoose.Types.ObjectId(change.userAddressId), user: new mongoose.Types.ObjectId(input.owner) })
      .maxTimeMS(5000).session(session).lean();
    if (!address || String(address._id) !== change.userAddressId || String(address.user) !== input.owner || address.guestId != null || !address.warehouse) bundleInputError("Owned address unavailable", "BUNDLE_CART_ADDRESS_NOT_FOUND", 404);
    const resolved = await resolveEffectiveWarehouse(address.warehouse, { session });
    if (String(resolved.effectiveWarehouse._id) !== input.warehouseId) fail("Address no longer matches the selected warehouse");
    candidate.deliveryAddress = buildCartDeliveryAddressSnapshot(address);
  } else if (change.action === "rebind" && String(raw.warehouse) !== input.warehouseId) candidate.deliveryAddress = undefined;
  if (["rebind", "address"].includes(change.action)) candidate.warehouse = new mongoose.Types.ObjectId(input.warehouseId);
  return { candidate, targetItemId, targetQuantity, address };
}

export async function fenceBundleCartAddress(address, session) {
  if (!address) return;
  const version = address.__v;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER)) fail("Address version is unavailable");
  const result = await AddressModel.collection.updateOne({ _id: address._id, user: address.user,
    $expr: { $eq: ["$$ROOT", { $literal: address }] } }, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("Address changed during confirmation");
}
