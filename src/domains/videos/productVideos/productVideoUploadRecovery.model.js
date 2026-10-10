import { videoUploadRecoveryStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;
const schema = new Schema({
  productId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  videoId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  replacementId: { type: Schema.Types.ObjectId, immutable: true },
  previousAssetId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  previousActiveAssetId: { type: Schema.Types.ObjectId, immutable: true },
  actorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  idempotencyKey: { type: String, required: true, maxlength: 128, immutable: true },
  requestFingerprint: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  abandonAt: { type: Date, required: true, immutable: true },
  status: { type: String, required: true, enum: Object.values(videoUploadRecoveryStatusEnum) },
  cleanupOperationId: { type: Schema.Types.ObjectId, required: true },
  assetId: { type: Schema.Types.ObjectId },
  finishedAt: Date,
  expiredAt: Date,
  failureCode: { type: String, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
}, { timestamps: true, strict: "throw" });
schema.index({ videoId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, updatedAt: 1 });
schema.index({ abandonAt: 1, expiredAt: 1 });
export const ProductVideoUploadRecoveryModel = model("ProductVideoUploadRecovery", schema);
