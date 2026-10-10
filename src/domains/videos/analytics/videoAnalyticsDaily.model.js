import { videoContentKindEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";
import { dailyMetricFields } from "./videoAnalyticsDaily.policy.js";

const { Schema, model } = mongoose;
const dailySchema = new Schema({
  kind: { type: String, enum: Object.values(videoContentKindEnum), required: true, immutable: true },
  contentId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
  ...Object.fromEntries(dailyMetricFields.map(field => [field,
    { type: Number, min: 0, default: 0, validate: Number.isSafeInteger }])),
  expiresAt: { type: Date, required: true, immutable: true },
}, { strict: "throw", versionKey: false });

dailySchema.index({ kind: 1, contentId: 1, day: 1 }, { unique: true });
dailySchema.index({ day: -1, kind: 1, contentId: 1 });
dailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const VideoAnalyticsDailyModel = model("VideoAnalyticsDaily", dailySchema);
