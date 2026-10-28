import { toPiastres } from "../../shared/utils/money.js";
import { bundleInputError } from "./bundle.draft-input.js";

const fail = () => bundleInputError("Saved bundle order snapshot is inconsistent", "BUNDLE_ORDER_SNAPSHOT_INVALID", 409);
const id = value => typeof value === "string" && /^[a-f\d]{24}$/.test(value);
const integer = (value, minimum = 0) => { if (!Number.isSafeInteger(value) || value < minimum) fail(); return BigInt(value); };
const ref = value => String(value?._id ?? value);

// The existing offer transaction supplies a freshly created request, never client metadata.
export function bindPendingBundleSubstitution(order, request) {
  if (!order.bundleGroups?.length) return;
  if (!request || request.status !== "offered" || request.isActive !== true || ref(request.order) !== ref(order._id) ||
    ref(request.warehouse) !== ref(order.warehouse) || ref(request.user) !== ref(order.user) || request.paymentMethod !== order.paymentMethod ||
    request.responseSubmittedAt != null || request.pricingSnapshot != null || request.reservation?.state !== "none" || request.reservation?.items?.length) fail();
  order.bundlePendingSubstitution = { requestId: ref(request._id), orderId: ref(order._id), warehouseId: ref(order.warehouse),
    settlementRevision: order.settlement?.revision, subtotalPiastres: toPiastres(order.subtotal),
    shortages: (request.shortages ?? []).map(row => ({ lineId: row.lineId, productId: ref(row.product), productType: row.productType,
      variantId: row.variantId == null ? null : ref(row.variantId), quantityBefore: row.quantityBefore,
      deliverableOriginalQuantity: row.deliverableOriginalQuantity, finalizedUnavailableStart: row.finalizedUnavailableStart,
      finalizedUnavailableEnd: row.finalizedUnavailableEnd, originalUnitPricePiastres: row.originalUnitPricePiastres })) };
  pendingBundleSubstitutionPiastres(order);
}

export function pendingBundleSubstitutionPiastres(order) {
  const pending = order.bundlePendingSubstitution;
  if (pending == null) return 0;
  if (!order.bundleGroups?.length || order.sideEffectsCommitted !== true || !id(pending.requestId) || !id(pending.orderId) || pending.orderId !== ref(order._id) ||
    pending.warehouseId !== ref(order.warehouse) || !id(pending.warehouseId) ||
    !Number.isSafeInteger(pending.settlementRevision) || pending.settlementRevision < 0 ||
    pending.subtotalPiastres !== toPiastres(order.subtotal) || pending.subtotalPiastres !== order.settlement?.currentMerchandiseGrossPiastres ||
    !Array.isArray(pending.shortages) || pending.shortages.length < 1) fail();
  const active = ["pending", "accepted", "shipped"].includes(order.status) && order.substitutionState === "awaiting_customer" &&
    order.requiresCustomerAction === true && pending.requestId === ref(order.activeSubstitutionRequest);
  // Cancellation keeps the shortage proof because the existing refund uses the saved order amount.
  const cancelled = order.status === "cancelled" && order.substitutionState === "none" &&
    order.requiresCustomerAction === false && order.activeSubstitutionRequest == null;
  if ((!active && !cancelled) || pending.settlementRevision !== order.settlement?.revision) fail();
  integer(pending.subtotalPiastres);
  let amount = 0n; const seen = new Set();
  for (const shortage of pending.shortages) {
    if (typeof shortage.lineId !== "string" || !shortage.lineId || seen.has(shortage.lineId) || !id(shortage.productId)) fail();
    seen.add(shortage.lineId);
    const matches = (order.items ?? []).filter(row => row.lineId === shortage.lineId);
    if (matches.length !== 1) fail();
    const row = matches[0], before = integer(shortage.quantityBefore, 1), after = integer(shortage.deliverableOriginalQuantity);
    const start = integer(shortage.finalizedUnavailableStart), end = integer(shortage.finalizedUnavailableEnd), price = integer(shortage.originalUnitPricePiastres);
    if (row.bundleGroupId != null || row.bundleComponentIndex != null || ref(row.product) !== shortage.productId || row.productType !== shortage.productType ||
      !["SIMPLE", "VARIANT"].includes(shortage.productType) || (shortage.productType === "VARIANT" ? !id(shortage.variantId) : shortage.variantId != null) ||
      (row.variantId == null ? null : ref(row.variantId)) !== shortage.variantId || before <= after || before + start !== integer(row.quantity, 1) ||
      end !== start + before - after || integer(row.fulfillmentQuantity) !== after || integer(row.finalizedUnavailableQuantity) !== end ||
      price !== BigInt(toPiastres(row.itemPrice)) || price !== integer(row.itemPricePiastres)) fail();
    amount += (before - after) * price;
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(amount);
}
