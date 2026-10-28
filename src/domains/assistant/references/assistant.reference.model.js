import mongoose from "mongoose";
import { reject } from "../shared/assistant.errors.js";

const { Schema } = mongoose;
const schema = new Schema({
  sha256: { type: String, required: true, immutable: true, match: /^[a-f\d]{64}$/ },
  creator: { type: Schema.Types.ObjectId, required: true, immutable: true },
  title: { type: String, required: true, maxlength: 200, immutable: true },
  authors: { type: String, maxlength: 500, default: "", immutable: true },
  edition: { type: String, maxlength: 80, default: "", immutable: true },
  sourceUrl: { type: String, maxlength: 2000, default: "", immutable: true },
  species: { type: [String], required: true, immutable: true, validate: value => value.length > 0 && value.length <= 10 },
  filename: { type: String, required: true, immutable: true, maxlength: 255 },
  format: { type: String, required: true, immutable: true, enum: ["pdf", "docx", "md", "txt"] },
  bytes: { type: Number, required: true, immutable: true, min: 1 },
  status: { type: String, required: true, enum: ["processing", "needs_review", "ready", "failed", "disabled"] },
  stage: { type: String, required: true, enum: ["uploading", "queued", "extracting", "awaiting_index", "awaiting_search", "awaiting_approval", "ready", "failed", "disabled"] },
  version: { type: Number, required: true, min: 1 },
  sourceStored: { type: Boolean, default: false },
  lease: String, leaseUntil: Date,
  extractionKey: String, extractionHash: String,
  passageKey: String, passageHash: String, passageVersion: String, passageCount: Number,
  embeddingFence: { type: Number, default: 0 },
  retrievalFence: { type: Number, default: 0 },
  storedPassageCount: { type: Number, default: 0, min: 0, max: 10000 },
  indexingBlocked: { type: Boolean, default: false }, indexingRetryAt: Date,
  searchVerification: { type: new Schema({
    model: { type: String, default: undefined }, dimensions: { type: Number, default: undefined },
    manifestHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    indexId: { type: String, required: true, maxlength: 200 }, indexName: { type: String, required: true, maxlength: 200 },
    indexVersion: { type: Number, required: true, min: 0 }, passageCount: { type: Number, required: true, min: 1, max: 10000 },
    verifiedAt: { type: Date, required: true },
  }, { _id: false, strict: "throw" }), default: undefined },
  activation: { type: new Schema({
    manifestHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    sourceHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    actor: { type: Schema.Types.ObjectId, required: true }, at: { type: Date, required: true },
    reviewedVersion: { type: Number, required: true, min: 1 },
  }, { _id: false, strict: "throw" }), default: undefined },
  preview: { type: String, maxlength: 4000, default: "" },
  unitCount: Number, textBytes: Number,
  warnings: { type: [new Schema({ code: { type: String, required: true, maxlength: 80 }, count: Number }, { _id: false, strict: "throw" })], default: [] },
  failureCode: String,
  disabledBy: Schema.Types.ObjectId,
}, { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ sha256: 1 }, { unique: true });
schema.index({ status: 1, stage: 1, leaseUntil: 1 });
export const AssistantReference = mongoose.models.AssistantReference ?? mongoose.model("AssistantReference", schema);

// Setup is separately authorized; requests and workers never create collections/indexes.
export async function assertReferenceStore() {
  let indexes;
  try { indexes = await AssistantReference.collection.indexes(); } catch { reject("reference_store_unavailable", 503); }
  if (!indexes.some(entry => JSON.stringify(entry.key) === '{"sha256":1}' && entry.unique === true &&
      !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
      indexes.some(entry => entry.expireAfterSeconds !== undefined)) reject("reference_store_unavailable", 503);
}
