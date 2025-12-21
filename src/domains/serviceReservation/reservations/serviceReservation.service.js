import mongoose from "mongoose";
import { ApiError } from "../../../shared/ApiError.js";
import {
  serviceReservationStatusEnum,
  serviceRoomTypeEnum,
  serviceTypeEnum,
} from "../../../shared/constants/enums.js";
import { PetModel } from "../../pet/pet.model.js";
import { UserModel } from "../../user/user.model.js";
import { ServiceReservationModel } from "./serviceReservation.model.js";
import { ServiceSlotInventoryModel } from "../inventory/serviceSlotInventory.model.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import {
  getServiceNameFallback,
  getServiceOptionNameFallback,
  resolveServiceSelectionOrThrow,
} from "../catalog/serviceCatalog.js";
import {
  addHoursUtc,
  cairoSlotToUtcDate,
  ensureWithinWorkingHoursOrThrow,
  formatHourLabel12,
  getNowCairo,
  startOfCurrentHourCairo,
  getWorkingHoursForCairoDate,
  parseCairoDateOrThrow,
  toCairoDateISO,
  toCairoHour24,
} from "./serviceReservation.utils.js";
import { getServiceLocationByIdService } from "../locations/serviceLocation.service.js";

function getRoomTypeForService(serviceType) {
  if (serviceType === serviceTypeEnum.CLINIC) return serviceRoomTypeEnum.CLINIC_ROOM;
  return serviceRoomTypeEnum.GROOMING_ROOM;
}

function getCapacityForRoomType(location, roomType) {
  const caps = location?.capacityByRoomType;
  if (!caps) return 0;
  if (roomType === serviceRoomTypeEnum.CLINIC_ROOM) {
    return typeof caps.clinicRoom === "number" ? caps.clinicRoom : 0;
  }
  return typeof caps.groomingRoom === "number" ? caps.groomingRoom : 0;
}

function parseIdentityOrThrow({ userId, guestId }) {
  if (userId) return { userId, guestId: null };
  if (guestId) return { userId: null, guestId };
  throw new ApiError("Either userId or guestId must be provided", 400);
}

async function findActorReservationAtSameTime({ session, userId, guestId, startsAt }) {
  const identityFilter = userId ? { user: userId } : { guestId };
  return ServiceReservationModel.findOne({
    ...identityFilter,
    startsAt,
    status: serviceReservationStatusEnum.BOOKED,
  })
    .session(session)
    .select("_id")
    .lean();
}

function computeAgeYears(birthDate) {
  if (!birthDate) return null;
  const now = new Date();
  const d = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(d.getTime())) return null;

  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) {
    years -= 1;
  }
  return Math.max(years, 0);
}

async function resolvePetSnapshot({ userId, petId, payload }) {
  const {
    ownerName,
    ownerPhone,
    petType,
    petName,
    age,
    gender,
    comment,
  } = payload;

  const snapshot = {
    ownerName: ownerName || null,
    ownerPhone: ownerPhone || null,
    petType: petType || null,
    petName: petName || null,
    petAge: age != null ? Number(age) : null,
    petGender: gender || null,
    comment: comment || undefined,
    pet: undefined,
  };

  if (userId && (!snapshot.ownerName || !snapshot.ownerPhone)) {
    const user = await UserModel.findById(userId).select("name phone").lean();
    if (user) {
      snapshot.ownerName = snapshot.ownerName || user.name || null;
      snapshot.ownerPhone = snapshot.ownerPhone || user.phone || null;
    }
  }

  if (petId) {
    if (!userId) {
      throw new ApiError("petId is only allowed for logged-in users", 400);
    }

    const pet = await PetModel.findOne({ _id: petId, petOwner: userId })
      .select("_id name type gender birthDate")
      .lean();

    if (!pet) {
      throw new ApiError("Pet not found for this user", 404);
    }

    snapshot.pet = pet._id;
    snapshot.petName = snapshot.petName || pet.name || null;
    snapshot.petType = snapshot.petType || pet.type || null;
    snapshot.petGender = snapshot.petGender || pet.gender || null;

    const derivedAge = computeAgeYears(pet.birthDate);
    if (snapshot.petAge == null && derivedAge != null) {
      snapshot.petAge = derivedAge;
    }
  }

  const missing = [];
  if (!snapshot.ownerName) missing.push("ownerName");
  if (!snapshot.ownerPhone) missing.push("ownerPhone");
  if (!snapshot.petType) missing.push("petType");
  if (!snapshot.petName) missing.push("petName");
  if (snapshot.petAge == null || Number.isNaN(snapshot.petAge)) missing.push("age");
  if (!snapshot.petGender) missing.push("gender");

  if (missing.length) {
    throw new ApiError(
      `Missing required reservation fields: ${missing.join(", ")}`,
      400
    );
  }

  return snapshot;
}

