import { productVideoUploadBatchStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const productVideoUploadBatchSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, immutable: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
  requestFingerprint: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  status: {
    type: String,
    enum: Object.values(productVideoUploadBatchStatusEnum),
    required: true,
    default: productVideoUploadBatchStatusEnum.RESERVING,
  },
  failureCode: { type: String, trim: true, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
  issuedAt: { type: Date },
  failedAt: { type: Date },
}, { timestamps: true, strict: "throw" });

productVideoUploadBatchSchema.index({ productId: 1, idempotencyKey: 1 }, { unique: true });
productVideoUploadBatchSchema.index({ status: 1, updatedAt: 1 });

export const ProductVideoUploadBatchModel = model(
  "ProductVideoUploadBatch", productVideoUploadBatchSchema,
);
