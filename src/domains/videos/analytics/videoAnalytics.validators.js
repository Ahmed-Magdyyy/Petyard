import { ApiError } from "../../../shared/utils/ApiError.js";
import { DateTime } from "luxon";
import {
  roles,
  enabledControls,
  videoContentKindEnum,
  videoIdentityTypeEnum,
  videoAnalyticsEventTypeEnum,
  videoPlaybackErrorReasonEnum,
} from "../../../shared/constants/enums.js";
import { pagination } from "../video.validators.js";
import { analyticsZone } from "./videoAnalyticsDaily.policy.js";

export function requireAnalyticsReportActor(actor) {
  if (!actor?.id || ![roles.SUPER_ADMIN, roles.ADMIN].includes(actor.role) ||
      (actor.role === roles.ADMIN && !actor.enabledControls?.includes(enabledControls.ANALYTICS))) {
    throw new ApiError("Not allowed to inspect Video analytics", 403,
      [{ code: "VIDEO_FORBIDDEN" }]);
  }
}

export function validateDailyReportQuery(query, now) {
  const invalid = () => new ApiError("Invalid daily analytics report query", 422,
    [{ code: "VIDEO_INVALID_ANALYTICS_REPORT" }]);
  if (!query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some(key => !["kind", "contentId", "from", "to", "page", "limit"].includes(key)) ||
      Object.values(query).some(value => !["string", "number"].includes(typeof value))) throw invalid();
  const kind = query.kind ?? "all";
  if (!["all", videoContentKindEnum.YOUTUBE, videoContentKindEnum.REEL, videoContentKindEnum.PRODUCT].includes(kind) ||
      (query.contentId !== undefined && (typeof query.contentId !== "string" ||
        !/^[a-f\d]{24}$/i.test(query.contentId))) ||
      ((query.from === undefined) !== (query.to === undefined))) throw invalid();
  const today = DateTime.fromMillis(now, { zone: analyticsZone }).toISODate();
  // Date-only validation and span arithmetic use calendar days, not 24-hour
  // elapsed intervals: Cairo DST days can be shorter or longer.
  const to = query.to ?? today;
  const from = query.from ?? DateTime.fromISO(today, { zone: "UTC" }).minus({ days: 29 }).toISODate();
  const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? DateTime.fromISO(value, { zone: "UTC" }) : DateTime.invalid("Invalid date");
  const first = date(from);
  const last = date(to);
  if (!first.isValid || !last.isValid || first.toISODate() !== from || last.toISODate() !== to ||
      last < first || last.diff(first, "days").days > 365) throw invalid();
  return { ...pagination(query.page, query.limit), kind, from, to,
    ...(query.contentId ? { contentId: query.contentId.toLowerCase() } : {}) };
}

export function analyticsIdentity(identity) {
  if (!identity || !Object.values(videoIdentityTypeEnum).includes(identity.type) ||
      typeof identity.id !== "string" || !identity.id.trim() || identity.id.length > 256 ||
      (identity.type === videoIdentityTypeEnum.USER && !/^[a-f\d]{24}$/i.test(identity.id))) {
    throw new ApiError("Authentication or x-guest-id is required", 401,
      [{ code: "VIDEO_IDENTITY_REQUIRED" }]);
  }
  return { type: identity.type,
    id: identity.type === videoIdentityTypeEnum.USER ? identity.id.toLowerCase() : identity.id.trim() };
}

export function validatePlaybackSessionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["kind", "contentId"].includes(key)) ||
      !Object.values(videoContentKindEnum).includes(body.kind) ||
      typeof body.contentId !== "string" || !/^[a-f\d]{24}$/i.test(body.contentId)) {
    throw new ApiError("Invalid playback session request", 422,
      [{ code: "VIDEO_INVALID_PLAYBACK_SESSION" }]);
  }
  return { kind: body.kind, contentId: body.contentId.toLowerCase() };
}

export function validatePlaybackSessionId(id) {
  if (typeof id !== "string" ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id)) {
    throw new ApiError("Playback session not available", 404,
      [{ code: "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE" }]);
  }
  return id.toLowerCase();
}

const eventTypes = [videoAnalyticsEventTypeEnum.IMPRESSION, videoAnalyticsEventTypeEnum.PLAY_START, "progress_25", "progress_50", "progress_75",
  videoAnalyticsEventTypeEnum.COMPLETE, videoAnalyticsEventTypeEnum.WATCH_TIME, videoAnalyticsEventTypeEnum.REPLAY, videoAnalyticsEventTypeEnum.SHARE, videoAnalyticsEventTypeEnum.PLAYBACK_ERROR, videoAnalyticsEventTypeEnum.REBUFFER];
export const invalidAnalyticsEvent = () => new ApiError("Invalid analytics event batch", 422,
  [{ code: "VIDEO_INVALID_ANALYTICS_EVENTS" }]);

function eventTimestamp(value) {
  if (typeof value !== "string") throw invalidAnalyticsEvent();
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw invalidAnalyticsEvent();
  const local = new Date(`${parts[1]}${parts[2] ? `.${parts[2]}` : ""}Z`);
  if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== parts[1] ||
      (parts[3] !== "Z" && (Number(parts[3].slice(1, 3)) > 23 || Number(parts[3].slice(4)) > 59))) {
    throw invalidAnalyticsEvent();
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalidAnalyticsEvent();
  return date.toISOString();
}

export function validateAnalyticsBatch(body) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(body), "utf8"); }
  catch { throw invalidAnalyticsEvent(); }
  if (size > 64 * 1024) throw new ApiError("Analytics payload is too large", 413,
    [{ code: "VIDEO_ANALYTICS_PAYLOAD_TOO_LARGE" }]);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "events") || !Array.isArray(body.events) ||
      body.events.length < 1 || body.events.length > 50) throw invalidAnalyticsEvent();
  return body.events.map(event => {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        !eventTypes.includes(event.type) || typeof event.eventId !== "string" ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(event.eventId)) {
      throw invalidAnalyticsEvent();
    }
    const positioned = ["progress_25", "progress_50", "progress_75", videoAnalyticsEventTypeEnum.COMPLETE].includes(event.type);
    const timed = [videoAnalyticsEventTypeEnum.WATCH_TIME, videoAnalyticsEventTypeEnum.REBUFFER].includes(event.type);
    const allowed = ["eventId", "playbackSessionId", "type", "occurredAt",
      ...(event.type === videoAnalyticsEventTypeEnum.PLAYBACK_ERROR ? ["reason"] : []),
      ...(positioned ? ["positionSeconds"] : []),
      ...(timed ? ["durationMs"] : [])];
    if (Object.keys(event).some(key => !allowed.includes(key)) ||
        (positioned && (!Number.isFinite(event.positionSeconds) || event.positionSeconds < 0)) ||
        (timed && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 1 ||
          event.durationMs > (event.type === videoAnalyticsEventTypeEnum.WATCH_TIME ? 10000 : 300000))) ||
        (event.type === videoAnalyticsEventTypeEnum.PLAYBACK_ERROR && !Object.values(videoPlaybackErrorReasonEnum).includes(event.reason))) throw invalidAnalyticsEvent();
    return { eventId: event.eventId.toLowerCase(),
      playbackSessionId: validatePlaybackSessionId(event.playbackSessionId),
      type: event.type, occurredAt: eventTimestamp(event.occurredAt),
      ...(positioned ? { positionSeconds: event.positionSeconds } : {}),
      ...(timed ? { durationMs: event.durationMs } : {}),
      ...(event.type === videoAnalyticsEventTypeEnum.PLAYBACK_ERROR ? { reason: event.reason } : {}) };
  });
}
