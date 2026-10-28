import * as repository from "./bundle.repository.js";
import { requireBundleUser } from "./bundle.access.js";
import { bundleId, bundleInputError, exactBundleFields } from "./bundle.draft-input.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";
import { buildBundleProductCard } from "./bundle.product-card.js";
import { isWarehouseOperational } from "../warehouse/warehouse.fulfillment.js";
import { supportedBundleOrigin } from "./bundle.model.js";

function request(query, listing) {
  exactBundleFields(query, listing ? ["warehouseId", "language", "limit", "cursor"] : ["warehouseId", "language"]);
  const warehouseId = bundleId(query.warehouseId);
  if (!["en", "ar"].includes(query.language)) bundleInputError("language must be en or ar");
  if (!listing) return { warehouseId, language: query.language };
  if (query.limit !== undefined && (typeof query.limit !== "string" || !/^\d+$/.test(query.limit))) bundleInputError("Invalid limit");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) bundleInputError("Limit must be between 1 and 50");
  return { warehouseId, language: query.language, limit, cursor: query.cursor === undefined ? null : bundleId(query.cursor) };
}

function eligibleDefinition(row) {
  if (!row || !supportedBundleOrigin(row) || row.status !== "published" ||
    !/^[a-f\d]{24}$/i.test(String(row._id)) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(row.components)) return null;
  try {
    return { ...row, components: normalizeFixedBundleComponents(row.components.map(component => ({ productId: String(component?.productId),
      productType: component?.productType, variantId: component?.variantId == null ? null : String(component.variantId), quantity: component?.quantity }))) };
  } catch (error) {
    if (error.code === "BUNDLE_INVALID_COMPONENTS") return null;
    throw error;
  }
}

function card(bundle, warehouse, products, lang) {
  try { return buildBundleProductCard({ bundle, warehouse, products, lang }); }
  catch (error) {
    if (["BUNDLE_COMPONENT_CHANGED", "BUNDLE_COMPONENT_PRICE_INVALID", "BUNDLE_INVALID_PRICE"].includes(error.code)) return null;
    throw error;
  }
}

export function createBundleCatalogService(db = repository) {
  async function warehouseFor(id) {
    await db.requireBundleCatalogStore();
    const warehouse = await db.findBundleWarehouse(id);
    if (!warehouse || String(warehouse._id).toLowerCase() !== id || !isWarehouseOperational(warehouse)) {
      bundleInputError("Selected warehouse is unavailable; refresh your delivery area", "BUNDLE_WAREHOUSE_UNAVAILABLE", 409);
    }
    return warehouse;
  }
  async function productsFor(rows, warehouseId) {
    const ids = [...new Set(rows.flatMap(row => row.components.map(component => component.productId)))];
    return ids.length ? db.findBundleProducts(ids, warehouseId) : [];
  }
  return {
    async list(actor, query) {
      requireBundleUser(actor); const input = request(query, true), warehouse = await warehouseFor(input.warehouseId);
      const rows = await db.listPublishedBundles(input.cursor, input.limit + 1);
      const scanned = rows.slice(0, input.limit), eligible = scanned.map(eligibleDefinition).filter(Boolean);
      const products = await productsFor(eligible, input.warehouseId);
      return { bundles: eligible.map(row => card(row, warehouse, products, input.language)).filter(Boolean),
        nextCursor: rows.length > input.limit ? bundleId(String(scanned[scanned.length - 1]._id)) : null };
    },
    async get(actor, id, query) {
      requireBundleUser(actor); const input = request(query, false), idValue = bundleId(id), warehouse = await warehouseFor(input.warehouseId);
      const row = eligibleDefinition(await db.findPublishedBundle(idValue));
      const result = row && String(row._id).toLowerCase() === idValue ? card(row, warehouse, await productsFor([row], input.warehouseId), input.language) : null;
      if (!result) bundleInputError("Bundle is unavailable in the selected warehouse", "BUNDLE_NOT_FOUND", 404);
      return { bundle: result };
    },
  };
}
export const bundleCatalogService = createBundleCatalogService();
