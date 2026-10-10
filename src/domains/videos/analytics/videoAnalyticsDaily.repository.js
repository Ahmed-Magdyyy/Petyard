import mongoose from "mongoose";
import { VideoAnalyticsDailyModel } from "./videoAnalyticsDaily.model.js";
import { VideoAnalyticsEventModel } from "./videoAnalyticsEvent.model.js";
import { dailyContributions } from "./videoAnalyticsDaily.policy.js";

export function createVideoAnalyticsDailyRepository({
  events = VideoAnalyticsEventModel, daily = VideoAnalyticsDailyModel,
} = {}) {
  return Object.freeze({
    async recordEvents(documents, session) {
      if (!documents.length) return;
      await events.create(documents, { session });
      for (const { kind, contentId, day, expiresAt, increments } of dailyContributions(documents)) {
        await daily.updateOne({ kind, contentId, day },
          { $setOnInsert: { kind, contentId, day, expiresAt }, $inc: increments },
          { session, upsert: true });
      }
    },
    async listDaily({ kind, contentId, from, to, page, limit, now }) {
      const filter = { day: { $gte: from, $lte: to }, expiresAt: { $gt: new Date(now) },
        ...(kind !== "all" ? { kind } : {}),
        ...(contentId ? { contentId: new mongoose.Types.ObjectId(contentId) } : {}) };
      const [totalResults, data] = await Promise.all([
        daily.countDocuments(filter),
        daily.find(filter).sort({ day: -1, kind: 1, contentId: 1 })
          .skip((page - 1) * limit).limit(limit).lean(),
      ]);
      return { totalResults, data };
    },
  });
}
