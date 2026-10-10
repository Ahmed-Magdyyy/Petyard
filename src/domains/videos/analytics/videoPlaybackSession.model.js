import { videoContentKindEnum, videoIdentityTypeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const playbackSessionSchema = new Schema({
  _id: { type: String, required: true },
  kind: { type: String, enum: Object.values(videoContentKindEnum), required: true, immutable: true },
  contentId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  identityType: { type: String, enum: Object.values(videoIdentityTypeEnum), required: true, immutable: true, select: false },
  identityId: { type: String, required: true, maxlength: 256, immutable: true, select: false },
  assetId: { type: Schema.Types.ObjectId, immutable: true,
    required() { return this.kind !== videoContentKindEnum.YOUTUBE; } },
  uploadSessionId: { type: Schema.Types.ObjectId, immutable: true,
    required() { return this.kind === videoContentKindEnum.REEL; } },
  youtubeId: { type: String, match: /^[A-Za-z0-9_-]{11}$/, immutable: true,
    required() { return this.kind === videoContentKindEnum.YOUTUBE; } },
  durationSeconds: { type: Number, min: 0, max: 90, default: null, immutable: true },
  issuedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  revision: { type: Number, min: 0, default: 0 },
  eventCount: { type: Number, min: 0, max: 500, default: 0 },
  countedTypes: { type: [String], default: [] },
  lastOccurredAt: { type: Date },
  watchTimeMs: { type: Number, min: 0, default: 0 },
  playStartedAt: { type: Date },
  lastPlaybackIntervalEndAt: { type: Date },
}, { strict: "throw" });

// Expiry is enforced by the service; asynchronous TTL removal is only cleanup.
playbackSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VideoPlaybackSessionModel = model("VideoPlaybackSession", playbackSessionSchema);
