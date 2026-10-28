import assert from "node:assert/strict";
import test from "node:test";
import { Settings } from "luxon";
import { cartProposalFixture, W } from "./fixtures/cartProposals.js";
import { getAssistantBookingOptions, getAssistantBookingPreview } from "../../../src/domains/assistant/customer/assistant.booking-reads.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { ServiceCatalogModel } from "../../../src/domains/serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceLocationModel } from "../../../src/domains/serviceReservation/locations/serviceLocation.model.js";
import { ServiceSlotInventoryModel } from "../../../src/domains/serviceReservation/inventory/serviceSlotInventory.model.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";
import { AssistantAccount } from "../../../src/domains/assistant/shared/assistant.models.js";

const L = "444444444444444444444444";
function fixture(t) {
  const f = cartProposalFixture(t, { confirmation: true });
  const old = Settings.now; Settings.now = () => Date.parse("2026-10-22T09:00:00Z"); t.after(() => { Settings.now = old; });
  f.apiConfig = { ...f.config, bookingReadsEnabled: true };
  f.body = { location: { governorateCode: "alexandria", areaCode: "smouha" }, language: "en" };
  f.user.name = "PRIVATE owner"; f.user.phone = "PRIVATE phone";
  const query = (read) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, session() { return this; },
    lean() { return Promise.resolve().then(read); }, then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  const warehouse = { _id: W, governorate: "alexandria", code: "ALEXO03", active: true, fulfillment: { status: "OPERATIONAL" } };
  t.mock.method(WarehouseModel, "findOne", () => query(() => warehouse));
  t.mock.method(WarehouseModel, "findById", () => query(() => warehouse));
  f.definition = { type: "CLINIC", name_en: "Clinic", name_ar: "كشف", isActive: true,
    options: [{ key: "checkup", name_en: "Check Up", name_ar: "كشف", price: 75 }] };
  f.branch = { _id: L, name_en: "Alex branch", name_ar: "الفرع", city: "Alexandria", slug: "alex", timezone: "Africa/Cairo", active: true,
    capacityByRoomType: { clinicRoom: 1, groomingRoom: 1 } };
  f.catalogReads = 0;
  t.mock.method(ServiceCatalogModel, "find", (filter) => query(async () => {
    f.catalogReads++; assert.equal(filter.isActive, true); assert.deepEqual(filter.type.$in, ["GROOMING", "SHOWERING", "CLINIC"]);
    await f.onCatalog?.(); return [f.definition];
  }));
  t.mock.method(ServiceCatalogModel, "findOne", () => query(() => f.definition));
  t.mock.method(ServiceLocationModel, "find", (filter) => query(() => {
    assert.equal(filter.active, true); assert.equal(filter.city.test("Alexandria"), true); assert.equal(filter.city.test("Cairo"), false); return [f.branch];
  }));
  t.mock.method(ServiceLocationModel, "findById", () => query(() => f.branch));
  t.mock.method(ServiceSlotInventoryModel, "find", () => query(() => []));
  t.mock.method(ServiceReservationModel, "findOne", (filter) => query(() => { assert.equal(String(filter.user), String(f.owner)); return null; }));
  for (const Model of [ServiceCatalogModel, ServiceLocationModel, ServiceSlotInventoryModel, ServiceReservationModel])
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany"]) t.mock.method(Model, method, () => assert.fail("No booking/stock writes"));
  f.options = (body = f.body) => getAssistantBookingOptions(f.owner, body, f.apiConfig);
  f.preview = () => getAssistantBookingPreview(f.owner, { ...f.body, booking: { locationId: L, serviceType: "CLINIC", serviceOptionKey: "checkup",
    date: "2026-10-24", hour24: 10, petType: "cat", petName: "Milo", age: 3, gender: "male" } }, f.apiConfig);
  return f;
}
test("booking options resolve the current manual area on backend and expose bounded active catalog/branches", async (t) => {
  const f = fixture(t), result = await f.options();
  assert.equal(result.eligible, true); assert.equal(result.services[0].options[0].price, 75); assert.equal(result.locations[0].id, L);
  assert.equal(result.governorateCode, "alexandria"); assert.equal(f.account.bookingReadRateCount, 1);
  assert.equal(f.account.dayMessages, undefined); assert.equal(f.account.cartRateCount, undefined);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false); assert.equal(f.cartWrites, 0);
});
test("preview uses trusted resolver output and actual read-only reservation domain preview", async (t) => {
  const f = fixture(t), result = await f.preview();
  assert.equal(result.eligible, true); assert.equal(result.status, "ready"); assert.equal(result.totalPrice, 75); assert.equal(result.slotReserved, false);
  assert.equal(result.location.id, L); assert.equal(result.pet.name, "Milo"); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
test("outside or unknown service eligibility produces no catalog/branch offer despite Alexandria warehouse", async (t) => {
  const f = fixture(t), result = await f.options({ ...f.body, location: { governorateCode: "cairo", areaCode: "maadi" } });
  assert.equal(result.eligible, false); assert.equal(result.reason, "booking_region_unavailable"); assert.deepEqual(result.services, []);
  assert.deepEqual(result.locations, []); assert.equal(f.catalogReads, 0); assert.equal(f.account.bookingReadRateCount, 1);
});
test("feature flag, active user, assistant restriction and current authority fail before/after reads", async (t) => {
  const f = fixture(t); f.apiConfig.bookingReadsEnabled = false; await assert.rejects(f.options(), { code: "booking_reads_unavailable" });
  f.apiConfig.bookingReadsEnabled = true; f.user.active = false; await assert.rejects(f.options(), { code: "authentication_required" });
  f.user.active = true; f.account.blocked = true; await assert.rejects(f.options(), { code: "ai_restricted" });
  f.account.blocked = false; f.onCatalog = () => { f.account.blocked = true; };
  await assert.rejects(f.options(), { code: "ai_restricted" }); assert.equal(f.account.bookingReadRateCount, 1);
});
test("booking read rate is durable and separate, with reset and corrupt-state protection", async (t) => {
  const f = fixture(t); f.apiConfig.rateMax = 1; await f.options();
  await assert.rejects(f.options(), { code: "booking_request_rate_limit", status: 429 });
  f.account.bookingReadRateStart = new Date(0); await f.options(); assert.equal(f.account.bookingReadRateCount, 1);
  f.account.bookingReadRateCount = -1; await assert.rejects(f.options(), { code: "booking_read_rate_unavailable", status: 503 });
});
test("timeout discards late catalog results without sending a booking or a second result", async (t) => {
  const f = fixture(t); f.apiConfig.timeoutMs = 5; let release;
  f.onCatalog = () => new Promise((resolve) => { release = resolve; });
  await assert.rejects(f.options(), { code: "booking_read_timeout" }); release();
  assert.equal(f.cartWrites, 0); assert.equal(f.account.bookingReadRateCount, 1);
});
test("forged location evidence, extra identity fields and malformed internal input fail before admission", async (t) => {
  const f = fixture(t);
  for (const body of [{ ...f.body, resolvedLocation: { eligible: true } }, { ...f.body, owner: String(f.owner) },
    { ...f.body, location: { ...f.body.location, isPrimeLocation: true } }, { ...f.body, location: { lat: 31, lng: 29, governorateCode: "alexandria" } },
    { ...f.body, location: { lat: "31", lng: 29 } }]) await assert.rejects(f.options(body), { code: "invalid_request" });
  assert.equal(f.account.bookingReadRateCount, undefined);
});
test("unavailable catalog and malformed prices cannot yield a selectable option", async (t) => {
  const f = fixture(t); f.definition.options[0].price = NaN;
  await assert.rejects(f.options(), { code: "booking_catalog_unavailable", status: 503 });
  f.definition.options[0].price = 75; f.definition.options.push({ ...f.definition.options[0] });
  await assert.rejects(f.options(), { code: "booking_catalog_unavailable", status: 503 });
});
