import { normalizeFixedBundleComponents, previewFixedBundle } from "./bundle.components.js";
import { bundleInputError } from "./bundle.draft-input.js";
import { toPiastres, fromPiastres } from "../../shared/utils/money.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { isWarehouseOperational } from "../warehouse/warehouse.fulfillment.js";
import { supportedBundleOrigin } from "./bundle.model.js";

function exactSku(component, products) {
  if (!Array.isArray(products)) bundleInputError("Backend product snapshots are required", "BUNDLE_INVALID_SOURCE", 503);
  const matches = products.filter(row => String(row?._id).toLowerCase() === component.productId);
  const product = matches[0];
  if (matches.length !== 1 || product.type !== component.productType) bundleInputError("Bundle component changed", "BUNDLE_COMPONENT_CHANGED", 409);
  if (component.productType === "SIMPLE") return { product, sku: product };
  const variants = (Array.isArray(product.variants) ? product.variants : []).filter(row => String(row?._id).toLowerCase() === component.variantId);
  if (variants.length !== 1) bundleInputError("Bundle variant changed", "BUNDLE_COMPONENT_CHANGED", 409);
  return { product, sku: variants[0] };
}

export function bundleOriginalPricePiastres(components, products) {
  let total = 0n;
  for (const component of normalizeFixedBundleComponents(components)) {
    const { sku } = exactSku(component, products);
    let unitPrice;
    try { unitPrice = toPiastres(sku.price, "componentPrice"); }
    catch { bundleInputError("Bundle component price is unavailable", "BUNDLE_COMPONENT_PRICE_INVALID", 409); }
    total += BigInt(unitPrice) * BigInt(component.quantity);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) bundleInputError("Bundle original price is too large", "BUNDLE_COMPONENT_PRICE_INVALID", 409);
  }
  return Number(total);
}

function image(product, sku) {
  const rows = Array.isArray(sku.images) && sku.images.length ? sku.images : Array.isArray(product.images) ? product.images : [];
  return rows.find(row => row.isMain)?.url || rows[0]?.url || null;
}

// Customer projection only. Management's editable price is the fixed selling price.
export function buildBundleProductCard({ bundle, warehouse, products, lang = "en" }) {
  if (!bundle || !supportedBundleOrigin(bundle) || bundle.status !== "published" || !isWarehouseOperational(warehouse)) return null;
  const components = bundle.components.map(row => ({ productId: String(row.productId), productType: row.productType,
    variantId: row.variantId == null ? null : String(row.variantId), quantity: row.quantity }));
  const availability = previewFixedBundle({ components, pricePiastres: bundle.pricePiastres, warehouseId: String(warehouse._id), products });
  if (availability.availableBundles < 1 || bundle.pricePiastres <= 0) return null;
  const original = bundleOriginalPricePiastres(components, products);
  // A changed component price must never turn a discount card into an overcharge.
  if (bundle.pricePiastres > original) return null;
  const language = lang === "ar" ? "ar" : "en";
  const included = availability.components.map(component => {
    const { product, sku } = exactSku(component, products);
    return { ...component, name: pickLocalizedField(product, "name", language), image: image(product, sku),
      variantOptions: component.productType === "VARIANT" && Array.isArray(sku.options)
        ? sku.options.map(option => ({ name: option.name, value: option.value })) : [] };
  });
  return { id: String(bundle._id), slug: null, name: pickLocalizedField(bundle, "name", language), type: "BUNDLE", isActive: true,
    category: null, subcategory: null, brand: null, price: fromPiastres(original), discountedPrice: fromPiastres(bundle.pricePiastres),
    promotion: null, stock: availability.availableBundles, inStock: true, image: included.find(row => row.image)?.image ?? null,
    hasVariants: false, ratingAverage: 0, ratingCount: 0, currency: "EGP", warehouseId: availability.warehouseId,
    revision: bundle.revision, originalPricePiastres: original, sellingPricePiastres: bundle.pricePiastres, components: included };
}
