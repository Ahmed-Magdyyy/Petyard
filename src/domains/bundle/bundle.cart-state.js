import { buildBundleCartPurchasePlan } from "./bundle.purchase-plan.js";
import { normalizeFixedBundleComponents, previewFixedBundle } from "./bundle.components.js";
import { bundleId, bundleInputError, exactBundleFields } from "./bundle.draft-input.js";
import { fromPiastres, toPiastres } from "../../shared/utils/money.js";
import { isWarehouseOperational } from "../warehouse/warehouse.fulfillment.js";
import { bundleCartIdentity, bundleCartMatchesOwner } from "./bundle.cart-identity.js";

const conflict = message => bundleInputError(message, "BUNDLE_CART_REVIEW_REQUIRED", 409);
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) bundleInputError("A positive integer quantity or revision is required");
  return value;
}
function money(value) {
  if (!Number.isSafeInteger(value) || value < 1) conflict("Saved bundle price is invalid");
  return value;
}
export function savedBundleCartGroups(cart) {
  if (cart?.bundles === undefined) return [];
  if (!Array.isArray(cart.bundles)) conflict("Saved bundle groups are unavailable");
  const rows = cart.bundles.map(row => {
    exactBundleFields(row, ["id", "bundleId", "bundleRevision", "quantity", "unitPricePiastres"]);
    return { id: bundleId(row.id), bundleId: bundleId(row.bundleId), bundleRevision: positive(row.bundleRevision),
      quantity: positive(row.quantity), unitPricePiastres: money(row.unitPricePiastres) };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.bundleId)).size !== rows.length) {
    conflict("Saved bundle group identity is ambiguous");
  }
  return rows;
}

