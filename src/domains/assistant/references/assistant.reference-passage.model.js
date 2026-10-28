import mongoose from "mongoose";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { reject } from "../shared/assistant.errors.js";
import { assertVectorIndex } from "../shared/assistant.vector-index.js";

const { Schema } = mongoose;
const hash = { type: String, required: true, match: /^[a-f\d]{64}$/ };
const schema = new Schema({
  _id: hash,
  reference: { type: Schema.Types.ObjectId, required: true },
  sourceHash: hash, manifestHash: hash, passageId: hash, batchKey: hash,
  model: { type: String, required: true, enum: [embeddingProfile.model] },
  dimensions: { type: Number, required: true, enum: [embeddingProfile.dimensions] },
  species: { type: [String], required: true, validate: value => value.length > 0 && value.length <= 10 },
  text: { type: String, required: true, validate: value => value.isWellFormed() && !value.includes("\u0000") && Buffer.byteLength(value) <= embeddingProfile.maxTextBytes },
  locator: { type: String, required: true, maxlength: 200 },
  unitIndex: { type: Number, required: true, min: 0, max: 1999 },
  startOffset: { type: Number, required: true, min: 0 }, endOffset: { type: Number, required: true, min: 1 },
  previousId: { type: String, default: null }, nextId: { type: String, default: null },
  vector: { type: [Number], required: true, validate: value => value.length === embeddingProfile.dimensions &&
    value.every(Number.isFinite) && value.some(number => number !== 0) },
}, { strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ batchKey: 1 });
export const AssistantReferencePassage = mongoose.models.AssistantReferencePassage ?? mongoose.model("AssistantReferencePassage", schema);

export const referenceVectorIndex = Object.freeze({ name: "petyard_reference_vector_v1", type: "vectorSearch",
  definition: Object.freeze({ fields: Object.freeze([
    Object.freeze({ type: "vector", path: "vector", numDimensions: embeddingProfile.dimensions, similarity: "cosine" }),
    ...["reference", "manifestHash", "species"].map(path => Object.freeze({ type: "filter", path })),
  ]) }),
});

export async function assertReferencePassageStore() {
  let indexes;
  try { indexes = await AssistantReferencePassage.collection.indexes(); } catch { reject("reference_passage_store_unavailable", 503); }
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"_id":1}' && !entry.partialFilterExpression && !entry.sparse &&
      (!entry.collation || entry.collation.locale === "simple")) ||
      !indexes.some(entry => JSON.stringify(entry.key) === '{"batchKey":1}' && entry.unique !== true && !entry.partialFilterExpression && !entry.sparse &&
        (!entry.collation || entry.collation.locale === "simple")) || indexes.some(entry => entry.expireAfterSeconds !== undefined)) {
    reject("reference_passage_store_unavailable", 503);
  }
}

// READY is a structural check only; it does not prove recent passages are searchable or approved.
export async function assertReferenceVectorIndex(collection = AssistantReferencePassage.collection) {
  return assertVectorIndex(collection, referenceVectorIndex, "reference_vector_index_unavailable");
}
