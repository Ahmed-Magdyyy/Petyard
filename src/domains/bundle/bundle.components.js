import { ApiError } from "../../shared/utils/ApiError.js";
import { assertPiastres } from "../../shared/utils/money.js";
import { aggregateInventoryDemands } from "../inventory/inventory.service.js";

const id = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
function invalid(message, code = "BUNDLE_INVALID_COMPONENTS", status = 400) {
  const error = new ApiError(message, status); error.code = code; throw error;
}

export function normalizeFixedBundleComponents(components) {
  if (!Array.isArray(components) || !components.length) invalid("Bundle components are required");
  const demands = components.map(component => {
    if (!component || component.constructor !== Object || Object.keys(component).some(key =>
      !["productId", "productType", "variantId", "quantity"].includes(key)) || !id(component.productId) ||
      !["SIMPLE", "VARIANT"].includes(component.productType) || !Number.isSafeInteger(component.quantity) || component.quantity < 1 ||
      (component.productType === "VARIANT" ? !id(component.variantId) : component.variantId != null)) {
      invalid("Each bundle component needs an exact product, type, variant when applicable, and positive integer quantity");
    }
    return { productId: component.productId.toLowerCase(), productType: component.productType,
      variantId: component.variantId?.toLowerCase() ?? null, quantity: component.quantity };
  });
  return aggregateInventoryDemands(demands).map(({ productId, productType, variantId, quantity }) => {
    if (!Number.isSafeInteger(quantity)) invalid("Combined bundle component quantity is too large");
    return { productId, productType, variantId, quantity };
  });
}

function quantityHere(component, product, warehouseId) {
  if (!product || product.isActive !== true || product.type !== component.productType) return 0;
  let source = product;
  if (component.productType === "VARIANT") {
    const variants = (Array.isArray(product.variants) ? product.variants : []).filter(row => String(row?._id).toLowerCase() === component.variantId);
    if (variants.length !== 1) return 0;
    source = variants[0];
  }
  const rows = (Array.isArray(source.warehouseStocks) ? source.warehouseStocks : []).filter(row =>
    String(row?.warehouse).toLowerCase() === warehouseId);
  // Legacy duplicate rows cannot establish a single authoritative stock count.
  return rows.length === 1 && Number.isSafeInteger(rows[0].quantity) && rows[0].quantity >= 0 ? rows[0].quantity : 0;
}

// Internal estimate from backend-loaded products. Purchase must revalidate and reserve through the inventory domain.
export function previewFixedBundle({ components, pricePiastres, warehouseId, products }) {
  const normalized = normalizeFixedBundleComponents(components);
  if (!id(warehouseId)) invalid("An exact warehouse is required", "BUNDLE_INVALID_WAREHOUSE");
  try { assertPiastres(pricePiastres, "bundlePricePiastres"); }
  catch { invalid("Bundle price must be non-negative integer piastres", "BUNDLE_INVALID_PRICE"); }
  if (!Array.isArray(products)) invalid("Backend product snapshots are required", "BUNDLE_INVALID_SOURCE", 503);
  const byId = new Map();
  for (const product of products) {
    const productId = String(product?._id).toLowerCase();
    if (!id(productId) || byId.has(productId)) invalid("Backend product snapshots are ambiguous", "BUNDLE_INVALID_SOURCE", 503);
    byId.set(productId, product);
  }
  const warehouse = warehouseId.toLowerCase();
  const availableBundles = normalized.reduce((available, component) => Math.min(available, Math.floor(
    quantityHere(component, byId.get(component.productId), warehouse) / component.quantity)), Number.MAX_SAFE_INTEGER);
  return { warehouseId: warehouse, currency: "EGP", pricePiastres, components: normalized, availableBundles };
}
