/**
 * Egypt Timezone Converter
 *
 * Converts all UTC ISO-8601 date strings in Express JSON responses
 * to Egypt local time (Africa/Cairo).
 *
 * Usage in server.js:
 *   import { egyptTimezoneReplacer } from '...';
 *   app.set('json replacer', egyptTimezoneReplacer);
 */

const EGYPT_TZ = "Africa/Cairo";

/**
 * Get the UTC offset in minutes for Egypt at a specific point in time.
 * Uses Intl so it automatically handles any future DST changes.
 */
function getEgyptOffsetMinutes(date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const egyptStr = date.toLocaleString("en-US", { timeZone: EGYPT_TZ });
  return (new Date(egyptStr) - new Date(utcStr)) / 60_000;
}

/**
 * Convert a UTC Date to an ISO-8601 string in Egypt timezone.
 * e.g. "2026-04-06T21:03:46.000Z"  →  "2026-04-06T23:03:46.000+02:00"
 */
function toEgyptISO(date) {
  const offsetMin = getEgyptOffsetMinutes(date);

  // Shift the date by the offset so toISOString() prints Egypt local time
  const shifted = new Date(date.getTime() + offsetMin * 60_000);

  // Strip the trailing "Z" so clients treat it as bare local time
  return shifted.toISOString().replace("Z", "");
}

/**
 * Matches UTC ISO-8601 strings produced by Date.prototype.toJSON()
 * e.g. "2026-04-06T21:03:46.000Z"
 */
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Express JSON replacer – pass to app.set('json replacer', ...).
 * Runs during JSON.stringify for every key/value in the response.
 */
export function egyptTimezoneReplacer(_key, value) {
  if (typeof value === "string" && UTC_ISO_RE.test(value)) {
    return toEgyptISO(new Date(value));
  }
  return value;
}
