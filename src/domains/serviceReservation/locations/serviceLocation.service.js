import { ServiceLocationModel } from "./serviceLocation.model.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import slugify from "slugify";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { DateTime } from "luxon";
import { CAIRO_TIMEZONE } from "../reservations/serviceReservation.utils.js";

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toArabicIndicDigits(value) {
  const map = {
    0: "٠",
    1: "١",
    2: "٢",
    3: "٣",
    4: "٤",
    5: "٥",
    6: "٦",
    7: "٧",
    8: "٨",
    9: "٩",
  };
  return String(value).replace(/[0-9]/g, (d) => map[d] || d);
}

function hour24To12(hour24) {
  const h = Number(hour24);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = ((h + 11) % 12) + 1;
  return { hour12, ampm };
}

function formatHourLabelEn(hour24) {
  return DateTime.fromObject({ hour: hour24, minute: 0 }, { zone: CAIRO_TIMEZONE })
    .setLocale("en")
    .toFormat("h a");
}

function formatHourLabelAr(hour24) {
  const { hour12, ampm } = hour24To12(hour24);
  const ampmAr = ampm === "AM" ? "ص" : "م";
  return `${toArabicIndicDigits(hour12)} ${ampmAr}`;
}

function buildWorkingHoursByDay(lang = "en") {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  const dayDefs = [
    { en: "saturday", ar: "السبت" },
    { en: "sunday", ar: "الأحد" },
    { en: "monday", ar: "الاثنين" },
    { en: "tuesday", ar: "الثلاثاء" },
    { en: "wednesday", ar: "الأربعاء" },
    { en: "thursday", ar: "الخميس" },
    { en: "friday", ar: "الجمعة" },
  ];

  const result = {};

  for (const day of dayDefs) {
    const startHour = day.en === "thursday" || day.en === "friday" ? 14 : 10;
    const endHour = 22;

    const key = normalizedLang === "ar" ? day.ar : day.en;

    if (normalizedLang === "ar") {
      result[key] = `${formatHourLabelAr(startHour)} - ${formatHourLabelAr(endHour)}`;
    } else {
      result[key] = `${formatHourLabelEn(startHour)} - ${formatHourLabelEn(endHour)}`;
    }
  }

  return result;
}

function buildPublicServiceLocationDto(l, lang) {
  const normalizedLang = lang === "ar" ? "ar" : "en";

  return {
    id: l._id,
    slug: l.slug,
    name: pickLocalizedField(l, "name", normalizedLang),
    city: l.city,
    timezone: l.timezone,
    googleMapsLink: l.googleMapsLink || null,
    phone: l.phone || null,
    capacityByRoomType: l.capacityByRoomType,
    active: !!l.active,
    workingHours: buildWorkingHoursByDay(normalizedLang),
  };
}

function buildServiceLocationDto(l, lang = "en") {
  return {
    id: l._id,
    slug: l.slug,
    name_en: l.name_en,
    name_ar: l.name_ar || null,
    city: l.city,
    timezone: l.timezone,
    googleMapsLink: l.googleMapsLink || null,
    phone: l.phone || null,
    capacityByRoomType: l.capacityByRoomType,
    active: !!l.active,
    workingHours: buildWorkingHoursByDay(lang),
  };
}

export async function listServiceLocationsService(lang = "en") {
  const locations = await ServiceLocationModel.find({ active: true })
    .select(
      "_id slug name_en name_ar city timezone googleMapsLink phone capacityByRoomType active"
    )
    .sort({ name_en: 1 })
    .lean();

  return {
    results: locations.length,
    data: locations.map((l) => buildPublicServiceLocationDto(l, lang)),
  };
}

export async function getServiceLocationByIdService(id) {
  const location = await ServiceLocationModel.findById(id)
    .select(
      "_id slug name_en name_ar city timezone googleMapsLink phone capacityByRoomType active"
    )
    .lean();

  return location;
}

export async function getServiceLocationBySlugService(slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;

  const location = await ServiceLocationModel.findOne({ slug: normalized })
    .select(
      "_id slug name_en name_ar city timezone googleMapsLink phone capacityByRoomType active"
    )
    .lean();

  return location;
}

export async function adminListServiceLocationsService({ includeInactive }) {
  const filter = includeInactive ? {} : { active: true };
  const locations = await ServiceLocationModel.find(filter)
    .select(
      "_id slug name_en name_ar city timezone googleMapsLink phone capacityByRoomType active"
    )
    .sort({ name_en: 1 })
    .lean();

  return {
    results: locations.length,
    data: locations.map((l) => buildServiceLocationDto(l, "en")),
  };
}

export async function getServiceLocationAdminByIdService(id) {
  const location = await ServiceLocationModel.findById(id)
    .select(
      "_id slug name_en name_ar city timezone googleMapsLink phone capacityByRoomType active"
    )
    .lean();

  if (!location) {
    throw new ApiError("Service location not found", 404);
  }

  return buildServiceLocationDto(location, "en");
}

export async function createServiceLocationService(payload) {
  const name_en = payload.name_en?.trim();
  const name_ar = payload.name_ar?.trim();
  const city = payload.city?.trim();

  const slug = payload.slug
    ? normalizeSlug(payload.slug)
    : slugify(String(name_en), { lower: true, strict: true, trim: true });
  if (!slug) {
    throw new ApiError("Failed to generate a valid slug", 400);
  }

  const doc = await ServiceLocationModel.create({
    slug,
    name_en,
    name_ar,
    city,
    timezone: payload.timezone,
    googleMapsLink: payload.googleMapsLink,
    phone: payload.phone,
    capacityByRoomType: payload.capacityByRoomType,
    active: payload.active !== undefined ? payload.active : true,
  });

  return buildServiceLocationDto(doc.toObject(), "en");
}

export async function updateServiceLocationService(id, payload) {
  const location = await ServiceLocationModel.findById(id);
  if (!location) {
    throw new ApiError("Service location not found", 404);
  }

  if (payload.slug !== undefined) {
    const normalized = normalizeSlug(payload.slug);
    if (!normalized) {
      throw new ApiError("slug is invalid", 400);
    }
    location.slug = normalized;
  }

  if (payload.name_en !== undefined) location.name_en = payload.name_en;
  if (payload.name_ar !== undefined) location.name_ar = payload.name_ar;
  if (payload.city !== undefined) location.city = payload.city;
  if (payload.timezone !== undefined) location.timezone = payload.timezone;
  if (payload.googleMapsLink !== undefined)
    location.googleMapsLink = payload.googleMapsLink;
  if (payload.phone !== undefined) location.phone = payload.phone;
  if (payload.active !== undefined) location.active = payload.active;

  if (payload.capacityByRoomType !== undefined) {
    location.capacityByRoomType = payload.capacityByRoomType;
  }

  const updated = await location.save();
  return buildServiceLocationDto(updated.toObject());
}

export async function toggleServiceLocationActiveService(id) {
  const location = await ServiceLocationModel.findById(id);
  if (!location) {
    throw new ApiError("Service location not found", 404);
  }

  location.active = !location.active;
  const updated = await location.save();
  return buildServiceLocationDto(updated.toObject());
}

export async function deleteServiceLocationService(id) {
  const location = await ServiceLocationModel.findById(id);
  if (!location) {
    throw new ApiError("Service location not found", 404);
  }

  location.active = false;
  await location.save();
}
