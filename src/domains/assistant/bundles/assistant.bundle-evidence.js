import { DateTime } from "luxon";
import { ProductModel } from "../../product/product.model.js";
import { OrderModel } from "../../order/order.model.js";
import { WarehouseModel } from "../../warehouse/warehouse.model.js";
import { buildFinalFulfillmentQuantityExpression } from "../../order/order.fulfillment.js";
import { previewFixedBundle } from "../../bundle/bundle.components.js";
import { bundleOriginalPricePiastres } from "../../bundle/bundle.product-card.js";
import { isWarehouseOperational } from "../../warehouse/warehouse.fulfillment.js";
import { reject } from "../shared/assistant.errors.js";

export const BUNDLE_SELECTION_VERSION = "petyard-bundle-selection-v1";
const id = value => /^[a-f\d]{24}$/.test(String(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const key = (productId, variantId) => `${productId}:${variantId ?? "simple"}`;
const unavailable = () => reject("bundle_evidence_unavailable", 503);

export function bundleEvidenceWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailable();
  const end = DateTime.fromJSDate(now, { zone: "Africa/Cairo" });
  return { timezone: "Africa/Cairo", start: end.minus({ days: 90 }).toUTC().toISO(),
    recentStart: end.minus({ days: 30 }).toUTC().toISO(), endExclusive: end.toUTC().toISO(),
    earlierDays: 60, recentDays: 30 };
}

export function bundleSalesStages(period) {
  const quantity = buildFinalFulfillmentQuantityExpression();
  const valid = { $cond: [{ $isNumber: quantity }, { $and: [
    { $gte: [quantity, 0] }, { $lte: [quantity, Number.MAX_SAFE_INTEGER] }, { $eq: [quantity, { $trunc: quantity }] },
  ] }, false] };
  return [
    { $match: { status: "delivered", createdAt: { $gte: new Date(period.start), $lt: new Date(period.endExclusive) } } },
    { $unwind: "$items" },
    { $group: { _id: { productId: "$items.product", productType: "$items.productType", variantId: { $ifNull: ["$items.variantId", null] } },
      earlierUnits: { $sum: { $cond: [{ $and: [valid, { $lt: ["$createdAt", new Date(period.recentStart)] }] }, quantity, 0] } },
      recentUnits: { $sum: { $cond: [{ $and: [valid, { $gte: ["$createdAt", new Date(period.recentStart)] }] }, quantity, 0] } },
      invalidRows: { $sum: { $cond: [valid, 0, 1] } } } },
    { $limit: 100001 },
  ];
}

// Read only. Limits reject incomplete input rather than turn a truncated scan into zero sales.
export async function readBundleEvidence(now = new Date()) {
  const period = bundleEvidenceWindow(now);
  try {
    for (const model of [ProductModel, WarehouseModel, OrderModel]) {
      const rows = await model.db.db.listCollections({ name: model.collection.name }, { nameOnly: false, maxTimeMS: 5000 }).toArray();
      if (rows.length !== 1 || rows[0].type !== "collection" || rows[0].options?.capped || rows[0].options?.timeseries) unavailable();
    }
  } catch { unavailable(); }
  const [products, warehouses, sales] = await Promise.all([
    ProductModel.find({ isActive: true, type: { $in: ["SIMPLE", "VARIANT"] } })
      .select("_id type isActive name_en name_ar desc_en desc_ar category subcategory tags createdAt price warehouseStocks variants._id variants.price variants.options variants.warehouseStocks")
      .sort({ _id: 1 }).limit(2001).maxTimeMS(5000).lean(),
    WarehouseModel.find({ active: true }).select("_id name code active fulfillment").sort({ _id: 1 }).limit(101).maxTimeMS(5000).lean(),
    OrderModel.aggregate(bundleSalesStages(period)).option({ maxTimeMS: 5000 }),
  ]);
  if (products.length > 2000 || warehouses.length > 100 || sales.length > 100000) unavailable();
  return buildBundleEvidence({ products, warehouses, sales, now, capturedAt: new Date() });
}

export function buildBundleEvidence({ products, warehouses, sales, now = new Date(), capturedAt = now }) {
  const period = bundleEvidenceWindow(now);
  if (!(capturedAt instanceof Date) || !Number.isFinite(capturedAt.getTime()) || capturedAt < now) unavailable();
  if (![products, warehouses, sales].every(Array.isArray)) unavailable();
  const warehouseIds = new Set(), productIds = new Set(), recorded = new Map();
  const operational = warehouses.filter(warehouse => {
    if (!id(warehouse?._id) || warehouseIds.has(String(warehouse._id))) unavailable();
    warehouseIds.add(String(warehouse._id));
    return isWarehouseOperational(warehouse);
  });
  for (const row of sales) {
    const ref = row?._id;
    if (!id(ref?.productId) || !["SIMPLE", "VARIANT"].includes(ref.productType) ||
        (ref.productType === "SIMPLE" ? ref.variantId != null : !id(ref.variantId)) ||
        !count(row.earlierUnits) || !count(row.recentUnits) || row.invalidRows !== 0 ||
        !count(row.earlierUnits + row.recentUnits)) unavailable();
    const skuKey = key(String(ref.productId), ref.variantId == null ? null : String(ref.variantId));
    if (recorded.has(skuKey)) unavailable();
    recorded.set(skuKey, { ...row, productType: ref.productType });
  }
  const offers = [];
  for (const product of products) {
    if (!id(product?._id) || productIds.has(String(product._id))) unavailable();
    productIds.add(String(product._id));
    if (product.isActive !== true || !["SIMPLE", "VARIANT"].includes(product.type)) continue;
    const createdAt = product.createdAt instanceof Date ? product.createdAt : new Date(product.createdAt ?? NaN);
    const validAge = Number.isFinite(createdAt.getTime()) && createdAt <= capturedAt;
    const productAgeDays = validAge ? Math.floor(DateTime.fromJSDate(capturedAt, { zone: period.timezone })
      .diff(DateTime.fromJSDate(createdAt, { zone: period.timezone }), "days").days) : null;
    const historyEligible = validAge && createdAt <= new Date(period.start);
    const variants = product.type === "SIMPLE" ? [null] : Array.isArray(product.variants) ? product.variants : [];
    const seenVariants = new Set();
    for (const variant of variants) {
      const variantId = variant == null ? null : String(variant._id);
      if (variant != null && (!id(variantId) || seenVariants.has(variantId))) unavailable();
      seenVariants.add(variantId);
      const component = { productId: String(product._id), productType: product.type, variantId, quantity: 1 };
      const availability = operational.map(warehouse => ({ warehouseId: String(warehouse._id),
        availableUnits: previewFixedBundle({ components: [component], pricePiastres: 0, warehouseId: String(warehouse._id), products: [product] }).availableBundles }));
      if (!availability.some(row => row.availableUnits > 0)) continue;
      const skuKey = key(component.productId, variantId), metric = recorded.get(skuKey);
      if (metric && metric.productType !== product.type) unavailable();
      let originalUnitPricePiastres;
      try { originalUnitPricePiastres = bundleOriginalPricePiastres([component], [product]); }
      catch (error) { if (error.code === "BUNDLE_COMPONENT_PRICE_INVALID") continue; throw error; }
      const earlierUnits = metric?.earlierUnits ?? 0, recentUnits = metric?.recentUnits ?? 0;
      offers.push({ key: skuKey, ...component, name_en: String(product.name_en ?? ""), name_ar: String(product.name_ar ?? ""),
        desc_en: String(product.desc_en ?? ""), desc_ar: String(product.desc_ar ?? ""),
        categoryId: product.category == null ? null : String(product.category), subcategoryId: product.subcategory == null ? null : String(product.subcategory),
        tags: Array.isArray(product.tags) ? product.tags.filter(tag => typeof tag === "string") : [],
        variantOptions: variant == null ? [] : (variant.options ?? []).map(({ name, value }) => ({ name, value })),
        createdAt: validAge ? createdAt.toISOString() : null, productAgeDays, historyEligible,
        // Variant age is not recorded; parent-product age cannot establish a variant's full sales opportunity.
        variantHistoryVerified: product.type === "SIMPLE", earlierUnits, recentUnits,
        earlierUnitsPerDay: earlierUnits / 60, recentUnitsPerDay: recentUnits / 30,
        totalUnits: earlierUnits + recentUnits, originalUnitPricePiastres, availability });
    }
  }
  return { version: BUNDLE_SELECTION_VERSION, period, capturedAt: capturedAt.toISOString(),
    metric: "fulfilled_units_in_currently_delivered_orders_created_in_window_including_bundle_components",
    coverage: { consistency: "independent_reads", history: "retained_records_only", stockHistory: "unverified", coPurchases: "not_analyzed",
      demand: "unverified", seasonality: "not_adjusted", variantAge: "not_recorded" },
    warehouses: operational.map(row => ({ id: String(row._id), name: String(row.name ?? ""), code: String(row.code ?? "") })), offers };
}

export function bundleEvidenceForComponents(evidence, components) {
  const offers = components.map(component => {
    const offer = evidence.offers.find(row => row.key === key(component.productId, component.variantId));
    if (!offer || offer.productType !== component.productType || !Number.isSafeInteger(component.quantity) || component.quantity < 1) unavailable();
    return { ...offer, quantity: component.quantity };
  });
  const warehouses = evidence.warehouses.map(warehouse => ({ ...warehouse,
    availableBundles: Math.min(...offers.map(offer => Math.floor(
      (offer.availability.find(row => row.warehouseId === warehouse.id)?.availableUnits ?? 0) / offer.quantity))) }));
  const original = offers.reduce((total, offer) => total + BigInt(offer.originalUnitPricePiastres) * BigInt(offer.quantity), 0n);
  if (!offers.length || original > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
  return { version: evidence.version, period: evidence.period, capturedAt: evidence.capturedAt, metric: evidence.metric, coverage: evidence.coverage,
    originalPricePiastres: Number(original), currency: "EGP", products: offers, warehouses };
}
