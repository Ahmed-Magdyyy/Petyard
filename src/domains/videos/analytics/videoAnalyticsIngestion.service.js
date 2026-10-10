import { videoContentKindEnum, videoAnalyticsEventTypeEnum, videoAnalyticsMarkerEnum } from "../../../shared/constants/enums.js";
import { createHash } from "node:crypto";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { invalidAnalyticsEvent } from "./videoAnalytics.validators.js";

export function processSessionEvents({ session, events, existing, media, now }) {
  const known = new Map(existing.map(event => [event.eventId, event]));
  const countedTypes = new Set(session.countedTypes ?? []);
  let eventCount = session.eventCount ?? 0;
  let watchTimeMs = session.watchTimeMs ?? 0;
  let playStartedAt = session.playStartedAt ? new Date(session.playStartedAt).getTime() : undefined;
  let lastIntervalEnd = session.lastPlaybackIntervalEndAt
    ? new Date(session.lastPlaybackIntervalEndAt).getTime() : -Infinity;
  let lastOccurredAt = session.lastOccurredAt ? new Date(session.lastOccurredAt).getTime() : -Infinity;
  if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 500 ||
      !Number.isSafeInteger(watchTimeMs) || watchTimeMs < 0 ||
      (playStartedAt !== undefined && !Number.isFinite(playStartedAt)) ||
      (lastIntervalEnd !== -Infinity && !Number.isFinite(lastIntervalEnd)) ||
      (lastOccurredAt !== -Infinity && !Number.isFinite(lastOccurredAt))) throw invalidAnalyticsEvent();
  const issuedAt = new Date(session.issuedAt).getTime();
  const documents = [];
  let duplicates = 0;
  for (const event of events) {
    if (media.kind === videoContentKindEnum.YOUTUBE && ![videoAnalyticsEventTypeEnum.IMPRESSION, videoAnalyticsEventTypeEnum.SHARE, videoAnalyticsEventTypeEnum.PLAYBACK_ERROR].includes(event.type)) {
      throw new ApiError("This analytics metric is not available yet", 422,
        [{ code: "VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE" }]);
    }
    const payloadHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const previous = known.get(event.eventId);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new ApiError("Analytics event ID conflicts", 409,
        [{ code: "VIDEO_ANALYTICS_EVENT_CONFLICT" }]);
      duplicates++;
      continue;
    }
    const occurredAt = new Date(event.occurredAt).getTime();
    if (occurredAt < now - 5 * 60 * 1000 || occurredAt > now + 30 * 1000 ||
        occurredAt < issuedAt - 30 * 1000 || occurredAt < lastOccurredAt ||
        (event.type === videoAnalyticsEventTypeEnum.IMPRESSION && now - issuedAt < 1000)) throw invalidAnalyticsEvent();
    if (++eventCount > 500) throw new ApiError("Playback session event limit reached", 409,
      [{ code: "VIDEO_ANALYTICS_SESSION_LIMIT" }]);
    let qualifiedViewCounted;
    if (event.type === videoAnalyticsEventTypeEnum.PLAY_START && !countedTypes.has(videoAnalyticsEventTypeEnum.PLAY_START)) playStartedAt = occurredAt;
    if (event.type === videoAnalyticsEventTypeEnum.REBUFFER) {
      const start = occurredAt - event.durationMs;
      if (playStartedAt === undefined || start < playStartedAt || start < lastIntervalEnd ||
          event.durationMs > now - issuedAt) throw invalidAnalyticsEvent();
      lastIntervalEnd = occurredAt;
    }
    if (event.type === videoAnalyticsEventTypeEnum.WATCH_TIME) {
      const start = occurredAt - event.durationMs;
      if (start < lastIntervalEnd || start < issuedAt - 30000 ||
          (playStartedAt !== undefined && start < playStartedAt) ||
          watchTimeMs + event.durationMs > now - issuedAt) throw invalidAnalyticsEvent();
      watchTimeMs += event.durationMs;
      lastIntervalEnd = occurredAt;
      qualifiedViewCounted = watchTimeMs >= 2000 && !countedTypes.has(videoAnalyticsMarkerEnum.QUALIFIED_VIEW);
      if (qualifiedViewCounted) countedTypes.add(videoAnalyticsMarkerEnum.QUALIFIED_VIEW);
    }
    const fraction = { [videoAnalyticsEventTypeEnum.PROGRESS_25]: 0.25, [videoAnalyticsEventTypeEnum.PROGRESS_50]: 0.5, [videoAnalyticsEventTypeEnum.PROGRESS_75]: 0.75, [videoAnalyticsEventTypeEnum.COMPLETE]: 0.95 }[event.type];
    if (fraction !== undefined && (event.positionSeconds > media.durationSeconds ||
        event.positionSeconds < (event.type === videoAnalyticsEventTypeEnum.COMPLETE ? Math.max(0, media.durationSeconds - 1)
          : media.durationSeconds * fraction) || watchTimeMs < media.durationSeconds * 1000 * fraction)) {
      throw invalidAnalyticsEvent();
    }
    const once = [videoAnalyticsEventTypeEnum.IMPRESSION, videoAnalyticsEventTypeEnum.PLAY_START, videoAnalyticsEventTypeEnum.REPLAY].includes(event.type) || fraction !== undefined;
    const counted = !once || !countedTypes.has(event.type);
    if (once) countedTypes.add(event.type);
    const document = { ...event, kind: media.kind, contentId: media.contentId,
      ...(event.type === videoAnalyticsEventTypeEnum.WATCH_TIME ? { qualifiedViewCounted } : {}),
      payloadHash, counted, occurredAt: new Date(occurredAt), receivedAt: new Date(now),
      expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000) };
    documents.push(document);
    known.set(event.eventId, document);
    lastOccurredAt = occurredAt;
  }
  return { documents, duplicates,
    state: { eventCount, watchTimeMs, countedTypes: [...countedTypes],
      ...(playStartedAt !== undefined ? { playStartedAt: new Date(playStartedAt) } : {}),
      ...(lastIntervalEnd !== -Infinity ? { lastPlaybackIntervalEndAt: new Date(lastIntervalEnd) } : {}),
      ...(lastOccurredAt !== -Infinity ? { lastOccurredAt: new Date(lastOccurredAt) } : {}) } };
}
