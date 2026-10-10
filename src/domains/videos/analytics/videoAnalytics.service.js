import { videoContentKindEnum } from "../../../shared/constants/enums.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { analyticsIdentity, validatePlaybackSessionBody,
  validatePlaybackSessionId, validateAnalyticsBatch, requireAnalyticsReportActor,
  validateDailyReportQuery } from "./videoAnalytics.validators.js";
import { processSessionEvents } from "./videoAnalyticsIngestion.service.js";
import { dailyReportRow } from "./videoAnalyticsDaily.policy.js";

const unavailable = () => new ApiError("Playback session not available", 404,
  [{ code: "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE" }]);
const storageUnavailable = () => new ApiError("Video analytics temporarily unavailable", 503,
  [{ code: "VIDEO_ANALYTICS_UNAVAILABLE" }]);

let productionService;

export async function getVideoAnalyticsService() {
  if (!productionService) {
    const { createVideoAnalyticsRepository } = await import("./videoAnalytics.repository.js");
    productionService = createVideoAnalyticsService({ repository: createVideoAnalyticsRepository(),
      isEnabled: () => String(process.env.VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
      isProductEnabled: () => String(process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true" });
  }
  return productionService;
}

export function createVideoAnalyticsService({ repository, isEnabled = () => false,
  isProductEnabled = () => false, now = Date.now } = {}) {
  if (!["getCurrent", "createSession", "deleteSession", "findSession", "commitEvents"].every(
    method => typeof repository?.[method] === "function") ||
      [isEnabled, isProductEnabled, now].some(value => typeof value !== "function")) {
    throw new TypeError("Videos analytics dependencies are required");
  }
  const enabled = kind => kind === videoContentKindEnum.PRODUCT ? isProductEnabled() : isEnabled();
  async function current(content) {
    if (!enabled(content.kind)) return null;
    const row = await repository.getCurrent(content);
    if (!row || !enabled(content.kind) || (row.kind === videoContentKindEnum.YOUTUBE
      ? !/^[A-Za-z0-9_-]{11}$/.test(row.youtubeId || "")
      : !Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0 || row.durationSeconds > 90)) return null;
    return row;
  }
  function matchesMedia(a, b) {
    return a.kind === b.kind && String(a.contentId) === String(b.contentId) &&
      (a.kind === videoContentKindEnum.YOUTUBE ? a.youtubeId === b.youtubeId
        : String(a.assetId) === String(b.assetId) &&
          String(a.uploadSessionId) === String(b.uploadSessionId) && a.durationSeconds === b.durationSeconds);
  }
  function unexpired(session) {
    const issuedAt = new Date(session.issuedAt).getTime();
    const expiresAt = new Date(session.expiresAt).getTime();
    const time = now();
    return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
      expiresAt - issuedAt === 30 * 60 * 1000 && time >= issuedAt && time < expiresAt;
  }

  return Object.freeze({
    async listDailyReport({ actor, query = {} }) {
      requireAnalyticsReportActor(actor);
      const time = now();
      const filter = validateDailyReportQuery(query, time);
      try {
        const { totalResults, data } = await repository.listDaily({ ...filter, now: time });
        return { totalResults, totalPages: Math.ceil(totalResults / filter.limit) || 1,
          page: filter.page, results: data.length, data: data.map(dailyReportRow) };
      } catch { throw storageUnavailable(); }
    },
    async ingestEvents({ body, identity }) {
      const owner = analyticsIdentity(identity);
      const batch = validateAnalyticsBatch(body);
      const checkSession = (session, media) => {
        if (!media || !enabled(session.kind) || !matchesMedia(session, media) || !unexpired(session)) {
          throw unavailable();
        }
      };
      try {
        return await repository.commitEvents({ batch, identity: owner, checkSession,
          processSession: input => processSessionEvents({ ...input, now: now() }) });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw storageUnavailable();
      }
    },
    async issueSession({ body, identity }) {
      const owner = analyticsIdentity(identity);
      const content = validatePlaybackSessionBody(body);
      let createdId;
      try {
        const media = await current(content);
        if (!media) throw unavailable();
        const issuedAt = new Date(now());
        const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
        const id = randomUUID();
        await repository.createSession({ _id: id, ...media,
          identityType: owner.type, identityId: owner.id, issuedAt, expiresAt });
        createdId = id;
        // This is not a playback grant or a visibility lock. Ingestion must
        // recheck the captured media when committing events.
        const latest = await current(content);
        if (!latest || !matchesMedia(media, latest) || now() >= expiresAt.getTime()) throw unavailable();
        return { playbackSessionId: id,
          // Keep the offset explicit; the global Egypt replacer strips Z timestamps.
          expiresAt: expiresAt.toISOString().replace("Z", "+00:00") };
      } catch (error) {
        if (createdId) {
          try { await repository.deleteSession(createdId); }
          catch { throw storageUnavailable(); }
        }
        if (error instanceof ApiError) throw error;
        throw storageUnavailable();
      }
    },
    async resolveSession({ playbackSessionId, identity }) {
      const owner = analyticsIdentity(identity);
      const id = validatePlaybackSessionId(playbackSessionId);
      try {
        const session = await repository.findSession({ id, identity: owner });
        if (!session || !unexpired(session)) throw unavailable();
        const media = await current({ kind: session.kind, contentId: String(session.contentId) });
        if (!media || !matchesMedia(session, media) || !unexpired(session)) {
          throw unavailable();
        }
        return { ...media, playbackSessionId: id,
          issuedAt: new Date(session.issuedAt), expiresAt: new Date(session.expiresAt) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw storageUnavailable();
      }
    },
  });
}
