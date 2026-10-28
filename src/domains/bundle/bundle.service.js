import * as repository from "./bundle.repository.js";
import { requireBundleSuperAdmin } from "./bundle.access.js";
import { bundleId, bundleInputError, bundleRevision, nextBundleRevision, exactBundleFields, normalizeManualDraft } from "./bundle.draft-input.js";
import { fromPiastres } from "../../shared/utils/money.js";
import { previewFixedBundle } from "./bundle.components.js";
import { isWarehouseOperational } from "../warehouse/warehouse.fulfillment.js";
import { bundleOriginalPricePiastres } from "./bundle.product-card.js";
import { supportedBundleOrigin } from "./bundle.model.js";

function manual(record) {
  if (!record) bundleInputError("Bundle not found", "BUNDLE_NOT_FOUND", 404);
  if (!supportedBundleOrigin(record) || !["draft", "published", "paused", ...(record.origin === "ai" ? ["rejected"] : [])].includes(record.status)) bundleInputError("Bundle provenance is unavailable", "BUNDLE_MANUAL_REQUIRED", 409);
  return record;
}
function dto(record) {
  const row = manual(record);
  return { id: String(row._id), origin: row.origin, status: row.status, revision: row.revision,
    name_en: row.name_en, name_ar: row.name_ar, desc_en: row.desc_en, desc_ar: row.desc_ar,
    currency: "EGP", pricePiastres: row.pricePiastres, price: fromPiastres(row.pricePiastres),
    components: row.components.map(component => ({ productId: String(component.productId), productType: component.productType,
      variantId: component.variantId == null ? null : String(component.variantId), quantity: component.quantity })),
    createdBy: String(row.createdBy), updatedBy: String(row.updatedBy), createdAt: row.createdAt, updatedAt: row.updatedAt,
    publishedBy: row.publishedBy == null ? null : String(row.publishedBy), publishedAt: row.publishedAt ?? null,
    pausedBy: row.pausedBy == null ? null : String(row.pausedBy), pausedAt: row.pausedAt ?? null,
    ...(row.origin === "ai" ? { aiEvidence: JSON.parse(row.aiEvidenceJson),
      aiEvidenceMatchesContents: sameContents(row.components, JSON.parse(row.aiEvidenceJson).facts.products) } : {}) };
}
function sameContents(left, right) {
  const normalize = rows => rows.map(row => ({ productId: String(row.productId), productType: row.productType,
    variantId: row.variantId == null ? null : String(row.variantId), quantity: row.quantity }))
    .sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
async function references(values, db) {
  const products = await db.findBundleProducts([...new Set(values.components.map(component => component.productId))]);
  for (const component of values.components) {
    const product = products.find(row => String(row._id) === component.productId);
    if (!product || product.type !== component.productType || component.productType === "VARIANT" &&
      (!Array.isArray(product.variants) || product.variants.filter(variant => String(variant?._id) === component.variantId).length !== 1)) {
      bundleInputError("A component product, type or variant is unavailable", "BUNDLE_COMPONENT_CHANGED", 409);
    }
  }
  return products;
}

export function createBundleManagementService(db = repository) {
  async function transition(actor, id, body, target) {
    const actorId = requireBundleSuperAdmin(actor), idValue = bundleId(id);
    exactBundleFields(body, ["expectedRevision"]); const revision = nextBundleRevision(body.expectedRevision);
    await db.requireManualBundleStore(); const row = manual(await db.findBundle(idValue));
    if (row.revision !== revision) bundleInputError("Bundle changed; refresh before changing availability", "BUNDLE_REVISION_CONFLICT", 409);
    if (target === "published" ? !["draft", "paused"].includes(row.status) : row.status !== "published") {
      bundleInputError("Bundle is not in a valid state for this action", "BUNDLE_STATE_CONFLICT", 409);
    }
    if (target === "published") {
      if (!Number.isSafeInteger(row.pricePiastres) || row.pricePiastres <= 0) {
        bundleInputError("Published bundle price must be positive", "BUNDLE_PUBLICATION_PRICE_REQUIRED", 409);
      }
      const components = dto(row).components;
      const products = await references({ ...row, components }, db);
      if (row.pricePiastres > bundleOriginalPricePiastres(components, products)) {
        bundleInputError("Bundle selling price exceeds its component original price", "BUNDLE_PRICE_CONFLICT", 409);
      }
      const candidates = [...new Set(products.flatMap(product => [...(Array.isArray(product.warehouseStocks) ? product.warehouseStocks : []),
        ...(Array.isArray(product.variants) ? product.variants.flatMap(variant => Array.isArray(variant?.warehouseStocks) ? variant.warehouseStocks : []) : [])])
        .map(stock => String(stock?.warehouse).toLowerCase()).filter(id => /^[a-f\d]{24}$/.test(id)))];
      const stocked = candidates.filter(warehouseId => previewFixedBundle({ components, pricePiastres: row.pricePiastres, warehouseId, products }).availableBundles > 0);
      if (!stocked.length) bundleInputError("No warehouse has enough stock of every bundle component", "BUNDLE_STOCK_UNAVAILABLE", 409);
      const warehouses = await db.findBundleWarehouses(stocked);
      if (!warehouses.some(warehouse => stocked.includes(String(warehouse._id).toLowerCase()) && isWarehouseOperational(warehouse))) {
        bundleInputError("No operational warehouse can supply this bundle", "BUNDLE_WAREHOUSE_UNAVAILABLE", 409);
      }
    }
    const values = { status: target, updatedBy: actorId,
      ...(target === "published" ? { publishedBy: actorId, publishedAt: new Date() } : { pausedBy: actorId, pausedAt: new Date() }) };
    const updated = await db.updateManualBundle(idValue, revision, row.status, values, row.origin);
    if (!updated) bundleInputError("Bundle changed; refresh before changing availability", "BUNDLE_REVISION_CONFLICT", 409);
    return { bundle: dto(updated) };
  }
  return {
    async create(actor, body) {
      const actorId = requireBundleSuperAdmin(actor), values = normalizeManualDraft(body);
      await db.requireManualBundleStore(); await references(values, db);
      return { bundle: dto(await db.createManualBundle({ ...values, origin: "manual", status: "draft", revision: 1, createdBy: actorId, updatedBy: actorId })) };
    },
    async get(actor, id) {
      requireBundleSuperAdmin(actor); const idValue = bundleId(id); await db.requireManualBundleStore();
      return { bundle: dto(await db.findBundle(idValue)) };
    },
    async list(actor, query) {
      requireBundleSuperAdmin(actor); exactBundleFields(query, ["cursor", "limit", "status"]);
      if (query.status !== undefined && !["draft", "published", "paused", "rejected"].includes(query.status)) bundleInputError("Invalid bundle status filter");
      const cursor = query.cursor === undefined ? null : bundleId(query.cursor);
      if (query.limit !== undefined && (typeof query.limit !== "string" || !/^\d+$/.test(query.limit))) bundleInputError("Invalid limit");
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) bundleInputError("Limit must be between 1 and 50");
      await db.requireManualBundleStore(); const rows = await db.listManualBundles(cursor, limit + 1, query.status);
      return { bundles: rows.slice(0, limit).map(dto), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null };
    },
    async replace(actor, id, body) {
      const actorId = requireBundleSuperAdmin(actor), idValue = bundleId(id), values = normalizeManualDraft(body, true);
      await db.requireManualBundleStore(); const row = manual(await db.findBundle(idValue));
      if (row.status === "published") bundleInputError("Pause the bundle before editing", "BUNDLE_PAUSE_REQUIRED", 409);
      await references(values, db);
      const updated = await db.updateManualBundle(idValue, body.expectedRevision, row.status, { ...values, updatedBy: actorId }, row.origin);
      if (!updated) bundleInputError("Bundle draft changed; refresh before editing", "BUNDLE_REVISION_CONFLICT", 409);
      return { bundle: dto(updated) };
    },
    async remove(actor, id, body) {
      requireBundleSuperAdmin(actor); const idValue = bundleId(id); exactBundleFields(body, ["expectedRevision"]);
      const revision = bundleRevision(body.expectedRevision); await db.requireManualBundleStore(); const row = manual(await db.findBundle(idValue));
      if (row.origin === "ai") bundleInputError("Reject the AI draft to preserve its evidence", "BUNDLE_REJECT_REQUIRED", 409);
      if (row.status !== "draft") bundleInputError("Only never-published drafts can be deleted; pause a published bundle", "BUNDLE_DELETE_DENIED", 409);
      if (!await db.deleteManualDraft(idValue, revision)) bundleInputError("Bundle draft changed; refresh before deleting", "BUNDLE_REVISION_CONFLICT", 409);
    },
    async reject(actor, id, body) {
      const actorId = requireBundleSuperAdmin(actor), idValue = bundleId(id);
      exactBundleFields(body, ["expectedRevision"]); const revision = nextBundleRevision(body.expectedRevision);
      await db.requireManualBundleStore(); const row = manual(await db.findBundle(idValue));
      if (row.origin !== "ai" || row.status !== "draft") bundleInputError("Only an unpublished AI draft can be rejected", "BUNDLE_STATE_CONFLICT", 409);
      const updated = await db.updateManualBundle(idValue, revision, "draft", { status: "rejected", updatedBy: actorId }, "ai");
      if (!updated) bundleInputError("Bundle changed; refresh before reviewing", "BUNDLE_REVISION_CONFLICT", 409);
      return { bundle: dto(updated) };
    },
    publish: (actor, id, body) => transition(actor, id, body, "published"),
    pause: (actor, id, body) => transition(actor, id, body, "paused"),
  };
}
export const bundleManagementService = createBundleManagementService();
