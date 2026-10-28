import { DateTime } from "luxon";
import { ApiError } from "../../shared/utils/ApiError.js";

export const ANALYTICS_TIMEZONE = "Africa/Cairo";

export function cairoMonthPeriod(month, now = new Date()) {
  if (typeof month !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError("Invalid calendar month", 400);
  const start = DateTime.fromISO(`${month}-01`, { zone: ANALYTICS_TIMEZONE });
  if (!start.isValid || start.toMillis() > now.getTime()) throw new ApiError("Invalid calendar month", 400);
  const end = start.plus({ months: 1 });
  const observed = DateTime.fromMillis(Math.min(end.toMillis(), now.getTime()), { zone: ANALYTICS_TIMEZONE });
  return { month, start: start.toUTC().toISO(), endExclusive: end.toUTC().toISO(),
    observedThroughExclusive: observed.toUTC().toISO(), partial: observed < end };
}
