import mongoose from "mongoose";
import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { accountStatus, serviceRoomTypeEnum, serviceReservationStatusEnum } from "../../../shared/constants/enums.js";
import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { UserModel } from "../../user/user.model.js";
import { PetModel } from "../../pet/pet.model.js";
import { ServiceCatalogModel } from "../catalog/serviceCatalog.model.js";
import { resolveServiceSelectionFromDefinition } from "../catalog/serviceCatalog.service.js";
import { ServiceLocationModel } from "../locations/serviceLocation.model.js";
import { ServiceSlotInventoryModel } from "../inventory/serviceSlotInventory.model.js";
import { ServiceReservationModel } from "./serviceReservation.model.js";
import { resolvePetSnapshot } from "./serviceReservation.service.js";
import { parseAssistantBookingSelection, buildAssistantBookingPreview, bookingPreviewForComparison } from "./serviceReservation.preview.js";
import { addHoursUtc, formatHourLabel12 } from "./serviceReservation.utils.js";

const fail = (code, status = 409) => { const error = new ApiError(code, status); error.code = code; throw error; };
const read = (query, session) => query.maxTimeMS(5000).session(session).lean();

async function fence(Model, snapshot, session) {
  if (!snapshot || !Number.isSafeInteger(snapshot.__v) || snapshot.__v < 0 || snapshot.__v >= Number.MAX_SAFE_INTEGER) fail("booking_context_unavailable", 503);
  const filter = { _id: snapshot._id };
  for (const [key, value] of Object.entries(snapshot)) if (key !== "_id") filter[key] = { $eq: value, $exists: true };
  // A real write prevents a concurrent catalog/branch/profile change from passing a stale snapshot.
  const result = await Model.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("context_changed");
}

export async function requireAssistantBookingWriteIndexes() {
  let inventory, reservations;
  try { inventory = await ServiceSlotInventoryModel.collection.indexes(); reservations = await ServiceReservationModel.collection.indexes(); }
  catch { fail("booking_write_store_unavailable", 503); }
  const full = (entry) => entry.unique === true && !entry.sparse && (!entry.collation || entry.collation.locale === "simple") && entry.expireAfterSeconds === undefined;
  if (!inventory.some((entry) => full(entry) && JSON.stringify(entry.key) === '{"location":1,"roomType":1,"startsAt":1}' && !entry.partialFilterExpression) ||
    !reservations.some((entry) => full(entry) && JSON.stringify(entry.key) === '{"user":1,"startsAt":1}' &&
      JSON.stringify(entry.partialFilterExpression) === '{"status":"BOOKED"}') ||
    [...inventory, ...reservations].some((entry) => entry.expireAfterSeconds !== undefined)) fail("booking_write_store_unavailable", 503);
}

