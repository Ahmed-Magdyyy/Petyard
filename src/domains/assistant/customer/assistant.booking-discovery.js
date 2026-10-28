import mongoose from "mongoose";
import { resolveLocationByCoordinatesService } from "../../location/location.service.js";
import { assistantBookingEligibility } from "../../serviceReservation/reservations/serviceReservation.eligibility.js";
import { requireBookingReads } from "../shared/assistant.config.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { access, admit, input, timedRead, resultLimit } from "./assistant.booking-read-core.js";
import { bookingOptionsFromRows } from "./assistant.booking-options.dto.js";

// Same admission, resolver and DTO as HTTP reads, without importing ordinary booking models into the worker.
export async function readChatBookingOptions(ownerValue, body, config) {
  requireBookingReads(config); const owner = objectId(String(ownerValue)), args = input(body, false);
  await admit(owner, config);
  const result = await timedRead(config, async () => {
    const resolved = await resolveLocationByCoordinatesService(args.location), eligibility = assistantBookingEligibility(resolved);
    if (!eligibility.eligible) return { ...eligibility, services: [], locations: [], estimateOnly: true };
    const definitions = await mongoose.connection.db.collection("servicecatalogs").find(
      { isActive: true, type: { $in: ["GROOMING", "SHOWERING", "CLINIC"] } },
      { projection: { type: 1, name_en: 1, name_ar: 1, options: 1 }, sort: { type: 1 }, limit: 4, maxTimeMS: 5000 }).toArray();
    const locations = await mongoose.connection.db.collection("servicelocations").find(
      { active: true, city: /^alexandria$/i },
      { projection: { _id: 1, name_en: 1, name_ar: 1, city: 1, slug: 1, timezone: 1 }, sort: { _id: 1 }, limit: 51, maxTimeMS: 5000 }).toArray();
    return bookingOptionsFromRows(definitions, locations, args.language);
  });
  await access(owner, config);
  if (Buffer.byteLength(JSON.stringify(result)) > resultLimit) reject("booking_preview_too_large", 413);
  return result;
}
