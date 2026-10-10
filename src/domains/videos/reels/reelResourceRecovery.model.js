import { videoUploadRecoveryStatusEnum, reelUploadPurposeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;
const schema = new Schema({
  videoId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  sessionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  purpose: { type: String, enum: Object.values(reelUploadPurposeEnum), required: true, immutable: true },
  previousAssetId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  idempotencyKey: { type: String, required: true, minlength: 8, maxlength: 128, immutable: true },
  requestFingerprint: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  abandonAt: { type: Date, required: true, immutable: true },
  status: { type: String, required: true, enum: Object.values(videoUploadRecoveryStatusEnum) },
  cleanupOperationId: { type: Schema.Types.ObjectId, required: true },
  assetId: Schema.Types.ObjectId,
  finishedAt: Date,
  expiredAt: Date,
  failureCode: { type: String, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
}, { timestamps: true, strict: "throw" });
schema.index({ sessionId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, updatedAt: 1 });
schema.index({ abandonAt: 1, expiredAt: 1 });
export const ReelResourceRecoveryModel = model("ReelResourceRecovery", schema);
