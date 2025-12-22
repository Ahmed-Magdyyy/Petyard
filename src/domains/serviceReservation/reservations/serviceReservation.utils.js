import { DateTime } from "luxon";
import { ApiError } from "../../../shared/ApiError.js";

export const CAIRO_TIMEZONE = "Africa/Cairo";

function normalizeAmPm(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (v === "AM" || v === "PM") return v;
  return null;
}

export function parseHour12To24(hour12, ampm) {
  const n = Number(hour12);
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new ApiError("hour12 must be an integer between 1 and 12", 400);
  }

  const meridiem = normalizeAmPm(ampm);
  if (!meridiem) {
    throw new ApiError("ampm must be either AM or PM", 400);
  }

  if (meridiem === "AM") {
    return n === 12 ? 0 : n;
  }

  return n === 12 ? 12 : n + 12;
}

export function parseHour24OrThrow(hour24) {
  const n = Number(hour24);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new ApiError("hour24 must be an integer between 0 and 23", 400);
  }
  return n;
}

export function parseCairoDateOrThrow(dateISO) {
  if (!dateISO || typeof dateISO !== "string") {
    throw new ApiError("date is required", 400);
  }

  const dt = DateTime.fromISO(dateISO, { zone: CAIRO_TIMEZONE });
  if (!dt.isValid) {
    throw new ApiError("date must be a valid ISO date (YYYY-MM-DD)", 400);
  }

  return dt.startOf("day");
}

export function getWorkingHoursForCairoDate(cairoDateStart) {
  const weekday = cairoDateStart.weekday;
  const isThu = weekday === 4;
  const isFri = weekday === 5;

  const startHour = isThu || isFri ? 14 : 10;
  const endHour = 22;

  return { startHour, endHour };
}

export function cairoSlotToUtcDate({ dateISO, hour24, hour12, ampm }) {
  const cairoDay = parseCairoDateOrThrow(dateISO);

  const hour24Value =
    hour24 !== undefined && hour24 !== null && String(hour24).trim()
      ? parseHour24OrThrow(hour24)
      : parseHour12To24(hour12, ampm);

  const slot = cairoDay.set({
    hour: hour24Value,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  return {
    hour24: hour24Value,
    cairo: slot,
    utcDate: slot.toUTC().toJSDate(),
  };
}

export function addHoursUtc(date, hours) {
  const base = DateTime.fromJSDate(date, { zone: "utc" });
  return base.plus({ hours }).toJSDate();
}

export function formatHourLabel12(hour24) {
  const n = Number(hour24);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    return null;
  }
  return DateTime.fromObject(
    { hour: n, minute: 0 },
    { zone: CAIRO_TIMEZONE }
  ).toFormat("h:mm a");
}

export function ensureWithinWorkingHoursOrThrow({ cairoDateStart, hour24 }) {
  const { startHour, endHour } = getWorkingHoursForCairoDate(cairoDateStart);

  if (hour24 < startHour || hour24 >= endHour) {
    const startLabel = formatHourLabel12(startHour) || `${startHour}:00`;
    const endLabel = formatHourLabel12(endHour) || `${endHour}:00`;
    throw new ApiError(
      `Selected time is outside working hours (${startLabel} - ${endLabel})`,
      400
    );
  }
}

export function getNowCairo() {
  return DateTime.now().setZone(CAIRO_TIMEZONE);
}

export function startOfCurrentHourCairo() {
  const now = getNowCairo();
  return now.startOf("hour");
}

export function toCairoDateISO(dtUtc) {
  const cairo = DateTime.fromJSDate(dtUtc, { zone: "utc" }).setZone(
    CAIRO_TIMEZONE
  );
  return cairo.toFormat("yyyy-LL-dd");
}

export function toCairoHour24(dtUtc) {
  const cairo = DateTime.fromJSDate(dtUtc, { zone: "utc" }).setZone(
    CAIRO_TIMEZONE
  );
  return cairo.hour;
}
