import mongoose from "mongoose";
import { reject } from "../shared/assistant.errors.js";

const { Schema } = mongoose;
const hash = { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ };
const referenceRequired = function () { return this.kind === undefined || this.kind === "reference"; };
const queryRequired = function () { return ["customer_query", "catalog_query"].includes(this.kind); };
const catalogRequired = function () { return this.kind === "catalog_offer"; };
const schema = new Schema({
  key: hash,
  // Immutable defaults must apply only to new documents, never while Mongoose hydrates saved receipts.
  kind: { type: String, enum: ["reference", "customer_query", "catalog_offer", "catalog_query"], immutable: true,
    default() { return this.isNew ? "reference" : undefined; }, required() { return this.isNew; } },
  reference: { type: Schema.Types.ObjectId, required: referenceRequired, immutable: true },
  owner: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sourceHash: { ...hash, required: referenceRequired }, manifestHash: { ...hash, required: referenceRequired }, batchHash: hash,
  start: { type: Number, required: referenceRequired, immutable: true, min: 0, max: 9999 },
  passageIds: { type: [String], required: referenceRequired, immutable: true, default: undefined },
  run: { type: Schema.Types.ObjectId, required: queryRequired, immutable: true },
  queryContextHash: { ...hash, required: queryRequired },
  sourceId: { type: Schema.Types.ObjectId, required: catalogRequired, immutable: true },
  offerId: { type: String, required: catalogRequired, immutable: true, maxlength: 90 },
  textHash: { ...hash, required: catalogRequired },
  vectorsExpireAt: { type: Date, required: queryRequired, immutable: true },
  model: { type: String, required: true, immutable: true },
  dimensions: { type: Number, required: true, immutable: true },
  config: { type: Schema.Types.Mixed, required: true, immutable: true },
  reservation: { type: Schema.Types.Mixed, required: true, immutable: true },
  accounting: { type: String, required: true, enum: ["reserved", "settled", "charged_reservation"] },
  status: { type: String, required: true, enum: ["dispatching", "completed", "failed", "uncertain"] },
  vectors: { type: [[Number]], default: undefined },
  projectedAt: Date,
  usage: Schema.Types.Mixed, chargedMicroUsd: Number,
  providerRequestId: { type: String, maxlength: 200 },
  failureCode: { type: String, maxlength: 80 },
  dispatchDeadline: { type: Date, immutable: true },
  reconciliation: { type: new Schema({
    resolution: { type: String, required: true, enum: ["charge_reserved"] },
    reason: { type: String, required: true, maxlength: 500 },
    actor: { type: Schema.Types.ObjectId, required: true }, at: { type: Date, required: true },
  }, { _id: false, strict: "throw" }), default: undefined },
}, { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ key: 1 }, { unique: true });
schema.index({ kind: 1, vectorsExpireAt: 1 });
export const AssistantEmbeddingBatch = mongoose.models.AssistantEmbeddingBatch ?? mongoose.model("AssistantEmbeddingBatch", schema);

export async function assertEmbeddingBatchStore() {
  let indexes;
  try { indexes = await AssistantEmbeddingBatch.collection.indexes(); } catch { reject("embedding_store_unavailable", 503); }
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"key":1}' && entry.unique === true &&
      !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
      indexes.some(entry => entry.expireAfterSeconds !== undefined)) reject("embedding_store_unavailable", 503);
}

export async function assertQueryEmbeddingStore() {
  await assertEmbeddingBatchStore();
  let indexes;
  try { indexes = await AssistantEmbeddingBatch.collection.indexes(); } catch { reject("embedding_store_unavailable", 503); }
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"kind":1,"vectorsExpireAt":1}' && entry.unique !== true &&
      !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple"))) reject("embedding_store_unavailable", 503);
}
