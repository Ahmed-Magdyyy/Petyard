import { videoAssetOwnerTypeEnum, videoUploadAttemptStageEnum, videoUploadAttemptOutcomeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const videoUploadAttemptSchema = new Schema(
  {
    ownerType: { type: String, enum: Object.values(videoAssetOwnerTypeEnum), required: true },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
    safeFilename: {
      type: String,
      trim: true,
      maxlength: 160,
      validate: {
        validator: (value) => value == null || (!/[\\/\x00-\x1F]/.test(value) && value !== ".."),
        message: "safeFilename must not contain a path or control characters",
      },
    },
    stage: {
      type: String,
      enum: Object.values(videoUploadAttemptStageEnum),
      required: true,
    },
    outcome: {
      type: String,
      enum: Object.values(videoUploadAttemptOutcomeEnum),
      required: true,
    },
    errorCode: { type: String, trim: true, maxlength: 64, match: /^[A-Z][A-Z0-9_]{0,63}$/ },
    finishedAt: { type: Date },
    purgeAt: { type: Date, required: true, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true, strict: "throw" },
);

videoUploadAttemptSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
videoUploadAttemptSchema.index({ actorId: 1, createdAt: -1 });
videoUploadAttemptSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const VideoUploadAttemptModel = model("VideoUploadAttempt", videoUploadAttemptSchema);
