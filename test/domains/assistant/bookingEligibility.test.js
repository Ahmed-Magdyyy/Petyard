import assert from "node:assert/strict";
import test from "node:test";
import { assistantBookingEligibility, requireAssistantBookingLocation } from "../../../src/domains/serviceReservation/reservations/serviceReservation.eligibility.js";

test("assistant booking eligibility uses the backend resolver's GPS or manual governorate", () => {
  for (const resolved of [
    { location: { source: "gps", governorate: { normalized: "alexandria", raw: null } },
      delivery: { coverageStatus: "INSIDE_BOUNDARY" }, zoneWarehouse: { governorate: "alexandria" }, warehouse: { governorate: "cairo" } },
    { location: { source: "gps", governorate: { normalized: "alexandria", raw: "Alexandria Governorate" } },
      delivery: { coverageStatus: "OUTSIDE_BOUNDARIES_SUPPORTED_GOVERNORATE" }, warehouse: { governorate: "cairo" } },
    { location: { source: "manual", governorate: { name: "alexandria" } } },
  ]) assert.deepEqual(requireAssistantBookingLocation(resolved), { eligible: true, reason: null, governorateCode: "alexandria" });
});
test("warehouse, prime status, profile text and model city claims never establish booking eligibility", () => {
  for (const resolved of [undefined, {}, { city: "Alexandria" }, { governorate: "alexandria" },
    { warehouse: { governorate: "alexandria" }, zoneWarehouse: { governorate: "alexandria" }, isPrimeLocation: true },
    { location: { source: "model", governorate: { normalized: "alexandria", name: "alexandria" } } },
    { location: { source: "gps", governorate: { raw: "Alexandria" } } },
    { location: { source: "gps", governorate: { normalized: "alexandria" } } },
    { location: { source: "manual", governorate: { normalized: "alexandria" } } },
  ]) {
    assert.deepEqual(assistantBookingEligibility(resolved), { eligible: false, reason: "booking_location_required", governorateCode: null });
    assert.throws(() => requireAssistantBookingLocation(resolved), { statusCode: 409 });
  }
});
test("failed GPS geocoding cannot inherit booking eligibility from the default warehouse governorate", () => {
  for (const coverageStatus of ["OUTSIDE_BOUNDARIES_UNSUPPORTED_GOVERNORATE", "UNKNOWN", undefined]) {
    const resolved = { location: { source: "gps", governorate: { normalized: "alexandria", raw: null } },
      warehouse: { governorate: "alexandria" }, zoneWarehouse: { governorate: "alexandria" }, delivery: { coverageStatus } };
    assert.equal(assistantBookingEligibility(resolved).reason, "booking_location_required");
    assert.throws(() => requireAssistantBookingLocation(resolved), { statusCode: 409 });
  }
});
test("all other governorates remain ineligible even when shopping is routed to Alexandria", () => {
  for (const source of ["gps", "manual"]) for (const city of ["cairo", "giza", "beheira", "alex", "الإسكندرية"]) {
    const resolved = { warehouse: { governorate: "alexandria" }, warehouseRouting: { rerouted: true },
      location: { source, governorate: source === "gps" ? { normalized: city } : { name: city } } };
    assert.equal(assistantBookingEligibility(resolved).eligible, false); assert.throws(() => requireAssistantBookingLocation(resolved), { statusCode: 403 });
  }
});
