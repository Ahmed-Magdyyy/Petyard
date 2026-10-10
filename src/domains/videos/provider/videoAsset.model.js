import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const videoAssetSchema = new Schema(
  {
    ownerType: {
      type: String,
      enum: Object.values(videoAssetOwnerTypeEnum),
      required: true,
      immutable: true,
    },
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    libraryId: { type: String, required: true, trim: true, maxlength: 32, match: /^\d+$/, immutable: true },
    providerGuid: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
    // Server-created TUS resource, bound to this immutable provider generation.
    // No signature or authorization headers are persisted here.
    tusUploadUrl: { type: String, maxlength: 2048, match: /^https:\/\/video\.bunnycdn\.com\/tusupload\/[A-Za-z0-9_-]+$/ },
    tusResourceExpiresAt: { type: Number, min: 1, validate: Number.isSafeInteger },
    technicalState: {
      type: String,
      enum: Object.values(videoAssetTechnicalStateEnum),
      default: videoAssetTechnicalStateEnum.AWAITING_UPLOAD,
      required: true,
    },
    durationSeconds: { type: Number, min: 0 },
    width: { type: Number, min: 1 },
    height: { type: Number, min: 1 },
    providerStatus: { type: Number, min: 0 },
    availableResolutions: [{ type: String, trim: true, maxlength: 20 }],
    thumbnailFileName: { type: String, trim: true, maxlength: 160 },
    poster: {
      type: new Schema({
        public_id: { type: String, required: true, match: /^petyard\/video-posters\/[a-f\d]{24}$/ },
        url: { type: String, required: true, maxlength: 2048, match: /^https:\/\/[^?#]+\.webp$/ },
      }, { _id: false, strict: "throw" }),
      default: undefined,
    },
    posterRequestedAt: { type: Date },
    posterCopiedAt: { type: Date },
    safeFailureCode: { type: String, trim: true, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
    lastVerifiedAt: { type: Date },
    readyAt: { type: Date },
    deletionRequestedAt: { type: Date },
    deleteAcceptedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: "throw" },
);

videoAssetSchema.index({ libraryId: 1, providerGuid: 1 }, { unique: true });
videoAssetSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
videoAssetSchema.index({ technicalState: 1, updatedAt: 1 });
videoAssetSchema.index({ technicalState: 1, posterRequestedAt: 1, readyAt: 1 });

export const VideoAssetModel = model("VideoAsset", videoAssetSchema);
