import { buildBundleProductCard } from "./bundle.product-card.js";
import { buildFixedBundleInventoryDemands } from "./bundle.inventory-demands.js";
import { bundleInputError } from "./bundle.draft-input.js";
import { fromPiastres, toPiastres } from "../../shared/utils/money.js";

const id = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
function safe(value) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    bundleInputError("Bundle purchase amount is too large", "BUNDLE_PURCHASE_OVERFLOW", 409);
  }
  return Number(value);
}

function allocate(components, pricePiastres, originalPiastres) {
  const denominator = BigInt(originalPiastres);
  const shares = components.map((component, index) => {
    const numerator = BigInt(pricePiastres) * BigInt(component.regularUnitPricePiastres);
    return { index, quantity: component.quantity, base: numerator / denominator,
      remainder: numerator % denominator, extras: 0 };
  });
  let remaining = BigInt(pricePiastres) - shares.reduce((sum, share) => sum + share.base * BigInt(share.quantity), 0n);
  // Award remainder piastres by exact per-unit share, batching identical units.
  for (const share of [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    const extras = remaining < BigInt(share.quantity) ? remaining : BigInt(share.quantity);
    share.extras = safe(extras); remaining -= extras;
  }
  if (remaining !== 0n) bundleInputError("Bundle allocation is inconsistent", "BUNDLE_PURCHASE_INVALID", 409);
  return shares.map(share => {
    const rows = [];
    if (share.quantity > share.extras) rows.push({ quantity: share.quantity - share.extras, unitPricePiastres: safe(share.base) });
    if (share.extras > 0) rows.push({ quantity: share.extras, unitPricePiastres: safe(share.base + 1n) });
    return rows;
  });
}

// Internal preparation from authenticated, backend-loaded sources; no persistence or stock reservation.
export function buildBundlePurchaseSnapshot({ groupId, bundle, expectedRevision, warehouseId, warehouse, products, quantity, language = "en" }) {
  if (!id(groupId) || !id(warehouseId) || !["en", "ar"].includes(language) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    bundleInputError("Invalid bundle purchase context", "BUNDLE_PURCHASE_INVALID");
  }
  if (!bundle || !id(String(bundle._id)) || !Number.isSafeInteger(bundle.revision) || bundle.revision < 1 || !Array.isArray(bundle.components)) {
    bundleInputError("Saved bundle definition is unavailable", "BUNDLE_PURCHASE_UNAVAILABLE", 409);
  }
  if (bundle.revision !== expectedRevision) bundleInputError("Bundle changed; review it again", "BUNDLE_REVISION_CONFLICT", 409);
  if (String(warehouse?._id).toLowerCase() !== warehouseId.toLowerCase()) {
    bundleInputError("Warehouse changed; refresh the app location", "BUNDLE_WAREHOUSE_UNAVAILABLE", 409);
  }
  const card = buildBundleProductCard({ bundle, warehouse, products, lang: language });
  if (!card) bundleInputError("Bundle is unavailable in this warehouse", "BUNDLE_PURCHASE_UNAVAILABLE", 409);
  const components = card.components.map(({ productId, productType, variantId, quantity: componentQuantity }) =>
    ({ productId, productType, variantId, quantity: componentQuantity }));
  const inventory = buildFixedBundleInventoryDemands({ warehouseId, components, quantity });
  if (quantity > card.stock) bundleInputError("Not enough complete bundles in this warehouse", "BUNDLE_STOCK_CONFLICT", 409);
  const lineTotalPiastres = safe(BigInt(card.sellingPricePiastres) * BigInt(quantity));
  const included = card.components.map(component => {
    const product = products.find(row => String(row._id).toLowerCase() === component.productId);
    const sku = component.productType === "SIMPLE" ? product : product.variants.find(row => String(row._id).toLowerCase() === component.variantId);
    if (typeof component.name !== "string" || !component.name.trim()) {
      bundleInputError("Bundle component label is unavailable", "BUNDLE_PURCHASE_UNAVAILABLE", 409);
    }
    return { ...component, regularUnitPricePiastres: toPiastres(sku.price, "componentPrice") };
  });
  const allocations = allocate(included, card.sellingPricePiastres, card.originalPricePiastres);
  const snapshot = { id: groupId.toLowerCase(), bundleId: card.id.toLowerCase(), bundleRevision: card.revision,
    warehouseId: inventory.warehouseId, currency: "EGP", language, name: card.name, image: card.image, quantity,
    unitPricePiastres: card.sellingPricePiastres, originalUnitPricePiastres: card.originalPricePiastres, lineTotalPiastres,
    components: included.map((component, index) => ({ ...component, allocations: allocations[index] })) };
  const itemDrafts = snapshot.components.flatMap((component, index) => component.allocations.map(allocation => {
    const count = safe(BigInt(allocation.quantity) * BigInt(quantity));
    const amount = safe(BigInt(allocation.unitPricePiastres) * BigInt(count));
    return { product: component.productId, productType: component.productType, variantId: component.variantId,
      productName: component.name, productImageUrl: component.image,
      variantOptions: component.variantOptions.map(option => ({ ...option })), quantity: count,
      fulfillmentQuantity: count, finalizedUnavailableQuantity: 0, itemPricePiastres: allocation.unitPricePiastres,
      lineTotalPiastres: amount, itemPrice: fromPiastres(allocation.unitPricePiastres), lineTotal: fromPiastres(amount),
      promotion: null, promotionDiscountedPrice: null, bundleGroupId: snapshot.id, bundleComponentIndex: index };
  }));
  const allocated = itemDrafts.reduce((sum, item) => sum + BigInt(item.lineTotalPiastres), 0n);
  if (allocated !== BigInt(lineTotalPiastres)) bundleInputError("Bundle allocation is inconsistent", "BUNDLE_PURCHASE_INVALID", 409);
  return { snapshot, itemDrafts, inventory };
}
