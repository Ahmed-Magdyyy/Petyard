import { randomUUID } from "node:crypto";
import { bundleInputError } from "./bundle.draft-input.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";
import { toPiastres, fromPiastres } from "../../shared/utils/money.js";
import { orderLineKindEnum } from "../../shared/constants/enums.js";
import { calculateMerchandiseGrossPiastres } from "../settlement/settlement.pricing.js";
import { pendingBundleSubstitutionPiastres } from "./bundle.substitution-pending.js";

const fail = () => bundleInputError("Saved bundle order snapshot is inconsistent", "BUNDLE_ORDER_SNAPSHOT_INVALID", 409);
const integer = (value, minimum = 0) => { if (!Number.isSafeInteger(value) || value < minimum) fail(); return BigInt(value); };
const id = value => typeof value === "string" && /^[a-f\d]{24}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));
const options = value => JSON.stringify((value ?? []).map(({ name, value: text }) => ({ name, value: text })));
const associated = row => row?.bundleGroupId != null || row?.bundleComponentIndex != null;
const referenceId = value => String(value?._id ?? value);

export function assertBundleOrderSnapshot(order) {
  const pendingAmount = pendingBundleSubstitutionPiastres(order);
  const groups = order?.bundleGroups;
  if (groups === undefined) { if ((order?.items ?? []).some(associated)) fail(); return; }
  if (!Array.isArray(groups)) fail();
  if (!groups.length) { if ((order?.items ?? []).some(associated)) fail(); return; }
  if (!id(referenceId(order.user)) || order.guestId != null || order.currency !== "EGP" || !Array.isArray(order.items)) fail();
  const groupIds = new Set(), definitionIds = new Set(), expected = new Map();
  for (const group of groups) {
    if (!id(group.id) || !id(group.bundleId) || groupIds.has(group.id) || definitionIds.has(group.bundleId) ||
      group.warehouseId !== referenceId(order.warehouse) || group.currency !== order.currency || !["en", "ar"].includes(group.language) ||
      typeof group.name !== "string" || !group.name.trim() || !Array.isArray(group.components) || !group.components.length) fail();
    groupIds.add(group.id); definitionIds.add(group.bundleId); integer(group.bundleRevision, 1);
    const count = integer(group.quantity, 1), price = integer(group.unitPricePiastres, 1), original = integer(group.originalUnitPricePiastres, 1);
    if (price > original || integer(group.lineTotalPiastres, 1) !== count * price) fail();
    const components = group.components.map(row => ({ productId: row.productId, productType: row.productType, variantId: row.variantId, quantity: row.quantity }));
    let normalized;
    try { normalized = normalizeFixedBundleComponents(components); } catch { fail(); }
    if (normalized.length !== components.length) fail();
    let allocated = 0n, regular = 0n;
    group.components.forEach((component, index) => {
      const physical = integer(component.quantity, 1), unit = integer(component.regularUnitPricePiastres);
      if (!id(component.productId) || (component.productType === "VARIANT" ? !id(component.variantId) : component.variantId != null) ||
        typeof component.name !== "string" || !component.name.trim() || !Array.isArray(component.variantOptions) ||
        component.variantOptions.some(option => !option || typeof option.name !== "string" || !option.name.trim() || typeof option.value !== "string" || !option.value.trim()) ||
        !Array.isArray(component.allocations) || component.allocations.length < 1 || component.allocations.length > 2) fail();
      regular += physical * unit;
      let quantity = 0n; const prices = new Set();
      for (const allocation of component.allocations) {
        const units = integer(allocation.quantity, 1), amount = integer(allocation.unitPricePiastres);
        if (prices.has(allocation.unitPricePiastres) || units * count > BigInt(Number.MAX_SAFE_INTEGER) || units * count * amount > BigInt(Number.MAX_SAFE_INTEGER)) fail();
        prices.add(allocation.unitPricePiastres); quantity += units; allocated += units * amount;
        expected.set(`${group.id}:${index}:${allocation.unitPricePiastres}`, { component, quantity: Number(units * count), amount: Number(units * count * amount) });
      }
      if (quantity !== physical) fail();
    });
    if (regular !== original || allocated !== price) fail();
  }
  const lineIds = new Set();
  for (const row of order.items) {
    if (typeof row.lineId !== "string" || !row.lineId.trim() || lineIds.has(row.lineId)) fail();
    lineIds.add(row.lineId);
    if (!associated(row)) continue;
    if (!id(row.bundleGroupId) || !Number.isSafeInteger(row.bundleComponentIndex) || row.bundleComponentIndex < 0) fail();
    const key = `${row.bundleGroupId}:${row.bundleComponentIndex}:${row.itemPricePiastres}`, entry = expected.get(key);
    if (!entry) fail();
    const component = entry.component;
    let unit, total;
    try { unit = toPiastres(row.itemPrice); total = toPiastres(row.lineTotal); } catch { fail(); }
    if (referenceId(row.product) !== component.productId || row.productType !== component.productType ||
      (row.variantId == null ? null : referenceId(row.variantId)) !== (component.variantId ?? null) ||
      row.productName !== component.name || (row.productImageUrl ?? null) !== (component.image ?? null) || options(row.variantOptions) !== options(component.variantOptions) ||
      row.quantity !== entry.quantity || row.fulfillmentQuantity !== entry.quantity || row.finalizedUnavailableQuantity !== 0 ||
      unit !== row.itemPricePiastres || row.itemPrice !== fromPiastres(unit) || total !== entry.amount || row.lineTotal !== fromPiastres(total) || row.lineTotalPiastres !== entry.amount ||
      row.lineKind !== orderLineKindEnum.ORIGINAL || row.sourceLineId != null || row.sourceSubstitutionRequest != null ||
      row.promotion?.collectionId != null || row.promotion?.collectionSlug != null || row.promotion?.discountPercent != null || row.promotionDiscountedPrice != null) fail();
    expected.delete(key);
  }
  if (expected.size) fail();
  try {
    const gross = calculateMerchandiseGrossPiastres(order.items);
    if (order.subtotal !== fromPiastres(gross + pendingAmount)) fail();
  } catch { fail(); }
}

