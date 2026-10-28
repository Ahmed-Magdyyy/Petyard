import { buildBundlePurchaseSnapshot } from "./bundle.purchase-snapshot.js";
import { normalizeFixedBundleComponents, previewFixedBundle } from "./bundle.components.js";
import { bundleInputError } from "./bundle.draft-input.js";

// For bundle-containing carts only; ordinary pricing and persistence remain with their owning modules.
export function buildBundleCartPurchasePlan({ warehouseId, warehouse, products, ordinaryItems = [], bundles, language = "en" }) {
  if (!Array.isArray(ordinaryItems) || !Array.isArray(bundles) || !bundles.length) {
    bundleInputError("Bundle purchase inputs are required", "BUNDLE_PURCHASE_INVALID");
  }
  const purchases = bundles.map(entry => {
    if (!entry || entry.constructor !== Object) bundleInputError("Invalid saved bundle group", "BUNDLE_PURCHASE_INVALID");
    return buildBundlePurchaseSnapshot({ groupId: entry.groupId, bundle: entry.bundle, expectedRevision: entry.expectedRevision,
      quantity: entry.quantity, warehouseId, warehouse, products, language });
  });
  if (new Set(purchases.map(row => row.snapshot.id)).size !== purchases.length) {
    bundleInputError("Bundle group identifiers must be unique", "BUNDLE_PURCHASE_INVALID");
  }
  const ordinaryDemands = ordinaryItems.map(item => {
    if (!item || typeof item !== "object") bundleInputError("Invalid ordinary cart item", "BUNDLE_PURCHASE_INVALID");
    return { productId: String(item.product), productType: item.productType,
      variantId: item.variantId == null ? null : String(item.variantId), quantity: item.quantity };
  });
  const demands = normalizeFixedBundleComponents([...ordinaryDemands, ...purchases.flatMap(row => row.inventory.demands)]);
  const availability = previewFixedBundle({ components: demands, pricePiastres: 0, warehouseId, products });
  if (availability.availableBundles < 1) {
    bundleInputError("Combined cart quantities exceed stock in this warehouse", "BUNDLE_STOCK_CONFLICT", 409);
  }
  const bundleSubtotal = purchases.reduce((sum, row) => sum + BigInt(row.snapshot.lineTotalPiastres), 0n);
  if (bundleSubtotal > BigInt(Number.MAX_SAFE_INTEGER)) bundleInputError("Combined bundle amount is too large", "BUNDLE_PURCHASE_OVERFLOW", 409);
  return { warehouseId: availability.warehouseId, currency: "EGP", bundleSubtotalPiastres: Number(bundleSubtotal),
    groups: purchases.map(row => row.snapshot), itemDrafts: purchases.flatMap(row => row.itemDrafts), demands };
}