// The authenticated coordinator owns AI access, proposal/context/expiry checks and transaction commit.
export async function writeConfirmedAssistantBooking({ userId, payload, lang = "en", resolvedLocation }, expectedQuote, { session } = {}) {
  if (!session?.inTransaction?.()) fail("booking_transaction_required", 503);
  await requireAssistantBookingWriteIndexes();
  payload = structuredClone(payload);
  expectedQuote = JSON.parse(JSON.stringify(expectedQuote));
  const parsed = parseAssistantBookingSelection({ userId, resolvedLocation, payload, lang });
  const user = await read(UserModel.findById(userId).select("active phoneVerified deletedAt account_status name phone __v"), session);
  if (!user || !user.active || user.deletedAt || !user.phoneVerified || [accountStatus.BANNED, accountStatus.DELETED].includes(user.account_status)) fail("access_denied", 403);
  const branch = await read(ServiceLocationModel.findById(parsed.locationId).select("name_en name_ar city slug timezone googleMapsLink phone active capacityByRoomType __v"), session);
  if (!branch?.active || typeof branch.city !== "string" || branch.city.trim().toLowerCase() !== "alexandria") fail("booking_proposal_changed");
  const pet = payload.petId == null ? null : await read(PetModel.findOne({ _id: payload.petId, petOwner: userId }).select("petOwner name type gender birthDate __v"), session);
  if (payload.petId != null && !pet) fail("booking_proposal_changed");
  const snapshot = await resolvePetSnapshot({ userId, petId: payload.petId, payload, lang, session });
  const definitions = new Map(), selections = [], slots = [], services = []; let totalPrice = 0;
  for (const [index, item] of parsed.requested.entries()) {
    if (!definitions.has(item.serviceType)) {
      const definition = await read(ServiceCatalogModel.findOne({ type: item.serviceType, isActive: true }).select("type isActive name_en name_ar options __v"), session);
      if (!definition || definition.isActive !== true || !Array.isArray(definition.options) || definition.options.length > 100) fail("booking_proposal_changed");
      const keys = definition.options.map((option) => option.key);
      if (keys.some((key) => typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > 128) || new Set(keys).size !== keys.length) fail("booking_proposal_changed");
      definitions.set(item.serviceType, definition);
    }
    const selection = resolveServiceSelectionFromDefinition({ serviceType: item.serviceType, optionKey: item.serviceOptionKey }, definitions.get(item.serviceType));
    if (!Number.isFinite(selection.servicePrice) || selection.servicePrice < 0) fail("booking_proposal_changed");
    const roomType = item.serviceType === "CLINIC" ? serviceRoomTypeEnum.CLINIC_ROOM : serviceRoomTypeEnum.GROOMING_ROOM;
    const capacity = roomType === serviceRoomTypeEnum.CLINIC_ROOM ? branch.capacityByRoomType?.clinicRoom : branch.capacityByRoomType?.groomingRoom;
    if (!Number.isSafeInteger(capacity) || capacity <= 0) fail("booking_proposal_changed");
    const startsAt = addHoursUtc(parsed.firstStart, index), endsAt = addHoursUtc(startsAt, 1);
    const slotKey = { location: branch._id, roomType, startsAt };
    const existing = await read(ServiceSlotInventoryModel.findOne(slotKey), session);
    const booked = existing ? existing.bookedCount : 0;
    if (!Number.isSafeInteger(booked) || booked < 0 || booked >= capacity) fail("booking_slot_unavailable");
    services.push({ serviceType: item.serviceType, serviceOptionKey: selection.serviceOptionKey,
      serviceName: pickLocalizedField(selection, "serviceName", lang), serviceOptionName: pickLocalizedField(selection, "serviceOptionName", lang),
      roomType, hour24: payload.hour24 + index, label: formatHourLabel12(payload.hour24 + index), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      price: selection.servicePrice, currency: "EGP", available: true, remaining: capacity - booked });
    slots.push({ existing, slotKey, capacity, booked }); selections.push(selection); totalPrice += selection.servicePrice;
  }
  if (!Number.isFinite(totalPrice)) fail("booking_proposal_changed");
  const conflict = await read(ServiceReservationModel.findOne({ user: userId, status: serviceReservationStatusEnum.BOOKED,
    startsAt: { $in: services.map((entry) => new Date(entry.startsAt)) } }).select("_id"), session);
  if (conflict) fail("booking_existing_reservation");
  const quote = { eligible: true, reason: null, governorateCode: "alexandria", ...buildAssistantBookingPreview({ conflict: null, date: payload.date,
    location: { id: String(branch._id), name: pickLocalizedField(branch, "name", lang), city: branch.city, slug: branch.slug,
      googleMapsLink: branch.googleMapsLink || null, phone: branch.phone || null }, services, totalPrice, snapshot }) };
  if (!isDeepStrictEqual(bookingPreviewForComparison(quote), bookingPreviewForComparison(expectedQuote))) fail("booking_proposal_changed");
  await fence(UserModel, user, session); await fence(ServiceLocationModel, branch, session);
  if (pet) await fence(PetModel, pet, session);
  for (const definition of definitions.values()) await fence(ServiceCatalogModel, definition, session);
  const docs = [];
  for (const [index, slot] of slots.entries()) {
    if (slot.existing) {
      const updated = await ServiceSlotInventoryModel.updateOne({ _id: slot.existing._id, ...slot.slotKey, bookedCount: slot.booked },
        { $set: { capacity: slot.capacity }, $inc: { bookedCount: 1 } }, { session });
      if (updated.matchedCount !== 1 || updated.modifiedCount !== 1) fail("booking_slot_unavailable");
    } else {
      // Duplicate-key errors abort this transaction; retry the whole transaction, never a command in its aborted session.
      await ServiceSlotInventoryModel.create([{ ...slot.slotKey, capacity: slot.capacity, bookedCount: 1 }], { session });
    }
    const selection = selections[index], service = services[index];
    docs.push({ user: new mongoose.Types.ObjectId(userId), location: branch._id, serviceType: selection.serviceType,
      serviceOptionKey: selection.serviceOptionKey, serviceName_en: selection.serviceName_en, serviceName_ar: selection.serviceName_ar,
      serviceOptionName_en: selection.serviceOptionName_en, serviceOptionName_ar: selection.serviceOptionName_ar,
      roomType: service.roomType, startsAt: new Date(service.startsAt), endsAt: new Date(service.endsAt), status: serviceReservationStatusEnum.BOOKED,
      servicePrice: service.price, currency: "EGP", ...snapshot });
  }
  const created = await ServiceReservationModel.insertMany(docs, { session, ordered: true });
  if (created.length !== services.length) fail("booking_write_unavailable", 503);
  parseAssistantBookingSelection({ userId, resolvedLocation, payload, lang });
  return { status: "confirmed", locationId: String(branch._id), date: payload.date, timezone: quote.timezone, currency: "EGP", totalPrice,
    pet: quote.pet, services: services.map(({ available, remaining, ...service }, index) => ({ reservationId: String(created[index]._id), ...service })) };
}
