import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { Settings } from "luxon";
import { previewUserReservationService } from "../../../src/domains/serviceReservation/reservations/serviceReservation.preview.js";
import { ServiceLocationModel } from "../../../src/domains/serviceReservation/locations/serviceLocation.model.js";
import { ServiceCatalogModel } from "../../../src/domains/serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceSlotInventoryModel } from "../../../src/domains/serviceReservation/inventory/serviceSlotInventory.model.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { cairoSlotToUtcDate } from "../../../src/domains/serviceReservation/reservations/serviceReservation.utils.js";

const U = "111111111111111111111111", L = "222222222222222222222222", P = "333333333333333333333333";
const oid = (id) => new mongoose.Types.ObjectId(id);
function fixture(t) {
  const oldNow = Settings.now; Settings.now = () => Date.parse("2026-10-21T10:30:00.000Z"); t.after(() => { Settings.now = oldNow; });
  const state = { reads: [], queries: [], inventories: [], conflict: null, petFound: true, user: { name: "Private owner name", phone: "Private phone" },
    location: { _id: oid(L), name_en: "Test branch", name_ar: "الفرع", city: "Alexandria", slug: "test", active: true, timezone: "Africa/Cairo",
      capacityByRoomType: { groomingRoom: 2, clinicRoom: 1 } },
    definitions: Object.fromEntries(["GROOMING", "SHOWERING", "CLINIC"].map((type) => [type, { type, name_en: type, name_ar: "خدمة", isActive: true,
      options: [{ key: "standard", name_en: "Standard", name_ar: "عادي", price: type === "CLINIC" ? 250 : 100 }] }])) };
  const query = (value) => ({ select() { return this; }, maxTimeMS() { return this; }, lean() { return Promise.resolve(value); } });
  t.mock.method(ServiceLocationModel, "findById", (id) => { state.reads.push("location"); assert.equal(String(id), L); return query(state.location); });
  t.mock.method(ServiceCatalogModel, "findOne", ({ type }) => { state.reads.push("catalog"); return query(state.definitions[type]); });
  t.mock.method(ServiceSlotInventoryModel, "find", (filter) => {
    state.reads.push("inventory"); assert.equal(String(filter.location), L); assert.ok(filter.startsAt.$in.length <= 12);
    return query(state.inventories.filter((row) => row.roomType === filter.roomType && filter.startsAt.$in.some((date) => +date === +row.startsAt)));
  });
  t.mock.method(UserModel, "findById", (id) => { state.reads.push("owner"); assert.equal(String(id), U); return query(state.user); });
  t.mock.method(PetModel, "findOne", (filter) => {
    state.reads.push("pet"); assert.equal(String(filter.petOwner), U); assert.equal(String(filter._id), P);
    return query(state.petFound ? { _id: oid(P), name: "Milo", type: "cat", gender: "male", birthDate: "2020-01-01" } : null);
  });
  t.mock.method(ServiceReservationModel, "findOne", (filter) => {
    state.reads.push("reservation"); state.queries.push(filter); assert.equal(String(filter.user), U); assert.equal(filter.status, "BOOKED");
    assert.ok(filter.startsAt.$in.length <= 12); assert.equal(filter.guestId, undefined); return query(state.conflict);
  });
  const refuse = () => assert.fail("Preview must not write or start transactions");
  t.mock.method(mongoose, "startSession", refuse);
  for (const Model of [ServiceReservationModel, ServiceSlotInventoryModel, ServiceLocationModel, ServiceCatalogModel, UserModel, PetModel]) {
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "createIndexes", "syncIndexes"]) t.mock.method(Model, method, refuse);
  }
  t.mock.method(console, "log", () => {});
  state.payload = { locationId: L, serviceType: "GROOMING", serviceOptionKey: "standard", date: "2026-10-24", hour24: 10, petId: P, age: 3 };
  state.resolvedLocation = { location: { source: "gps", governorate: { normalized: "alexandria" } },
    delivery: { coverageStatus: "INSIDE_BOUNDARY" }, zoneWarehouse: { governorate: "alexandria" } };
  state.preview = (changes = {}, lang = "en") => previewUserReservationService({ userId: U, resolvedLocation: state.resolvedLocation, payload: { ...state.payload, ...changes }, lang });
  return state;
}
test("owned booking preview returns a read-only estimate without owner contact or reservation identity", async (t) => {
  const f = fixture(t), result = await f.preview();
  assert.equal(result.status, "ready"); assert.equal(result.totalPrice, 100); assert.equal(result.currency, "EGP");
  assert.equal(result.timezone, "Africa/Cairo"); assert.equal(result.estimateOnly, true); assert.equal(result.slotReserved, false);
  assert.equal(result.requiresRefreshBeforeConfirmation, true); assert.equal(result.pet.id, P); assert.equal(result.pet.name, "Milo");
  assert.equal(result.services[0].remaining, 2); assert.equal(result.services[0].startsAt, cairoSlotToUtcDate({ dateISO: "2026-10-24", hour24: 10 }).utcDate.toISOString());
  assert.equal(JSON.stringify(result).includes("Private"), false); assert.equal(result.reservationId, undefined);
  assert.equal(f.queries.length, 1);
});
test("multiple selected services occupy successive hourly slots and share grooming room capacity", async (t) => {
  const f = fixture(t); delete f.payload.serviceType; delete f.payload.serviceOptionKey;
  const result = await f.preview({ services: [{ serviceType: "GROOMING", serviceOptionKey: "standard" }, { serviceType: "SHOWERING", serviceOptionKey: "standard" }] });
  assert.equal(result.services.length, 2); assert.equal(result.totalPrice, 200);
  assert.deepEqual(result.services.map((s) => s.hour24), [10, 11]);
  assert.deepEqual(result.services.map((s) => s.roomType), ["GROOMING_ROOM", "GROOMING_ROOM"]);
  assert.equal(result.services[0].endsAt, result.services[1].startsAt); assert.equal(f.queries[0].startsAt.$in.length, 2);
});
test("clinic uses clinic capacity and Arabic service/option labels", async (t) => {
  const f = fixture(t), result = await f.preview({ serviceType: "CLINIC" }, "ar");
  assert.equal(result.totalPrice, 250); assert.equal(result.services[0].roomType, "CLINIC_ROOM");
  assert.equal(result.services[0].remaining, 1); assert.equal(result.services[0].serviceName, "خدمة"); assert.equal(result.services[0].serviceOptionName, "عادي");
});
test("full selected slots return unavailable rather than claiming capacity or holding a place", async (t) => {
  const f = fixture(t); f.inventories = [{ startsAt: cairoSlotToUtcDate({ dateISO: f.payload.date, hour24: 10 }).utcDate, roomType: "GROOMING_ROOM", bookedCount: 2 }];
  const result = await f.preview(); assert.equal(result.status, "slot_unavailable"); assert.equal(result.services[0].remaining, 0);
  assert.equal(result.services[0].available, false); assert.equal(result.slotReserved, false);
});
test("owner conflict is scoped to booked reservations at any selected hour and exposes no other record", async (t) => {
  const f = fixture(t); f.conflict = { _id: oid("444444444444444444444444") };
  const result = await f.preview(); assert.equal(result.status, "existing_reservation");
  assert.equal(JSON.stringify(result).includes("444444444444444444444444"), false);
});
test("existing Cairo booking window and current-hour rule are reused", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.preview({ date: "2026-10-20" }), { statusCode: 400 });
  await assert.rejects(f.preview({ date: "2026-11-06" }), { statusCode: 400 });
  await assert.rejects(f.preview({ date: "2026-10-21", hour24: 12 }), { statusCode: 400 });
  assert.equal((await f.preview({ date: "2026-10-21", hour24: 13 })).status, "ready");
  assert.equal((await f.preview({ date: "2026-11-05", hour24: 14 })).status, "ready");
});
test("Thursday/Friday opening hours and multi-service closing boundary are enforced before reads", async (t) => {
  const f = fixture(t); await assert.rejects(f.preview({ date: "2026-10-22", hour24: 10 }), { statusCode: 400 });
  assert.equal(f.reads.length, 0); assert.equal((await f.preview({ date: "2026-10-22", hour24: 14 })).status, "ready");
  delete f.payload.serviceType; delete f.payload.serviceOptionKey;
  await assert.rejects(f.preview({ hour24: 21, services: [{ serviceType: "CLINIC" }, { serviceType: "CLINIC" }] }), { statusCode: 400 });
});
test("inactive service or branch and invalid option cannot be advertised as bookable", async (t) => {
  const f = fixture(t); f.definitions.GROOMING.isActive = false; await assert.rejects(f.preview(), { statusCode: 409 });
  f.definitions.GROOMING.isActive = true; f.location.active = false; await assert.rejects(f.preview(), { statusCode: 404 });
  f.location.active = true; await assert.rejects(f.preview({ serviceOptionKey: "missing" }), { statusCode: 400 });
});
test("invalid prices, invalid room counts and no capacity fail closed", async (t) => {
  const f = fixture(t);
  for (const price of [-1, NaN, Infinity]) { f.definitions.GROOMING.options[0].price = price; await assert.rejects(f.preview(), { statusCode: 409 }); }
  f.definitions.GROOMING.options[0].price = 100;
  for (const capacity of [0, -1, 1.5, Infinity]) { f.location.capacityByRoomType.groomingRoom = capacity; await assert.rejects(f.preview(), { statusCode: 409 }); }
});
test("saved pet lookup is owned and existing mandatory booking details remain required", async (t) => {
  const f = fixture(t); f.petFound = false; await assert.rejects(f.preview(), { statusCode: 404 });
  f.petFound = true; f.user = { name: "Owner" }; await assert.rejects(f.preview(), { statusCode: 400 });
});
test("internal preview rejects guest identity, unexpected fields, malformed date/type/quantity and unbounded requests", async (t) => {
  const f = fixture(t);
  for (const payload of [{ ...f.payload, guestId: "guest" }, { ...f.payload, date: "2026-10-24T00:00:00Z" }, { ...f.payload, date: "2026-02-30" },
    { ...f.payload, hour24: "10" }, { ...f.payload, serviceType: "UNKNOWN" }, { ...f.payload, age: -1 },
    { ...f.payload, services: [] }, { ...f.payload, ownerName: {} }, { ...f.payload, ownerPhone: "x".repeat(2049) },
    { ...f.payload, locationId: [L] }, { ...f.payload, petId: [P] }]) {
    await assert.rejects(previewUserReservationService({ userId: U, resolvedLocation: f.resolvedLocation, payload }), { statusCode: 400 });
  }
  await assert.rejects(previewUserReservationService({ payload: f.payload }), { statusCode: 400 });
  await assert.rejects(f.preview({}, "fr"), { statusCode: 400 });
  delete f.payload.serviceType; delete f.payload.serviceOptionKey;
  await assert.rejects(f.preview({ services: Array.from({ length: 13 }, () => ({ serviceType: "CLINIC" })) }), { statusCode: 400 });
});

