import assert from "node:assert/strict";
import test from "node:test";
import { DateTime } from "luxon";
import { cartProposalFixture, W, oid } from "./fixtures/cartProposals.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { prepareBookingProposal, getBookingProposal, revalidateBookingProposal } from "../../../src/domains/assistant/customer/assistant.booking-proposals.js";
import { AssistantBookingProposal } from "../../../src/domains/assistant/shared/assistant.booking-proposal.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { ServiceCatalogModel } from "../../../src/domains/serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceLocationModel } from "../../../src/domains/serviceReservation/locations/serviceLocation.model.js";
import { ServiceSlotInventoryModel } from "../../../src/domains/serviceReservation/inventory/serviceSlotInventory.model.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";

const L = "777777777777777777777777";
function fixture(t) {
  const f = cartProposalFixture(t, { confirmation: true });
  f.config = { ...f.config, bookingReadsEnabled: true, rateMax: 100 };
  f.user.name = "PRIVATE owner"; f.user.phone = "PRIVATE phone";
  const query = (read) => ({ select() { return this; }, maxTimeMS() { return this; }, sort() { return this; }, limit() { return this; }, session() { return this; },
    lean() { return Promise.resolve().then(read); }, then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  const warehouse = { _id: W, governorate: "alexandria", code: "ALEXO03", active: true, fulfillment: { status: "OPERATIONAL" } };
  t.mock.method(WarehouseModel, "findOne", () => query(() => warehouse));
  t.mock.method(WarehouseModel, "findById", () => query(() => warehouse));
  f.definition = { type: "CLINIC", isActive: true, name_en: "Clinic", name_ar: "كشف", options: [{ key: "checkup", name_en: "Check Up", name_ar: "كشف", price: 75 }] };
  f.branch = { _id: L, active: true, name_en: "Alex branch", city: "Alexandria", slug: "alex", timezone: "Africa/Cairo", capacityByRoomType: { clinicRoom: 2, groomingRoom: 1 } };
  f.booked = 0; f.conflict = null;
  t.mock.method(ServiceCatalogModel, "findOne", () => query(async () => { await f.onCatalog?.(); return f.definition; }));
  t.mock.method(ServiceLocationModel, "findById", () => query(() => f.branch));
  t.mock.method(ServiceSlotInventoryModel, "find", () => query(() => f.booked ? [{ startsAt: new Date(f.startsAt), bookedCount: f.booked }] : []));
  t.mock.method(ServiceReservationModel, "findOne", () => query(() => f.conflict));
  for (const model of [ServiceCatalogModel, ServiceLocationModel, ServiceSlotInventoryModel, ServiceReservationModel])
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany"]) t.mock.method(model, method, () => assert.fail("No booking/catalog/inventory writes"));
  for (const method of ["createCollection", "createIndexes"]) t.mock.method(AssistantBookingProposal, method, () => assert.fail("No proposal schema initialization"));
  t.mock.method(AssistantBookingProposal.collection, "indexes", async () => f.indexes);
  t.mock.method(AssistantBookingProposal, "findOne", (filter) => query(() => {
    // The competing writer committed outside this transaction's simulated rollback.
    if (f.externalWinner && !f.records.length) f.records.push(f.externalWinner);
    return f.records.find((row) => matchesQuery(row, filter)) ?? null;
  }));
  t.mock.method(AssistantBookingProposal, "create", async ([record], { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true);
    const doc = new AssistantBookingProposal(record); assert.equal(doc.validateSync(), undefined);
    if (f.failInsert) throw new Error("simulated proposal insert failure");
    if (f.race) { f.race = false; f.externalWinner = doc.toObject(); throw Object.assign(new Error("simulated owner/key race"), { code: 11000 }); }
    f.records.push(doc.toObject());
    return [doc];
  });
  f.body = { location: { governorateCode: "alexandria", areaCode: "smouha" }, language: "en", booking: {
    locationId: L, serviceType: "CLINIC", serviceOptionKey: "checkup", date: DateTime.now().setZone("Africa/Cairo").plus({ days: 2 }).toISODate(),
    hour24: 14, petType: "cat", petName: "Milo", age: 3, gender: "male", comment: "PRIVATE note" } };
  f.startsAt = DateTime.fromISO(f.body.booking.date + "T14:00", { zone: "Africa/Cairo" }).toUTC().toISO();
  f.options = { expiresAt: new Date(Date.now() + 60000) };
  f.prepare = (body = f.body, key = "booking-prepare-1", options = f.options) => prepareBookingProposal(f.owner, body, key, f.config, options);
  f.get = (id) => getBookingProposal(f.owner, id, f.config);
  f.check = (proposal, changes = {}) => revalidateBookingProposal(f.owner, proposal.id, {
    expectedVersion: proposal.version, fingerprint: proposal.fingerprint, location: f.body.location, ...changes }, f.config);
  return f;
}
test("booking proposal saves exact ready estimate, with owner-only DTO and no appointment writes", async (t) => {
  const f = fixture(t), result = await f.prepare(), p = result.proposal;
  assert.equal(result.duplicate, false); assert.equal(p.status, "pending"); assert.equal(p.quote.totalPrice, 75);
  assert.equal(p.quote.slotReserved, false); assert.equal(p.quote.pet.name, "Milo"); assert.equal(f.records.length, 1);
  assert.equal(p.fingerprint.length, 64); assert.equal(JSON.stringify(p).includes("PRIVATE"), false);
  assert.equal(f.account.bookingReadRateCount, 1); assert.equal(f.cartWrites, 0);
  assert.deepEqual((await f.get(p.id)).proposal, p);
  const fresh = await f.check(p); assert.equal(fresh.ready, true); assert.equal(fresh.executed, false);
});
test("same owner/key and reordered object keys replay original; changed appointment conflicts", async (t) => {
  const f = fixture(t), first = await f.prepare();
  const body = { booking: Object.fromEntries(Object.entries(f.body.booking).reverse()), language: "en", location: { areaCode: "smouha", governorateCode: "alexandria" } };
  const replay = await f.prepare(body); assert.equal(replay.duplicate, true); assert.deepEqual(replay.proposal, first.proposal);
  assert.equal(f.account.bookingReadRateCount, 1);
  await assert.rejects(f.prepare({ ...f.body, booking: { ...f.body.booking, hour24: 15 } }), { code: "idempotency_conflict" });
  assert.equal(f.records.length, 1);
});
test("a block during replay context reads prevents returning the pending offer", async (t) => {
  const f = fixture(t); await f.prepare();
  t.mock.method(PetModel, "find", () => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, session() { return this; },
    async lean() { f.account.blocked = true; return []; } }));
  await assert.rejects(f.prepare(), { code: "ai_restricted" }); assert.equal(f.records.length, 1);
});
test("proposal store requires complete unique owner/key index and no TTL, without initializing stores", async (t) => {
  const f = fixture(t);
  for (const indexes of [[], [{ key: { owner: 1, key: 1 }, unique: true, sparse: true }],
    [{ key: { owner: 1, key: 1 }, unique: true, partialFilterExpression: { owner: { $exists: true } } }],
    [{ key: { owner: 1, key: 1 }, unique: true, collation: { locale: "en" } }],
    [{ key: { owner: 1, key: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]]) {
    f.indexes = indexes; await assert.rejects(f.prepare(), { code: "booking_proposal_store_unavailable" });
  }
  assert.equal(f.records.length, 0); assert.equal(f.account.bookingReadRateCount, undefined);
});
test("outside-city, fully booked, conflicting and invalid bookings cannot become proposals", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.prepare({ ...f.body, location: { governorateCode: "cairo", areaCode: "maadi" } }), { code: "booking_region_unavailable" });
  f.booked = 2; await assert.rejects(f.prepare(), { code: "booking_preview_not_ready" });
  f.booked = 0; f.conflict = { _id: oid() }; await assert.rejects(f.prepare(), { code: "booking_preview_not_ready" });
  f.conflict = null;
  for (const booking of [{ ...f.body.booking, serviceType: "BOARDING" }, { ...f.body.booking, age: NaN }, { ...f.body.booking, petId: [String(oid())] }])
    await assert.rejects(f.prepare({ ...f.body, booking }));
  assert.equal(f.records.length, 0);
});
test("expiry must be explicit and future; expired replay never silently creates another proposal", async (t) => {
  const f = fixture(t);
  for (const options of [{}, { expiresAt: new Date(0) }, { expiresAt: new Date("invalid") }, { expiresAt: new Date().toISOString() }])
    await assert.rejects(f.prepare(f.body, "booking-expiry-key", options), { code: "booking_proposal_expiry_required" });
  const { proposal } = await f.prepare(); t.mock.timers.enable({ apis: ["Date"], now: new Date(proposal.expiresAt).getTime() + 1 });
  assert.equal((await f.get(proposal.id)).proposal.status, "expired");
  assert.equal((await f.prepare()).proposal.status, "expired");
  await assert.rejects(f.check(proposal), { code: "booking_proposal_expired" }); assert.equal(f.records.length, 1);
});
test("owner authorization, feature flag and corruption protect pending reads and freshness checks", async (t) => {
  const f = fixture(t), { proposal } = await f.prepare();
  await assert.rejects(getBookingProposal(oid(), proposal.id, f.config), { code: "authentication_required" });
  f.records[0].owner = oid(); await assert.rejects(f.get(proposal.id), { code: "booking_proposal_not_found" }); f.records[0].owner = f.owner;
  f.account.blocked = true; await assert.rejects(f.get(proposal.id), { code: "ai_restricted" }); f.account.blocked = false;
  f.config.bookingReadsEnabled = false; await assert.rejects(f.get(proposal.id), { code: "booking_reads_unavailable" }); f.config.bookingReadsEnabled = true;
  await assert.rejects(f.check(proposal, { fingerprint: "a".repeat(64) }), { code: "booking_proposal_changed" });
  await assert.rejects(f.check(proposal, { owner: String(f.owner) }), { code: "invalid_request" });
  f.records[0].quoteJson = f.records[0].quoteJson.replace('"price":75', '"price":10');
  await assert.rejects(f.get(proposal.id), { code: "booking_proposal_unavailable" });
});
test("pet/profile/chat, contact and configuration changes require a new reviewed proposal", async (t) => {
  const f = fixture(t); f.pets.push({ _id: oid(), petOwner: f.owner, name: "Milo", type: "cat", gender: "male", birthDate: new Date("2023-01-01") });
  f.chat.activeSubject = `pet:${f.pets[0]._id}`; f.body.booking.petId = String(f.pets[0]._id);
  const { proposal } = await f.prepare();
  for (const change of [() => { f.chat.contextVersion++; }, () => { f.chat.activeSubject = null; }, () => { f.pets[0].name = "Changed"; },
    () => { f.pets[0].temp_health_issues = ["Changed"]; }, () => { f.user.phone = "Changed"; }, () => { f.config = { ...f.config, signature: "changed" }; }]) {
    const previous = { contextVersion: f.chat.contextVersion, activeSubject: f.chat.activeSubject, name: f.pets[0].name,
      issues: f.pets[0].temp_health_issues, phone: f.user.phone, config: f.config };
    change(); await assert.rejects(f.check(proposal), { code: "context_changed" });
    await assert.rejects(f.prepare(), { code: "context_changed" });
    f.chat.contextVersion = previous.contextVersion; f.chat.activeSubject = previous.activeSubject; f.pets[0].name = previous.name;
    f.pets[0].temp_health_issues = previous.issues; f.user.phone = previous.phone; f.config = previous.config;
    assert.equal((await f.check(proposal)).ready, true);
  }
});
test("proposal lifetime does not change the ordinary current-hour booking rule", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: DateTime.fromISO("2026-10-24T14:20", { zone: "Africa/Cairo" }).toMillis() });
  const f = fixture(t); f.body.booking.date = "2026-10-24"; f.body.booking.hour24 = 14;
  const { proposal } = await f.prepare(); assert.equal(proposal.status, "pending");
  assert.equal((await f.check(proposal)).ready, true);
});
test("freshness re-resolves current area and prices; spare capacity changes do not replace selection", async (t) => {
  const f = fixture(t), { proposal } = await f.prepare();
  await assert.rejects(f.check(proposal, { location: { governorateCode: "cairo", areaCode: "maadi" } }), { code: "booking_region_unavailable" });
  f.definition.options[0].price = 80; await assert.rejects(f.check(proposal), { code: "booking_proposal_changed" });
  f.definition.options[0].price = 75; f.booked = 1; assert.equal((await f.check(proposal)).ready, true);
  f.booked = 2; await assert.rejects(f.check(proposal), { code: "booking_preview_not_ready" });
});
test("context changed during preview prevents persistence; transaction retry recovers one saved proposal", async (t) => {
  const f = fixture(t); f.onCatalog = () => { f.chat.contextVersion++; };
  await assert.rejects(f.prepare(), { code: "context_changed" }); assert.equal(f.records.length, 0);
  f.onCatalog = null; f.race = true;
  const result = await f.prepare(); assert.equal(result.duplicate, true); assert.equal(f.records.length, 1);
});
test("failed proposal insert leaves no proposal or booking; lost successful response replays original", async (t) => {
  const f = fixture(t); f.failInsert = true; await assert.rejects(f.prepare(), /simulated proposal insert failure/); assert.equal(f.records.length, 0);
  f.failInsert = false;
  // Admission is a separate committed transaction; lose the response only after proposal insertion.
  f.beforeCommit = () => { if (f.records.length) f.loseResponse = true; };
  await assert.rejects(f.prepare(), /simulated unknown commit response/); f.beforeCommit = null;
  const result = await f.prepare(); assert.equal(result.duplicate, true); assert.equal(f.records.length, 1); assert.equal(f.cartWrites, 0);
});