// Backend-priced source only; this copies snapshots but performs no reservation or order save.
export function buildBundleOrderMerchandise({ plan, ordinaryItems = [], userId }) {
  if (!plan || !Array.isArray(plan.groups) || !plan.groups.length || !Array.isArray(plan.itemDrafts) ||
    !Array.isArray(ordinaryItems) || ordinaryItems.some(associated)) fail();
  const bundleGroups = copy(plan.groups);
  const items = [...copy(ordinaryItems), ...copy(plan.itemDrafts).map(row => ({ ...row, lineId: randomUUID(), lineKind: orderLineKindEnum.ORIGINAL }))];
  let subtotal;
  try { subtotal = fromPiastres(calculateMerchandiseGrossPiastres(items)); } catch { fail(); }
  assertBundleOrderSnapshot({ user: userId, warehouse: plan.warehouseId, currency: plan.currency, subtotal, items, bundleGroups });
  return { items, bundleGroups, subtotal };
}

export function presentBundleOrderGroups(order) {
  assertBundleOrderSnapshot(order);
  return order.bundleGroups.map(group => ({ id: group.id, bundleId: group.bundleId, bundleRevision: group.bundleRevision,
    type: "BUNDLE", name: group.name, image: group.image ?? null, quantity: group.quantity,
    itemPrice: fromPiastres(group.unitPricePiastres), originalItemPrice: fromPiastres(group.originalUnitPricePiastres), lineTotal: fromPiastres(group.lineTotalPiastres),
    components: group.components.map(({ productId, productType, variantId, name, image, variantOptions, quantity }) =>
      ({ productId, productType, variantId: variantId ?? null, name, image: image ?? null, variantOptions: copy(variantOptions), quantity })) }));
}

export function assertBundleOrderCanReorder(order) {
  if (order.bundleGroups !== undefined && (!Array.isArray(order.bundleGroups) || order.bundleGroups.length) || (order.items ?? []).some(associated)) {
    bundleInputError("Bundle orders require a complete-bundle reorder flow", "BUNDLE_ORDER_REORDER_REQUIRED", 409);
  }
}
export function assertBundleLineCanSubstitute(row) {
  if (associated(row)) bundleInputError("Bundle components cannot be substituted", "BUNDLE_ORDER_SUBSTITUTION_UNSUPPORTED", 409);
}
