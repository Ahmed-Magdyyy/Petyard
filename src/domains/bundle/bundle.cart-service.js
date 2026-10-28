import mongoose from "mongoose";
import { CartModel } from "../cart/cart.model.js";
import { mapCartToResponse } from "../cart/cart.service.js";
import { bundleInputError } from "./bundle.draft-input.js";
import { savedBundleCartGroups, inspectBundleCartState } from "./bundle.cart-state.js";
import { loadBundleCartViewSources } from "./bundle.cart-transaction.js";
import { fromPiastres } from "../../shared/utils/money.js";

export async function runBundleCartRead(callback, session) {
  if (session != null) {
    if (typeof session.inTransaction !== "function" || !session.inTransaction()) bundleInputError("An active transaction is required", "BUNDLE_CART_TRANSACTION_REQUIRED", 503);
    return callback(session);
  }
  const owned = await mongoose.startSession();
  try { return await owned.withTransaction(() => callback(owned), {
    readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
  }); } finally { await owned.endSession(); }
}
const material = rows => rows.map(row => ({ id: String(row.id), productId: String(row.productId), productType: row.productType,
  variantId: row.variantId == null ? null : String(row.variantId), quantity: row.quantity, itemPrice: row.itemPrice }));
const unavailable = error => {
  if ((error.statusCode ?? error.status) !== 409 || !/^BUNDLE_/.test(error.code)) throw error;
  return error.code;
};
export function bundleCartGroupView(ref, snapshot, reason) {
  return { id: ref.id, bundleId: ref.bundleId, bundleRevision: ref.bundleRevision, type: "BUNDLE", quantity: ref.quantity,
    itemPrice: fromPiastres(ref.unitPricePiastres), name: snapshot?.name ?? null, image: snapshot?.image ?? null,
    originalItemPrice: snapshot ? fromPiastres(snapshot.originalUnitPricePiastres) : null,
    lineTotal: snapshot ? fromPiastres(snapshot.lineTotalPiastres) : null,
    status: snapshot ? "available" : "unavailable", reason,
    components: snapshot ? snapshot.components.map(({ productId, productType, variantId, name, image, variantOptions, quantity }) =>
      ({ productId, productType, variantId, name, image, variantOptions, quantity })) : [] };
}

// Internal projection reused by the existing cart endpoint.
export async function getBundleCartView(actor, args, config, { session } = {}) {
  if (config?.bundleCartEnabled !== true) bundleInputError("Bundle cart is unavailable", "BUNDLE_CART_UNAVAILABLE", 503);
  return runBundleCartRead(async current => {
    const { raw, slice, warehouse, products, definitions } = await loadBundleCartViewSources(actor, args, { session: current });
    if (raw && (raw.currency !== "EGP" || !Number.isSafeInteger(raw.__v) || raw.__v < 0 || raw.__v >= Number.MAX_SAFE_INTEGER)) {
      bundleInputError("Cart context is unavailable", "BUNDLE_CART_REVIEW_REQUIRED", 409);
    }
    const base = raw ? mapCartToResponse(CartModel.hydrate({ ...raw, bundles: undefined })) : null;
    const input = { ownerId: String(actor._id), cart: raw ? { ...raw, items: slice.items } : null,
      warehouseId: args.warehouseId.toLowerCase(), warehouse, products, definitions, language: args.language };
    const warehouseChangeRequired = raw != null && String(raw.warehouse).toLowerCase() !== input.warehouseId;
    let quote = null, reason = warehouseChangeRequired ? "BUNDLE_CART_WAREHOUSE_CHANGED" : null;
    if (!warehouseChangeRequired) try { quote = inspectBundleCartState(input); } catch (error) { reason = unavailable(error); }
    const groups = savedBundleCartGroups(raw).map(ref => {
      if (warehouseChangeRequired) return bundleCartGroupView(ref, null, reason);
      try {
        const one = inspectBundleCartState({ ...input, cart: { ...input.cart, items: [], bundles: [ref] } });
        return bundleCartGroupView(ref, one.groups[0], null);
      } catch (error) { return bundleCartGroupView(ref, null, unavailable(error)); }
    });
    const ordinaryRefreshRequired = JSON.stringify(material(slice.before)) !== JSON.stringify(material(slice.after));
    const result = { id: raw ? String(raw._id) : null, userId: String(actor._id).toLowerCase(), warehouseId: args.warehouseId.toLowerCase(),
      storedWarehouseId: raw ? String(raw.warehouse).toLowerCase() : null, warehouseChangeRequired,
      version: raw?.__v ?? null, currency: "EGP", pricingScope: "items_only", deliveryAddress: base?.deliveryAddress ?? null,
      items: slice.after, removedItems: slice.removedItems, bundles: groups,
      pricingStatus: quote ? ordinaryRefreshRequired ? "review_required" : "ready" : "unavailable", reason,
      ordinaryRefreshRequired, ordinarySubtotal: quote ? fromPiastres(quote.ordinarySubtotalPiastres) : null,
      bundleSubtotal: quote ? fromPiastres(quote.bundleSubtotalPiastres) : null,
      totalCartPrice: quote?.patch.totalCartPrice ?? null, checkoutSupported: false };
    return JSON.parse(JSON.stringify(result));
  }, session);
}

