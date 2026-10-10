import { videoContentKindEnum, videoAnalyticsEventTypeEnum } from "../../../shared/constants/enums.js";
import { DateTime } from "luxon";

export const analyticsZone = "Africa/Cairo";
const countedMetrics = { [videoAnalyticsEventTypeEnum.IMPRESSION]: "impressions", [videoAnalyticsEventTypeEnum.PLAY_START]: "playStarts",
  [videoAnalyticsEventTypeEnum.PROGRESS_25]: "progress25", [videoAnalyticsEventTypeEnum.PROGRESS_50]: "progress50", [videoAnalyticsEventTypeEnum.PROGRESS_75]: "progress75",
  [videoAnalyticsEventTypeEnum.COMPLETE]: "completions", [videoAnalyticsEventTypeEnum.REPLAY]: "replays", [videoAnalyticsEventTypeEnum.SHARE]: "shares", [videoAnalyticsEventTypeEnum.PLAYBACK_ERROR]: "playbackErrors",
  [videoAnalyticsEventTypeEnum.REBUFFER]: "rebuffers", [videoAnalyticsEventTypeEnum.SAVE_ADDED]: "saveAdditions", [videoAnalyticsEventTypeEnum.SAVE_REMOVED]: "saveRemovals" };
export const dailyMetricFields = [...Object.values(countedMetrics),
  "qualifiedViews", "watchTimeMs", "rebufferTimeMs"];

function bucket(time) {
  const local = DateTime.fromJSDate(new Date(time), { zone: analyticsZone });
  // startOf(day) after addition matters when DST skips the first local hour.
  const end = local.plus({ days: 1 }).startOf("day");
  return { day: local.toISODate(), end: end.toMillis(),
    expiresAt: end.plus({ months: 12 }).startOf("day").toJSDate() };
}

export function dailyContributions(events) {
  const rows = new Map();
  function increment(event, time, field, value) {
    const { day, expiresAt } = bucket(time);
    const key = `${event.kind}:${event.contentId}:${day}`;
    if (!rows.has(key)) rows.set(key, { kind: event.kind, contentId: event.contentId,
      day, expiresAt, increments: {} });
    const row = rows.get(key);
    row.increments[field] = (row.increments[field] ?? 0) + value;
  }
  for (const event of events) {
    if (!event.counted) continue;
    const field = countedMetrics[event.type];
    const end = new Date(event.occurredAt).getTime();
    if (field) increment(event, end, field, 1);
    if (event.qualifiedViewCounted) increment(event, end, "qualifiedViews", 1);
    if (event.type === videoAnalyticsEventTypeEnum.WATCH_TIME) {
      let cursor = end - event.durationMs;
      while (cursor < end) {
        const next = Math.min(end, bucket(cursor).end);
        increment(event, cursor, "watchTimeMs", next - cursor);
        cursor = next;
      }
    }
    if (event.type === videoAnalyticsEventTypeEnum.REBUFFER) increment(event, end, "rebufferTimeMs", event.durationMs);
  }
  return [...rows.values()];
}

export function dailyReportRow(row) {
  const unavailable = row.kind === videoContentKindEnum.YOUTUBE ? dailyMetricFields.filter(field =>
    !["impressions", "shares", "playbackErrors", "saveAdditions", "saveRemovals"].includes(field))
    : row.kind === videoContentKindEnum.PRODUCT ? ["saveAdditions", "saveRemovals"] : [];
  return { day: row.day, kind: row.kind, contentId: String(row.contentId),
    metrics: Object.fromEntries(dailyMetricFields.map(field => [field,
      unavailable.includes(field) ? null : row[field] ?? 0])) };
}
