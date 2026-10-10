import { videoIdentityTypeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const videoSaveSchema = new Schema({
  identityType: { type: String, enum: Object.values(videoIdentityTypeEnum), required: true, immutable: true },
  identityId: { type: String, required: true, immutable: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, immutable: true },
  savedAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { strict: "throw" });

videoSaveSchema.index({ identityType: 1, identityId: 1, videoId: 1 }, { unique: true });
videoSaveSchema.index({ identityType: 1, identityId: 1, savedAt: -1, _id: -1 });
videoSaveSchema.index({ videoId: 1 });

export const VideoSaveModel = model("VideoSave", videoSaveSchema);
