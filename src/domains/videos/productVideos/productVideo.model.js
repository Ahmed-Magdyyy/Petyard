import { productVideoLifecycleStateEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const productVideoSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, immutable: true },
  position: { type: Number, required: true, min: 0, immutable: true },
  uploadBatchId: { type: Schema.Types.ObjectId, ref: "ProductVideoUploadBatch", required: true, immutable: true },
  clientId: { type: String, required: true, trim: true, maxlength: 100, immutable: true },
  safeFilename: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
  showInReelsFeed: { type: Boolean, required: true, default: true },
  activeSlot: { type: Boolean, required: true, default: true },
  lifecycleState: {
    type: String,
    enum: Object.values(productVideoLifecycleStateEnum),
    required: true,
    default: productVideoLifecycleStateEnum.RESERVING,
  },
  activeAssetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  pendingAssetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  replacementId: { type: Schema.Types.ObjectId, ref: "ProductVideoReplacement" },
  uploadRecoveryId: { type: Schema.Types.ObjectId, ref: "ProductVideoUploadRecovery" },
  replacementFailureCode: { type: String, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
  uploadSessionIssuedAt: { type: Date },
  abandonAt: { type: Date },
  deletionRequestedAt: { type: Date },
  removedAt: { type: Date },
}, { timestamps: true, strict: "throw" });

productVideoSchema.index(
  { productId: 1, position: 1 },
  { unique: true, partialFilterExpression: { activeSlot: true } },
);
productVideoSchema.index({ productId: 1, uploadBatchId: 1, clientId: 1 }, { unique: true });
productVideoSchema.index({ productId: 1, lifecycleState: 1, position: 1 });
productVideoSchema.index({ abandonAt: 1, lifecycleState: 1 });
productVideoSchema.index({ activeSlot: 1, lifecycleState: 1, updatedAt: 1, _id: 1 });

export const ProductVideoModel = model("ProductVideo", productVideoSchema);
