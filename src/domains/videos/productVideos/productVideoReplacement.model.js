import { productVideoReplacementStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;
const schema = new Schema({
  productId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  videoId: { type: Schema.Types.ObjectId, ref: "ProductVideo", required: true, immutable: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  idempotencyKey: { type: String, required: true, maxlength: 128, immutable: true },
  requestFingerprint: { type: String, required: true, immutable: true },
  clientId: { type: String, required: true, maxlength: 100, immutable: true },
  safeFilename: { type: String, required: true, maxlength: 160, immutable: true },
  status: { type: String, enum: Object.values(productVideoReplacementStatusEnum), required: true },
  assetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  issuedAt: Date,
  abandonAt: Date,
  finishedAt: Date,
  failureCode: { type: String, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
}, { timestamps: true, strict: "throw" });
schema.index({ videoId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, abandonAt: 1 });
schema.index({ status: 1, updatedAt: 1 });
export const ProductVideoReplacementModel = model("ProductVideoReplacement", schema);