// Backend-loaded, privately refreshed cart only. Produces a patch/quote, never saves or reserves stock.
function cartState({ ownerId, guestId, cart, warehouseId, warehouse, products, definitions, change, language = "en" }, inspectOnly = false) {
  const identity = bundleCartIdentity({ userId: ownerId, guestId });
  const owner = identity.owner, selectedWarehouse = bundleId(warehouseId);
  if (!["en", "ar"].includes(language) || !Array.isArray(definitions) || !Array.isArray(products)) bundleInputError("Invalid bundle cart context");
  if (!isWarehouseOperational(warehouse) || String(warehouse?._id).toLowerCase() !== selectedWarehouse) conflict("Selected warehouse is unavailable");
  if (cart && !bundleCartMatchesOwner(cart, identity)) bundleInputError("Cart not found", "BUNDLE_CART_NOT_FOUND", 404);
  if (cart && (String(cart.warehouse).toLowerCase() !== selectedWarehouse || cart.currency !== "EGP" ||
      !Number.isSafeInteger(cart.__v) || cart.__v < 0 || cart.__v >= Number.MAX_SAFE_INTEGER || !Array.isArray(cart.items))) {
    conflict("Cart context changed");
  }
  const groups = savedBundleCartGroups(cart), before = groups.map(row => ({ ...row }));
  if (!inspectOnly) {
    if (!change || !["add", "set", "remove"].includes(change.action)) bundleInputError("Unknown bundle cart action");
    exactBundleFields(change, change.action === "add" ? ["action", "bundleId", "expectedRevision", "quantity", "newGroupId"] :
      change.action === "set" ? ["action", "groupId", "quantity"] : ["action", "groupId"]);
    if (change.action === "add") {
      const definitionId = bundleId(change.bundleId), revision = positive(change.expectedRevision), count = positive(change.quantity);
      const newGroupId = bundleId(change.newGroupId);
      const existing = groups.find(row => row.bundleId === definitionId);
      if (existing) {
        if (existing.bundleRevision !== revision || !Number.isSafeInteger(existing.quantity + count)) conflict("Bundle quantity or revision changed");
        existing.quantity += count;
      } else {
        if (groups.some(row => row.id === newGroupId)) conflict("Bundle group identifier already exists");
        groups.push({ id: newGroupId, bundleId: definitionId, bundleRevision: revision, quantity: count, unitPricePiastres: null });
      }
    } else {
      const groupId = bundleId(change.groupId), index = groups.findIndex(row => row.id === groupId);
      if (index < 0) bundleInputError("Bundle cart group not found", "BUNDLE_CART_GROUP_NOT_FOUND", 404);
      if (change.action === "remove") groups.splice(index, 1);
      else groups[index].quantity = positive(change.quantity);
    }
  }
  const ordinaryItems = cart?.items ?? [];
  let ordinarySubtotal = 0n;
  const ordinaryIds = new Set(), ordinarySnapshot = [];
  for (const item of ordinaryItems) {
    const itemId = bundleId(String(item?._id));
    if (ordinaryIds.has(itemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) conflict("Ordinary cart items are unavailable");
    ordinaryIds.add(itemId);
    let price;
    try { price = toPiastres(item.itemPrice); } catch { conflict("Ordinary cart pricing is unavailable"); }
    ordinarySubtotal += BigInt(price) * BigInt(item.quantity);
    ordinarySnapshot.push({ id: itemId, productId: bundleId(String(item.product)), productType: item.productType,
      variantId: item.variantId == null ? null : bundleId(String(item.variantId)), quantity: item.quantity, unitPricePiastres: price });
  }
  const inputs = groups.map(group => {
    const matches = definitions.filter(row => String(row?._id).toLowerCase() === group.bundleId);
    if (matches.length !== 1) conflict("Bundle definition is unavailable or ambiguous");
    const definition = matches[0];
    if (group.unitPricePiastres !== null && definition.pricePiastres !== group.unitPricePiastres) conflict("Bundle price changed; review it again");
    return { groupId: group.id, bundle: definition, expectedRevision: group.bundleRevision, quantity: group.quantity };
  });
  let plan = { groups: [], bundleSubtotalPiastres: 0, demands: [] };
  if (groups.length) {
    plan = buildBundleCartPurchasePlan({ warehouseId: selectedWarehouse, warehouse, products, ordinaryItems, bundles: inputs, language });
  } else if (ordinaryItems.length) {
    const demands = normalizeFixedBundleComponents(ordinaryItems.map(item => ({ productId: String(item.product), productType: item.productType,
      variantId: item.variantId == null ? null : String(item.variantId), quantity: item.quantity })));
    if (previewFixedBundle({ components: demands, pricePiastres: 0, warehouseId: selectedWarehouse, products }).availableBundles < 1) conflict("Ordinary cart stock changed");
    plan.demands = demands;
  }
  const subtotal = ordinarySubtotal + BigInt(plan.bundleSubtotalPiastres);
  if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) conflict("Cart total is too large");
  const next = plan.groups.map(group => ({ id: group.id, bundleId: group.bundleId, bundleRevision: group.bundleRevision,
    quantity: group.quantity, unitPricePiastres: group.unitPricePiastres }));
  return { cartId: cart ? bundleId(String(cart._id)) : null, ownerId: owner, warehouseId: selectedWarehouse,
    expectedCartVersion: cart?.__v ?? null, currency: "EGP", pricingScope: "items_only", action: inspectOnly ? "inspect" : change.action,
    ordinaryItems: ordinarySnapshot, groupsBefore: before, groupsAfter: next, groups: plan.groups, demands: plan.demands,
    ordinarySubtotalPiastres: Number(ordinarySubtotal), bundleSubtotalPiastres: plan.bundleSubtotalPiastres,
    itemsSubtotalPiastres: Number(subtotal), patch: { bundles: next.map(row => ({ ...row })), totalCartPrice: fromPiastres(Number(subtotal)) } };
}

export const calculateBundleCartChange = input => cartState(input);
export const inspectBundleCartState = input => cartState(input, true);
