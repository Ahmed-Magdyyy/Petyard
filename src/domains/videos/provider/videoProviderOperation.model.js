import { videoProviderOperationTypeEnum, videoProviderOperationStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const videoProviderOperationSchema = new Schema(
  {
    type: {
      type: String,
      enum: Object.values(videoProviderOperationTypeEnum),
      required: true,
      immutable: true,
    },
    assetId: { type: Schema.Types.ObjectId, ref: "VideoAsset",
      required() { return this.type !== videoProviderOperationTypeEnum.COVER_CLEANUP; }, immutable: true },
    libraryId: { type: String, required() { return this.type !== videoProviderOperationTypeEnum.COVER_CLEANUP; },
      trim: true, maxlength: 32, match: /^\d+$/, immutable: true },
    providerGuid: { type: String, required() { return this.type !== videoProviderOperationTypeEnum.COVER_CLEANUP; },
      trim: true, maxlength: 128, immutable: true },
    coverId: { type: Schema.Types.ObjectId, ref: "EditorialCover",
      required() { return this.type === videoProviderOperationTypeEnum.COVER_CLEANUP; }, immutable: true },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
    status: {
      type: String,
      enum: Object.values(videoProviderOperationStatusEnum),
      required: true,
      default: videoProviderOperationStatusEnum.PENDING,
    },
    failedAttempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    leaseToken: { type: String, trim: true, maxlength: 80 },
    leaseExpiresAt: { type: Date },
    activeTargetKey: { type: String, trim: true, maxlength: 180 },
    lastErrorCode: { type: String, trim: true, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
    lastErrorAt: { type: Date },
    lastEnqueueErrorCode: { type: String, trim: true, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
    lastEnqueueErrorAt: { type: Date },
    completedAt: { type: Date },
    purgeAt: { type: Date },
  },
  { timestamps: true, strict: "throw" },
);

videoProviderOperationSchema.pre("validate", function validateTarget() {
  if (this.type === videoProviderOperationTypeEnum.COVER_CLEANUP && (this.assetId || this.libraryId || this.providerGuid)) {
    this.invalidate("coverId", "Image cleanup cannot reference a Stream target");
  }
  if (this.type !== videoProviderOperationTypeEnum.COVER_CLEANUP && this.coverId) {
    this.invalidate("coverId", "Stream operations cannot reference a cover target");
  }
});

videoProviderOperationSchema.index({ dedupeKey: 1 }, { unique: true });
// Only a claimed operation has an activeTargetKey. MongoDB rejects a second
// concurrent lease for the same Stream target or cover, even across different jobs.
videoProviderOperationSchema.index({ activeTargetKey: 1 }, { unique: true, sparse: true });
videoProviderOperationSchema.index({ status: 1, nextAttemptAt: 1 });
videoProviderOperationSchema.index({ status: 1, leaseExpiresAt: 1 });
videoProviderOperationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const VideoProviderOperationModel = model(
  "VideoProviderOperation",
  videoProviderOperationSchema,
);
