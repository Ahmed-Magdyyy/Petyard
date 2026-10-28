import mongoose from "mongoose";
import { isSafePiastres } from "../../shared/utils/money.js";

const { Schema } = mongoose;
const component = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  productType: { type: String, required: true, enum: ["SIMPLE", "VARIANT"] },
  variantId: { type: Schema.Types.ObjectId, default: null,
    required() { return this.productType === "VARIANT"; },
    validate(value) { return this.productType === "VARIANT" || value == null; } },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
}, { _id: false, strict: "throw" });
const schema = new Schema({
  origin: { type: String, required: true, default: "manual", enum: ["manual", "ai"], immutable: true },
  aiEvidenceJson: { type: String, maxlength: 131072, immutable: true, default: undefined,
    required() { return this.origin === "ai"; }, validate: value => value === undefined || validAiBundleEvidence(value) },
  status: { type: String, required: true, default: "draft", enum: ["draft", "published", "paused", "rejected"] },
  name_en: { type: String, required: true, trim: true, maxlength: 200 },
  name_ar: { type: String, default: "", trim: true, maxlength: 200 },
  desc_en: { type: String, default: "", trim: true, maxlength: 2000 },
  desc_ar: { type: String, default: "", trim: true, maxlength: 2000 },
  components: { type: [component], required: true, validate: value => value.length > 0 },
  pricePiastres: { type: Number, required: true, validate: isSafePiastres },
  revision: { type: Number, required: true, default: 1, min: 1, validate: Number.isSafeInteger },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, required() { return ["published", "paused"].includes(this.status); } },
  publishedAt: { type: Date, default: null, required() { return ["published", "paused"].includes(this.status); } },
  pausedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, required() { return this.status === "paused"; } },
  pausedAt: { type: Date, default: null, required() { return this.status === "paused"; } },
}, { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false, bufferCommands: false });

schema.index({ origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" });

export const ManualBundle = mongoose.models.ManualBundle ?? mongoose.model("ManualBundle", schema);

export function validAiBundleEvidence(value) {
  try {
    const evidence = JSON.parse(value);
    return evidence?.version === "petyard-bundle-selection-v1" && /^[a-f\d]{24}$/.test(evidence.runId) &&
      /^[a-f\d]{64}$/.test(evidence.signature) && Array.isArray(evidence.facts?.products) && evidence.facts.products.length >= 2 &&
      typeof evidence.modelExplanation?.fit_ar === "string" && typeof evidence.modelExplanation?.benefit_ar === "string";
  } catch { return false; }
}
export const supportedBundleOrigin = row => row?.origin === "manual" || row?.origin === "ai" && validAiBundleEvidence(row.aiEvidenceJson);
