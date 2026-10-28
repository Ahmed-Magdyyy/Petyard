import { ManualBundle } from "./bundle.model.js";
import { ProductModel } from "../product/product.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { bundleInputError } from "./bundle.draft-input.js";

export async function requireManualBundleStore() {
  let indexes;
  try {
    const rows = await ManualBundle.db.db.listCollections({ name: ManualBundle.collection.name }, { nameOnly: false, maxTimeMS: 5000 }).toArray();
    if (rows.length !== 1 || rows[0].type !== "collection" || rows[0].options?.capped || rows[0].options?.timeseries) throw new Error("Incompatible draft store");
    indexes = await ManualBundle.collection.indexes();
  }
  catch { bundleInputError("Manual bundle store is not ready", "BUNDLE_STORE_UNAVAILABLE", 503); }
  if (!indexes.some(index => index.name === "_id_" && JSON.stringify(index.key) === '{"_id":1}' && !index.partialFilterExpression &&
    !index.sparse && (!index.collation || index.collation.locale === "simple")) || indexes.some(index => index.expireAfterSeconds !== undefined)) {
    bundleInputError("Manual bundle store is not ready", "BUNDLE_STORE_UNAVAILABLE", 503);
  }
  return indexes;
}
export async function requireBundleCatalogStore() {
  const indexes = await requireManualBundleStore();
  if (!indexes.some(index => index.name === "manual_bundle_catalog_v1" &&
    JSON.stringify(index.key) === '{"origin":1,"status":1,"_id":-1}' &&
    !index.unique && !index.partialFilterExpression && !index.sparse && !index.hidden && (!index.collation || index.collation.locale === "simple"))) {
    bundleInputError("Bundle catalog store is not ready", "BUNDLE_STORE_UNAVAILABLE", 503);
  }
}
export const createManualBundle = values => ManualBundle.create(values);
export const findBundle = id => ManualBundle.findById(id).lean();
export const listManualBundles = (cursor, limit, status) => ManualBundle.find({ origin: { $in: ["manual", "ai"] }, status: status ?? { $in: ["draft", "published", "paused", "rejected"] }, ...(cursor ? { _id: { $lt: cursor } } : {}) })
  .sort({ _id: -1 }).limit(limit).lean();
export const updateManualBundle = (id, revision, status, values, origin = "manual") => ManualBundle.findOneAndUpdate(
  { _id: id, origin, status, revision }, { $set: values, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
export const deleteManualDraft = (id, revision) => ManualBundle.findOneAndDelete({ _id: id, origin: "manual", status: "draft", revision }).lean();
export const findBundleWarehouse = id => WarehouseModel.findById(id).select("_id active fulfillment").maxTimeMS(5000).lean();
export const findBundleWarehouses = ids => WarehouseModel.find({ _id: { $in: ids }, active: true }).select("_id active fulfillment").maxTimeMS(5000).lean();
export const findBundleProducts = (ids, warehouseId) => ProductModel.find({ _id: { $in: ids }, ...(warehouseId ? { isActive: true, $or: [
  { type: "SIMPLE", warehouseStocks: { $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } } } },
  { type: "VARIANT", variants: { $elemMatch: { warehouseStocks: { $elemMatch: { warehouse: warehouseId, quantity: { $gt: 0 } } } } } },
] } : {}) }).select("_id type isActive price name_en name_ar images warehouseStocks variants._id variants.price variants.images variants.options variants.warehouseStocks").maxTimeMS(5000).lean();

const customerFields = "_id origin aiEvidenceJson status revision name_en name_ar components pricePiastres";
export const listPublishedBundles = (cursor, limit) => ManualBundle.find({ origin: { $in: ["manual", "ai"] }, status: "published", ...(cursor ? { _id: { $lt: cursor } } : {}) })
  .select(customerFields).sort({ _id: -1 }).limit(limit).maxTimeMS(5000).lean();
export const findPublishedBundle = id => ManualBundle.findOne({ _id: id, origin: { $in: ["manual", "ai"] }, status: "published" })
  .select(customerFields).maxTimeMS(5000).lean();
