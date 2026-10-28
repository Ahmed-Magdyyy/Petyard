import express from "express";
import { objectId } from "../shared/assistant.validation.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { access, admit, input, timedRead, resultLimit } from "./assistant.booking-read-core.js";
import { bookingOptionsFromRows } from "./assistant.booking-options.dto.js";
export { bookingLocationInput, resolveAssistantBookingArea } from "./assistant.booking-read-core.js";
import { resolveLocationByCoordinatesService } from "../../location/location.service.js";
import { ServiceCatalogModel } from "../../serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceLocationModel } from "../../serviceReservation/locations/serviceLocation.model.js";
import { previewUserReservationService } from "../../serviceReservation/reservations/serviceReservation.preview.js";
import { assistantBookingEligibility } from "../../serviceReservation/reservations/serviceReservation.eligibility.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { requireBookingReads } from "../shared/assistant.config.js";
import { bookingOptionsValidator, bookingPreviewValidator } from "./assistant.booking-reads.validators.js";

async function execute(ownerValue, body, config, preview) {
  requireBookingReads(config); const owner = objectId(String(ownerValue)), args = input(body, preview);
  await admit(owner, config);
  try {
    const work = async () => {
      const resolved = await resolveLocationByCoordinatesService(args.location);
      const eligibility = assistantBookingEligibility(resolved);
      if (!eligibility.eligible) return { ...eligibility, services: [], locations: [], estimateOnly: true };
      if (preview) return { eligible: true, reason: null, governorateCode: "alexandria",
        ...await previewUserReservationService({ userId: String(owner), resolvedLocation: resolved, payload: args.booking, lang: args.language }) };
      const definitions = await ServiceCatalogModel.find({ isActive: true, type: { $in: ["GROOMING", "SHOWERING", "CLINIC"] } })
        .select("type name_en name_ar options").sort({ type: 1 }).limit(4).maxTimeMS(5000).lean();
      const locations = await ServiceLocationModel.find({ active: true, city: /^alexandria$/i })
        .select("_id name_en name_ar city slug timezone").sort({ _id: 1 }).limit(51).maxTimeMS(5000).lean();
      return bookingOptionsFromRows(definitions, locations, args.language);
    };
    const result = await timedRead(config, work);
    await access(owner, config);
    if (Buffer.byteLength(JSON.stringify(result)) > resultLimit) reject("booking_preview_too_large", 413);
    return result;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof ApiError && [400, 404, 409].includes(error.statusCode)) reject("booking_preview_invalid", error.statusCode);
    if (error instanceof ApiError && error.statusCode === 403) reject("booking_region_unavailable", 403);
    throw error;
  }
}
export const getAssistantBookingOptions = (owner, body, config) => execute(owner, body, config, false);
export const getAssistantBookingPreview = (owner, body, config) => execute(owner, body, config, true);
export { access as assertBookingReadAccess };

export function createAssistantBookingRouter({ getConfig, application = { getAssistantBookingOptions, getAssistantBookingPreview } } = {}) {
  const router = express.Router();
  const gate = (_req, _res, next) => { try { requireBookingReads(getConfig()); next(); } catch (error) { next(error); } };
  const handle = (method) => async (req, res, next) => {
    try { const result = await application[method](req.user._id, req.body, getConfig()); requireBookingReads(getConfig()); res.json({ data: result }); }
    catch (error) { next(error); }
  };
  router.post("/options", gate, bookingOptionsValidator, handle("getAssistantBookingOptions"));
  router.post("/preview", gate, bookingPreviewValidator, handle("getAssistantBookingPreview"));
  return router;
}