function buildReservationDto(reservation, location, lang) {
  const localDate = toCairoDateISO(reservation.startsAt);
  const hour24 = toCairoHour24(reservation.startsAt);
  const label = formatHourLabel12(hour24);

  const normalizedLang = lang === "ar" ? "ar" : "en";

  const serviceName =
    pickLocalizedField(reservation, "serviceName", normalizedLang) ||
    getServiceNameFallback(reservation.serviceType, normalizedLang);

  const serviceOptionName = reservation.serviceOptionKey
    ? pickLocalizedField(reservation, "serviceOptionName", normalizedLang) ||
      getServiceOptionNameFallback(
        reservation.serviceType,
        reservation.serviceOptionKey,
        normalizedLang
      )
    : "";

  return {
    id: reservation._id,
    userId: reservation.user || null,
    guestId: reservation.guestId || null,
    location: location
      ? {
          id: location._id,
          name: pickLocalizedField(location, "name", normalizedLang),
          city: location.city,
          slug: location.slug,
          googleMapsLink: location.googleMapsLink || null,
          phone: location.phone || null,
        }
      : reservation.location,
    serviceType: reservation.serviceType,
    serviceName,
    serviceOptionKey: reservation.serviceOptionKey || null,
    serviceOptionName: serviceOptionName || null,
    startsAt: reservation.startsAt,
    endsAt: reservation.endsAt,
    status: reservation.status,
    cancelledAt: reservation.cancelledAt || null,
    servicePrice: reservation.servicePrice,
    currency: reservation.currency,
    petId: reservation.pet || null,
    ownerName: reservation.ownerName,
    ownerPhone: reservation.ownerPhone,
    petType: reservation.petType,
    petName: reservation.petName,
    age: reservation.petAge,
    gender: reservation.petGender,
    comment: reservation.comment || null,
    localDate,
    hour24,
    label,
    timezone: "Africa/Cairo",
  };
}

function assertWithinBookingWindowOrThrow(cairoDateStart) {
  const now = getNowCairo().startOf("day");
  const diffDays = cairoDateStart.diff(now, "days").days;

  if (diffDays < 0) {
    throw new ApiError("Cannot book in the past", 400);
  }

  if (diffDays > 15) {
    throw new ApiError("Cannot book more than 15 days ahead", 400);
  }
}

