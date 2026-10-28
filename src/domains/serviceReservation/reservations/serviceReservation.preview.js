import mongoose from "mongoose";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { serviceTypeEnum, serviceReservationStatusEnum } from "../../../shared/constants/enums.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { getServiceDefinition, resolveServiceSelectionOrThrow } from "../catalog/serviceCatalog.service.js";
import { ServiceReservationModel } from "./serviceReservation.model.js";
import { assertWithinBookingWindowOrThrow, resolvePetSnapshot, getAvailabilityService } from "./serviceReservation.service.js";
import { CAIRO_TIMEZONE, parseCairoDateOrThrow, cairoSlotToUtcDate, addHoursUtc, ensureWithinWorkingHoursOrThrow,
  startOfCurrentHourCairo, getNowCairo } from "./serviceReservation.utils.js";
import { requireAssistantBookingLocation } from "./serviceReservation.eligibility.js";

const invalid = (message) => { throw new ApiError(message, 400); };
const id = (value) => { if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) invalid("Invalid booking identifier"); return value; };

// Internal read-only domain preview. The caller supplies an authenticated owner's ID; this is not an HTTP/model tool or a held reservation.
export function parseAssistantBookingSelection({ userId, resolvedLocation, payload, lang = "en" }) {
  userId = id(userId);
  requireAssistantBookingLocation(resolvedLocation);
  if (!payload || payload.constructor !== Object) invalid("Booking payload is required");
  const allowed = ["locationId", "serviceType", "serviceOptionKey", "services", "date", "hour24", "petId", "ownerName", "ownerPhone",
    "petType", "petName", "age", "gender", "comment"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) invalid("Unknown booking field");
  const locationId = id(payload.locationId); if (payload.petId != null) id(payload.petId);
  if (!["en", "ar"].includes(lang)) invalid("Invalid booking language");
  if (typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) invalid("date must be YYYY-MM-DD");
  if (!Number.isInteger(payload.hour24) || payload.hour24 < 0 || payload.hour24 > 23) invalid("hour24 must be an integer between 0 and 23");
  for (const key of ["ownerName", "ownerPhone", "petType", "petName", "gender", "comment"]) {
    if (payload[key] != null && (typeof payload[key] !== "string" || payload[key].length > 2048)) invalid(`Invalid ${key}`);
  }
  if (payload.age != null && (!Number.isFinite(payload.age) || payload.age < 0)) invalid("Invalid age");
  if (payload.services !== undefined && (payload.serviceType !== undefined || payload.serviceOptionKey !== undefined)) invalid("Choose services or a single service");
  const requested = payload.services ?? [{ serviceType: payload.serviceType, serviceOptionKey: payload.serviceOptionKey }];
  // The longest existing working day has twelve hourly slots; this is a request bound, not a new booking duration rule.
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 12) invalid("Choose between one and twelve services");
  for (const item of requested) {
    if (!item || item.constructor !== Object || Object.keys(item).some((key) => !["serviceType", "serviceOptionKey"].includes(key)) ||
      !Object.values(serviceTypeEnum).includes(item.serviceType) ||
      (item.serviceOptionKey != null && (typeof item.serviceOptionKey !== "string" || item.serviceOptionKey.length > 128))) invalid("Invalid service selection");
    if (item.serviceType === serviceTypeEnum.BOARDING) throw new ApiError("This service is not supported by the assistant", 400);
  }
  const day = parseCairoDateOrThrow(payload.date); assertWithinBookingWindowOrThrow(day, lang);
  const { utcDate: firstStart, cairo } = cairoSlotToUtcDate({ dateISO: payload.date, hour24: payload.hour24 });
  if (cairo < startOfCurrentHourCairo()) invalid("Cannot book in the past");
  for (let index = 0; index < requested.length; index++) ensureWithinWorkingHoursOrThrow({ cairoDateStart: day, hour24: payload.hour24 + index }, lang);
  return { userId, locationId, requested, firstStart };
}

export async function previewUserReservationService({ userId, resolvedLocation, payload, lang = "en" }) {
  const parsed = parseAssistantBookingSelection({ userId, resolvedLocation, payload, lang });
  const { locationId, requested, firstStart } = parsed;
  userId = parsed.userId;
  const snapshot = await resolvePetSnapshot({ userId, petId: payload.petId, payload, lang });
  const services = [], availability = new Map(); let totalPrice = 0;
  for (const [index, item] of requested.entries()) {
    if (!availability.has(item.serviceType)) {
      const definition = await getServiceDefinition(item.serviceType);
      if (!definition || definition.isActive !== true) throw new ApiError("Selected service is not active", 409);
      availability.set(item.serviceType, await getAvailabilityService({ locationId, serviceType: item.serviceType, date: payload.date, lang }));
      const branchCity = availability.get(item.serviceType)?.location?.city;
      if (typeof branchCity !== "string" || branchCity.trim().toLowerCase() !== "alexandria") {
        throw new ApiError("Selected service location is outside Alexandria", 409);
      }
    }
    const selected = await resolveServiceSelectionOrThrow({ serviceType: item.serviceType, optionKey: item.serviceOptionKey });
    if (!Number.isFinite(selected.servicePrice) || selected.servicePrice < 0 || selected.currency !== "EGP") throw new ApiError("Service price is unavailable", 409);
    const available = availability.get(item.serviceType), slot = available.slots.find((entry) => entry.hour24 === payload.hour24 + index);
    if (!slot || !Number.isSafeInteger(slot.capacity) || slot.capacity <= 0 || !Number.isSafeInteger(slot.booked) || slot.booked < 0) {
      throw new ApiError("Selected service is not available at this location", 409);
    }
    const startsAt = addHoursUtc(firstStart, index), endsAt = addHoursUtc(startsAt, 1);
    services.push({ serviceType: item.serviceType, serviceOptionKey: selected.serviceOptionKey,
      serviceName: pickLocalizedField(selected, "serviceName", lang), serviceOptionName: pickLocalizedField(selected, "serviceOptionName", lang),
      roomType: available.roomType, hour24: slot.hour24, label: slot.label, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      price: selected.servicePrice, currency: "EGP", available: slot.booked < slot.capacity, remaining: Math.max(slot.capacity - slot.booked, 0) });
    totalPrice += selected.servicePrice;
  }
  if (!Number.isFinite(totalPrice)) throw new ApiError("Service price is unavailable", 409);
  const conflict = await ServiceReservationModel.findOne({ user: new mongoose.Types.ObjectId(userId),
    startsAt: { $in: services.map((entry) => new Date(entry.startsAt)) }, status: serviceReservationStatusEnum.BOOKED })
    .select("_id").maxTimeMS(5000).lean();
  return buildAssistantBookingPreview({ conflict, date: payload.date, location: availability.values().next().value.location, services, totalPrice, snapshot });
}

export function buildAssistantBookingPreview({ conflict, date, location, services, totalPrice, snapshot }) {
  return { status: conflict ? "existing_reservation" : services.every((entry) => entry.available) ? "ready" : "slot_unavailable", generatedAt: getNowCairo().toUTC().toISO(),
    timezone: CAIRO_TIMEZONE, date, location, services, totalPrice, currency: "EGP",
    pet: { id: snapshot.pet ? String(snapshot.pet) : null, name: snapshot.petName, type: snapshot.petType, age: snapshot.petAge, gender: snapshot.petGender },
    estimateOnly: true, requiresRefreshBeforeConfirmation: true, slotReserved: false };
}

export const bookingPreviewForComparison = ({ generatedAt, status, ...quote }) => ({
  ...quote, services: quote.services.map(({ available, remaining, ...service }) => service),
});