test("non-Alexandria or unresolved users cannot preview any booking, including warehouse-rerouted users", async (t) => {
  const f = fixture(t);
  f.resolvedLocation = { warehouse: { governorate: "alexandria" }, zoneWarehouse: { governorate: "alexandria" },
    location: { source: "gps", governorate: { normalized: "cairo" } } };
  await assert.rejects(f.preview(), { statusCode: 403 }); assert.equal(f.reads.length, 0);
  f.resolvedLocation = { warehouse: { governorate: "alexandria" } };
  await assert.rejects(f.preview(), { statusCode: 409 }); assert.equal(f.reads.length, 0);
  f.resolvedLocation = { location: { source: "manual", governorate: { name: "alexandria" } } };
  assert.equal((await f.preview()).status, "ready");
});

test("eligible Alexandria users cannot preview an inactive or non-Alexandria service branch", async (t) => {
  const f = fixture(t); f.location.city = "Cairo"; await assert.rejects(f.preview(), { statusCode: 409 });
  f.location.city = undefined; await assert.rejects(f.preview(), { statusCode: 409 });
  f.location.city = "Alexandria"; assert.equal((await f.preview()).status, "ready");
});
test("boarding is outside the owner's confirmed service offering", async (t) => {
  const f = fixture(t); await assert.rejects(f.preview({ serviceType: "BOARDING" }), { statusCode: 400 }); assert.equal(f.reads.length, 0);
});