export async function getAvailabilityService({ locationId, serviceType, date, lang }) {
  const location = await getServiceLocationByIdService(locationId);
  if (!location || !location.active) {
    throw new ApiError("Service location not found", 404);
  }

  const normalizedLang = lang === "ar" ? "ar" : "en";

  const roomType = getRoomTypeForService(serviceType);
  const capacity = getCapacityForRoomType(location, roomType);

  const cairoDateStart = parseCairoDateOrThrow(date);
  const { startHour, endHour } = getWorkingHoursForCairoDate(cairoDateStart);

  const startsAtUtcList = [];
  for (let hour24 = startHour; hour24 < endHour; hour24 += 1) {
    const utcDate = cairoDateStart
      .set({ hour: hour24, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
    startsAtUtcList.push(utcDate);
  }

  const inventories = await ServiceSlotInventoryModel.find({
    location: location._id,
    roomType,
    startsAt: { $in: startsAtUtcList },
  })
    .select("startsAt capacity bookedCount")
    .lean();

  const invByStartsAt = new Map(
    inventories.map((inv) => [new Date(inv.startsAt).toISOString(), inv])
  );

  const slots = [];
  for (let hour24 = startHour; hour24 < endHour; hour24 += 1) {
    const startsAtUtc = cairoDateStart
      .set({ hour: hour24, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();

    const key = startsAtUtc.toISOString();
    const inv = invByStartsAt.get(key);
    const booked = inv ? Number(inv.bookedCount) || 0 : 0;

    const label = formatHourLabel12(hour24);

    slots.push({
      hour24,
      label,
      capacity,
      booked,
      remaining: Math.max(capacity - booked, 0),
      available: booked < capacity,
    });
  }

  return {
    location: {
      id: location._id,
      name: pickLocalizedField(location, "name", normalizedLang),
      city: location.city,
      slug: location.slug,
      googleMapsLink: location.googleMapsLink || null,
      phone: location.phone || null,
    },
    serviceType,
    roomType,
    date: cairoDateStart.toFormat("yyyy-LL-dd"),
    timezone: location.timezone,
    workingHours: {
      startHour24: startHour,
      endHour24: endHour,
      startLabel: formatHourLabel12(startHour),
      endLabel: formatHourLabel12(endHour),
    },
    slots,
  };
}

export async function createReservationService({ userId, guestId, payload, lang }) {
  const identity = parseIdentityOrThrow({ userId, guestId });

  const location = await getServiceLocationByIdService(payload.locationId);
  if (!location || !location.active) {
    throw new ApiError("Service location not found", 404);
  }

  const serviceType = payload.serviceType;
  const roomType = getRoomTypeForService(serviceType);
  const capacity = getCapacityForRoomType(location, roomType);

  if (capacity <= 0) {
    throw new ApiError("Selected service is not available at this location", 400);
  }

  const cairoDateStart = parseCairoDateOrThrow(payload.date);
  assertWithinBookingWindowOrThrow(cairoDateStart);

  const { hour24, utcDate: startsAt } = cairoSlotToUtcDate({
    dateISO: payload.date,
    hour12: payload.hour12,
    ampm: payload.ampm,
  });

  ensureWithinWorkingHoursOrThrow({ cairoDateStart, hour24 });

  const cairoSlot = parseCairoDateOrThrow(payload.date)
    .set({ hour: hour24, minute: 0, second: 0, millisecond: 0 });
  if (cairoSlot < startOfCurrentHourCairo()) {
    throw new ApiError("Cannot book in the past", 400);
  }

  const endsAt = addHoursUtc(startsAt, 1);

  const snapshot = await resolvePetSnapshot({
    userId: identity.userId,
    petId: payload.petId,
    payload,
  });

  const selection = resolveServiceSelectionOrThrow({
    serviceType,
    optionKey: payload.serviceOptionKey,
  });

  const session = await mongoose.startSession();
  let created;

  try {
    await session.withTransaction(async () => {
      const existing = await findActorReservationAtSameTime({
        session,
        userId: identity.userId,
        guestId: identity.guestId,
        startsAt,
      });
      if (existing) {
        throw new ApiError("You already have a reservation at this time", 409);
      }

      const slotKey = {
        location: location._id,
        roomType,
        startsAt,
      };

      // 1) Try to increment an existing slot if it still has remaining capacity.
      const updateExisting = await ServiceSlotInventoryModel.updateOne(
        {
          ...slotKey,
          bookedCount: { $lt: capacity },
        },
        {
          $set: { capacity },
          $inc: { bookedCount: 1 },
        },
        { session }
      );

      if (updateExisting.modifiedCount === 0) {
        // 2) If no existing slot was updated, attempt to create a new slot with bookedCount=1.
        // If it already exists (race), retry the update.
        try {
          await ServiceSlotInventoryModel.create(
            [
              {
                ...slotKey,
                capacity,
                bookedCount: 1,
              },
            ],
            { session }
          );
        } catch (err) {
          if (err?.code !== 11000) {
            throw err;
          }

          const retry = await ServiceSlotInventoryModel.updateOne(
            {
              ...slotKey,
              bookedCount: { $lt: capacity },
            },
            {
              $set: { capacity },
              $inc: { bookedCount: 1 },
            },
            { session }
          );

          if (retry.modifiedCount === 0) {
            throw new ApiError("Selected time is fully booked", 409);
          }
        }
      }

      const doc = {
        user: identity.userId || undefined,
        guestId: identity.guestId || undefined,
        location: location._id,
        serviceType,
        serviceOptionKey: selection.serviceOptionKey,
        serviceName_en: selection.serviceName_en,
        serviceName_ar: selection.serviceName_ar,
        serviceOptionName_en: selection.serviceOptionName_en,
        serviceOptionName_ar: selection.serviceOptionName_ar,
        roomType,
        startsAt,
        endsAt,
        status: serviceReservationStatusEnum.BOOKED,
        servicePrice: selection.servicePrice,
        currency: selection.currency,
        pet: snapshot.pet,
        ownerName: snapshot.ownerName,
        ownerPhone: snapshot.ownerPhone,
        petType: snapshot.petType,
        petName: snapshot.petName,
        petAge: snapshot.petAge,
        petGender: snapshot.petGender,
        comment: snapshot.comment,
      };

      created = await ServiceReservationModel.create([doc], { session }).then(
        (res) => res[0]
      );
    });
  } finally {
    session.endSession();
  }

  if (!created) {
    throw new ApiError("Failed to create reservation", 500);
  }

  return buildReservationDto(created, location, lang);
}

export async function listReservationsForUserService({
  userId,
  scope = "upcoming",
  status,
  lang,
}) {
  if (!userId) {
    throw new ApiError("userId is required", 400);
  }

  const nowUtc = getNowCairo().toUTC().toJSDate();

  const filter = { user: userId };
  if (status) {
    filter.status = status;
  }

  if (scope === "upcoming") {
    filter.startsAt = { $gte: nowUtc };
  } else if (scope === "past") {
    filter.startsAt = { $lt: nowUtc };
  }

  const reservations = await ServiceReservationModel.find(filter)
    .populate(
      "location",
      "_id slug name_en name_ar city timezone googleMapsLink phone"
    )
    .sort({ startsAt: 1 })
    .lean();

  return {
    results: reservations.length,
    data: reservations.map((r) => buildReservationDto(r, r.location, lang)),
  };
}

export async function listReservationsForGuestService({
  guestId,
  scope = "upcoming",
  status,
  lang,
}) {
  if (!guestId) {
    throw new ApiError("guestId is required", 400);
  }

  const nowUtc = getNowCairo().toUTC().toJSDate();

  const filter = { guestId };
  if (status) {
    filter.status = status;
  }

  if (scope === "upcoming") {
    filter.startsAt = { $gte: nowUtc };
  } else if (scope === "past") {
    filter.startsAt = { $lt: nowUtc };
  }

  const reservations = await ServiceReservationModel.find(filter)
    .populate(
      "location",
      "_id slug name_en name_ar city timezone googleMapsLink phone"
    )
    .sort({ startsAt: 1 })
    .lean();

  return {
    results: reservations.length,
    data: reservations.map((r) => buildReservationDto(r, r.location, lang)),
  };
}

async function getReservationForActorOrThrow({ session, id, userId, guestId }) {
  const identity = parseIdentityOrThrow({ userId, guestId });
  const filter = { _id: id };

  if (identity.userId) {
    filter.user = identity.userId;
  } else {
    filter.guestId = identity.guestId;
  }

  const reservation = await ServiceReservationModel.findOne(filter)
    .session(session)
    .exec();

  if (!reservation) {
    throw new ApiError("Reservation not found", 404);
  }

  return reservation;
}

export async function cancelReservationService({ id, userId, guestId, lang }) {
  const session = await mongoose.startSession();
  let cancelled = null;

  try {
    await session.withTransaction(async () => {
      const reservation = await getReservationForActorOrThrow({
        session,
        id,
        userId,
        guestId,
      });

      if (reservation.status === serviceReservationStatusEnum.CANCELLED) {
        cancelled = reservation;
        return;
      }

      const nowUtc = getNowCairo().toUTC().toJSDate();
      const cutoff = new Date(reservation.startsAt.getTime() - 24 * 60 * 60 * 1000);
      if (nowUtc > cutoff) {
        throw new ApiError(
          "Cancellation is only allowed up to 24 hours before the reservation time",
          400
        );
      }

      reservation.status = serviceReservationStatusEnum.CANCELLED;
      reservation.cancelledAt = nowUtc;
      await reservation.save({ session });

      await ServiceSlotInventoryModel.updateOne(
        {
          location: reservation.location,
          roomType: reservation.roomType,
          startsAt: reservation.startsAt,
          bookedCount: { $gt: 0 },
        },
        { $inc: { bookedCount: -1 } },
        { session }
      );

      cancelled = reservation;
    });
  } finally {
    session.endSession();
  }

  if (!cancelled) {
    throw new ApiError("Failed to cancel reservation", 500);
  }

  const location = await getServiceLocationByIdService(cancelled.location);
  return buildReservationDto(cancelled, location, lang);
}
