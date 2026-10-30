import { videoContentKindEnum, videoAnalyticsEventTypeEnum, videoPlaybackErrorReasonEnum, videoIdentityTypeEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;
function playbackEvent() { return ![videoAnalyticsEventTypeEnum.SAVE_ADDED, videoAnalyticsEventTypeEnum.SAVE_REMOVED].includes(this.type); }
const eventSchema = new Schema({
  eventId: { type: String, required: true, immutable: true },
  playbackSessionId: { type: String, required: playbackEvent, immutable: true },
  kind: { type: String, enum: Object.values(videoContentKindEnum), required: true, immutable: true,
    validate: { validator(value) { return playbackEvent.call(this) || value !== videoContentKindEnum.PRODUCT; },
      message: "Product Videos cannot have save transitions" } },
  contentId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  type: { type: String, enum: [videoAnalyticsEventTypeEnum.IMPRESSION, videoAnalyticsEventTypeEnum.SHARE, videoAnalyticsEventTypeEnum.PLAYBACK_ERROR, videoAnalyticsEventTypeEnum.PLAY_START, videoAnalyticsEventTypeEnum.REPLAY, videoAnalyticsEventTypeEnum.WATCH_TIME,
    "progress_25", "progress_50", "progress_75", videoAnalyticsEventTypeEnum.COMPLETE, videoAnalyticsEventTypeEnum.REBUFFER, videoAnalyticsEventTypeEnum.SAVE_ADDED, videoAnalyticsEventTypeEnum.SAVE_REMOVED],
    required: true, immutable: true },
  positionSeconds: { type: Number, min: 0, immutable: true },
  durationMs: { type: Number, min: 1, max: 300000, validate: Number.isSafeInteger, immutable: true },
  qualifiedViewCounted: { type: Boolean, immutable: true },
  // Qualified native views retain viewer/generation history for the existing event TTL.
  identityType: { type: String, enum: Object.values(videoIdentityTypeEnum), immutable: true, select: false },
  identityId: { type: String, maxlength: 256, immutable: true, select: false },
  assetId: { type: Schema.Types.ObjectId, immutable: true, select: false },
  occurredAt: { type: Date, required: true, immutable: true },
  reason: { type: String, enum: Object.values(videoPlaybackErrorReasonEnum),
    immutable: true },
  payloadHash: { type: String, required: playbackEvent, match: /^[a-f\d]{64}$/, immutable: true },
  counted: { type: Boolean, required: true, immutable: true },
  receivedAt: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: "throw" });

eventSchema.index({ playbackSessionId: 1, eventId: 1 }, { unique: true });
eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
eventSchema.index({ kind: 1, contentId: 1, occurredAt: 1 });
eventSchema.index({ identityType: 1, identityId: 1, kind: 1, contentId: 1 },
  { partialFilterExpression: { qualifiedViewCounted: true } });

export const VideoAnalyticsEventModel = model("VideoAnalyticsEvent", eventSchema);
