import { reelUploadSessionStatusEnum, reelUploadPurposeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const reelUploadSessionSchema = new Schema({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, immutable: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  purpose: { type: String, enum: Object.values(reelUploadPurposeEnum), default: reelUploadPurposeEnum.INITIAL, immutable: true },
  previousAssetId: { type: Schema.Types.ObjectId, ref: "VideoAsset", immutable: true,
    required() { return this.purpose === reelUploadPurposeEnum.REPLACEMENT; } },
  autoApplyWhenReady: { type: Boolean, default: false, immutable: true },
  idempotencyKey: { type: String, required: true, minlength: 8, maxlength: 128, immutable: true },
  requestFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  // Persisted before Bunny creation so a lost create response can be searched
  // without guessing which provider video belongs to this reservation.
  providerTitle: { type: String, match: /^petyard-reel-session:[a-f\d]{24}$/,
    immutable: true },
  safeFilename: { type: String, required: true, maxlength: 160, immutable: true,
    validate: { validator: (value) => !/[\\/\x00-\x1F]/.test(value),
      message: "safeFilename must not contain a path or control characters" } },
  mimeType: { type: String, enum: ["video/mp4", "video/quicktime"], required: true, immutable: true },
  sizeBytes: { type: Number, min: 1, max: 250 * 1024 * 1024, required: true,
    validate: Number.isSafeInteger, immutable: true },
  status: { type: String, enum: Object.values(reelUploadSessionStatusEnum), required: true },
  assetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  uploadRecoveryId: { type: Schema.Types.ObjectId, ref: "ReelResourceRecovery" },
  issuedAt: { type: Date },
  appliedAt: { type: Date },
  abandonAt: { type: Date },
  failedAt: { type: Date },
  failureCode: { type: String, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
}, { timestamps: true, strict: "throw" });

reelUploadSessionSchema.index({ videoId: 1, idempotencyKey: 1 }, { unique: true });
reelUploadSessionSchema.index({ status: 1, updatedAt: 1 });

export const ReelUploadSessionModel = model("ReelUploadSession", reelUploadSessionSchema);
