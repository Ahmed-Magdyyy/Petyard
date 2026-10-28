import mongoose from "mongoose";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { assertVectorIndex } from "../shared/assistant.vector-index.js";
import { reject } from "../shared/assistant.errors.js";

const { Schema } = mongoose;
const schema = new Schema({
  _id: { type: String, required: true, match: /^(?:product:[a-f\d]{24}:(?:simple|[a-f\d]{24})|bundle:[a-f\d]{24})$/ },
  kind: { type: String, required: true, enum: ["product", "bundle"] },
  sourceId: { type: Schema.Types.ObjectId, required: true }, variantId: { type: Schema.Types.ObjectId, default: null },
  text: { type: String, required: true, validate: value => value.isWellFormed() && !value.includes("\u0000") && Buffer.byteLength(value) <= embeddingProfile.maxTextBytes },
  textHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
  warehouseIds: { type: [Schema.Types.ObjectId], required: true, validate: value => new Set(value.map(String)).size === value.length },
  model: { type: String, required: true, enum: [embeddingProfile.model] },
  dimensions: { type: Number, required: true, enum: [embeddingProfile.dimensions] },
  vector: { type: [Number], required: true, validate: value => value.length === embeddingProfile.dimensions && value.every(Number.isFinite) && value.some(number => number !== 0) },
  embeddingKey: { type: String, required: true, match: /^[a-f\d]{64}$/ }, checkedAt: { type: Date, required: true },
}, { strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ kind: 1, sourceId: 1 });
export const AssistantCatalogVector = mongoose.models.AssistantCatalogVector ?? mongoose.model("AssistantCatalogVector", schema);
export const catalogVectorIndex = Object.freeze({ name: "petyard_catalog_vector_v1", type: "vectorSearch",
  definition: Object.freeze({ fields: Object.freeze([
    Object.freeze({ type: "vector", path: "vector", numDimensions: embeddingProfile.dimensions, similarity: "cosine" }),
    ...["warehouseIds", "kind"].map(path => Object.freeze({ type: "filter", path })),
  ]) }) });
export async function assertCatalogVectorStore() {
  let indexes;
  try { indexes = await AssistantCatalogVector.collection.indexes(); } catch { reject("catalog_vector_store_unavailable", 503); }
  if (!indexes.some(row => JSON.stringify(row.key) === '{"_id":1}' && !row.partialFilterExpression && !row.sparse && (!row.collation || row.collation.locale === "simple")) ||
      !indexes.some(row => JSON.stringify(row.key) === '{"kind":1,"sourceId":1}' && !row.unique && !row.partialFilterExpression && !row.sparse &&
        (!row.collation || row.collation.locale === "simple")) || indexes.some(row => row.expireAfterSeconds !== undefined)) reject("catalog_vector_store_unavailable", 503);
}
export const assertCatalogVectorIndex = (collection = AssistantCatalogVector.collection) => assertVectorIndex(collection, catalogVectorIndex, "catalog_vector_index_unavailable");
