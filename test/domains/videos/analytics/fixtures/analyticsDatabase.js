import { createVideoAnalyticsService } from "../../../../../src/domains/videos/analytics/videoAnalytics.service.js";
import { createVideoAnalyticsRepository } from "../../../../../src/domains/videos/analytics/videoAnalytics.repository.js";
import { VideoPlaybackSessionModel } from "../../../../../src/domains/videos/analytics/videoPlaybackSession.model.js";
import { VideoAnalyticsEventModel } from "../../../../../src/domains/videos/analytics/videoAnalyticsEvent.model.js";
import { VideoAnalyticsDailyModel } from "../../../../../src/domains/videos/analytics/videoAnalyticsDaily.model.js";
import { replacementDatabase } from "../../productVideos/fixtures/replacementDatabase.js";

export const id = "507f1f77bcf86cd799439011";
export const guest = { type: "guest", id: "guest-session-owner" };
export const body = { kind: "youtube", contentId: id };

export const assetId = "507f1f77bcf86cd799439012";
export const productId = "507f1f77bcf86cd799439013";
export const uploadId = "507f1f77bcf86cd799439014";
const path = (row, key) => key.split(".").reduce((value, field) => value?.[field], row);
const operand = (row, value) => typeof value === "string" && value.startsWith("$") ? path(row, value.slice(1)) : value;

// Fake external Mongo adapter, limited to the existing public eligibility pipelines.
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(item => matches(row, item));
    if (key === "$expr") {
      const expressions = expected.$and ?? [expected];
      return expressions.every(item => String(operand(row, item.$eq[0])) === String(operand(row, item.$eq[1])));
    }
    const value = path(row, key);
    if (expected && typeof expected === "object" && !expected.toHexString) {
      return Object.entries(expected).every(([op, target]) => {
        if (op === "$in") return target.some(item => String(value) === String(item));
        if (op === "$exists") return (value !== undefined) === target;
        if (op === "$gt") return value > target;
        if (op === "$lte") return value <= target;
        if (op === "$type") return target === "date" && value instanceof Date;
        if (op === "$mod") return value % target[0] === target[1];
        throw new Error(`Unsupported analytics fixture comparison: ${op}`);
      });
    }
    return String(value) === String(expected);
  });
}

export function fixture({ kind = "youtube" } = {}) {
  const clock = { time: Date.parse("2026-10-02T20:00:00Z") };
  const db = replacementDatabase({ placements: [{ _id: id, kind: "youtube",
    status: "published", youtubeId: "dQw4w9WgXcQ", ...(kind === "reel" ? {
      kind, activeAssetId: assetId, activeUploadSessionId: uploadId } : {}) }],
    assets: [{ _id: assetId, ownerType: kind === "product" ? "product_video" : "reel",
      ownerId: id, technicalState: "ready", providerStatus: 4, durationSeconds: 18,
      width: 720, height: 1280, readyAt: new Date(clock.time), availableResolutions: ["720p"] }],
    products: [{ _id: productId, isActive: true }],
    replacements: [{ _id: id, productId, activeSlot: true, activeAssetId: assetId,
      lifecycleState: "ready", showInReelsFeed: false }],
    operations: [{ _id: uploadId, assetId, videoId: id, status: "issued" }],
  }, { now: () => clock.time });
  const collections = { videos: db.placements, productvideos: db.replacements,
    assets: db.assets, uploads: db.operations, products: db.products };
  function model(name) {
    return { ...collections[name], collection: { name },
      aggregate(pipeline) {
        const result = (async () => {
          let rows = await collections[name].find({});
          for (const stage of pipeline) {
            if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
            else if (stage.$lookup) {
              const lookup = stage.$lookup;
              const joined = await collections[lookup.from].find({});
              rows = rows.map(row => ({ ...row, [lookup.as]: joined.filter(item =>
                String(path(item, lookup.foreignField)) === String(path(row, lookup.localField))) }));
            } else if (stage.$unwind) {
              const key = (typeof stage.$unwind === "string" ? stage.$unwind : stage.$unwind.path).slice(1);
              rows = rows.flatMap(row => row[key].length ? row[key].map(item => ({ ...row, [key]: item }))
                : stage.$unwind.preserveNullAndEmptyArrays ? [{ ...row, [key]: null }] : []);
            } else if (stage.$limit) rows = rows.slice(0, stage.$limit);
            else if (stage.$addFields) rows = rows.map(row => ({ ...row, ...Object.fromEntries(
              Object.entries(stage.$addFields).map(([key, value]) => [key, operand(row, value)])) }));
            else throw new Error("Unsupported analytics fixture aggregate stage");
          }
          return rows;
        })();
        result.session = () => result;
        return result;
      },
    };
  }
  const videos = model("videos");
  const playbackSessions = { ...db.sessions, async create(rows) {
    const documents = rows.map(row => new VideoPlaybackSessionModel(row));
    for (const document of documents) await document.validate();
    return db.sessions.create(documents.map(document => document.toObject()));
  } };
  const events = { ...db.attempts, async create(rows) {
    const documents = rows.map(row => new VideoAnalyticsEventModel(row));
    for (const document of documents) await document.validate();
    return db.attempts.create(documents.map(document => document.toObject()));
  } };
  const daily = { ...db.daily, async updateOne(filter, changes, options) {
    if (!options?.session) throw new Error("Daily totals require the event transaction");
    const current = await db.daily.findOne(filter);
    const row = current ?? { ...changes.$setOnInsert };
    for (const [field, value] of Object.entries(changes.$inc ?? {})) row[field] = (row[field] ?? 0) + value;
    await new VideoAnalyticsDailyModel(row).validate();
    return db.daily.updateOne(filter, changes, options);
  } };
  const repository = createVideoAnalyticsRepository({ videos,
    events, daily, connection: db.connection,
    playbackSessions, assets: model("assets"), uploads: model("uploads"),
    placements: model("productvideos"), products: model("products") });
  const flags = { editorial: true, product: true };
  const service = createVideoAnalyticsService({ repository,
    isEnabled: () => flags.editorial, isProductEnabled: () => flags.product,
    now: () => clock.time });
  return { service, db, videos, clock, flags, playbackSessions, events, daily };
}
