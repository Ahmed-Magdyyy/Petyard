import { ApiError } from "../../../shared/utils/ApiError.js";

// Internal assistant rule. Pass backend location-resolver output, never a model's city claim or the fulfillment warehouse.
export function assistantBookingEligibility(resolvedLocation) {
  const location = resolvedLocation?.location, governorate = location?.governorate;
  const source = location?.source;
  const raw = source === "gps" ? governorate?.normalized : source === "manual" ? governorate?.name : null;
  const code = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!code) return { eligible: false, reason: "booking_location_required", governorateCode: null };
  if (source === "gps" && code === "alexandria") {
    const coverage = resolvedLocation.delivery?.coverageStatus;
    const zone = resolvedLocation.zoneWarehouse?.governorate;
    const insideAlexBoundary = coverage === "INSIDE_BOUNDARY" && typeof zone === "string" && zone.trim().toLowerCase() === "alexandria";
    const reverseGeocodedAlex = coverage === "OUTSIDE_BOUNDARIES_SUPPORTED_GOVERNORATE" &&
      typeof governorate.raw === "string" && governorate.raw.trim().length > 0;
    // The resolver can copy the default warehouse's governorate after failed geocoding; that display fallback is not user-location evidence.
    if (!insideAlexBoundary && !reverseGeocodedAlex) return { eligible: false, reason: "booking_location_required", governorateCode: null };
  }
  return { eligible: code === "alexandria", reason: code === "alexandria" ? null : "booking_region_unavailable", governorateCode: code };
}

export function requireAssistantBookingLocation(resolvedLocation) {
  const eligibility = assistantBookingEligibility(resolvedLocation);
  if (!eligibility.eligible) throw new ApiError(eligibility.reason === "booking_location_required"
    ? "Resolve the user's current area before offering booking"
    : "Booking services are currently available only in Alexandria", eligibility.reason === "booking_location_required" ? 409 : 403);
  return eligibility;
}
