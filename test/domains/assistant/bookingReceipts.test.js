import assert from "node:assert/strict";
import test from "node:test";
import { DateTime } from "luxon";
import { bookingReceiptFixture as fixture, oid } from "./fixtures/bookingReceipts.js";
import { stageBookingWithReceipt } from "../../../src/domains/assistant/customer/assistant.booking-receipts.js";
import { resolvePetSnapshot } from "../../../src/domains/serviceReservation/reservations/serviceReservation.service.js";
import { resolveServiceSelectionOrThrow, resolveServiceSelectionFromDefinition } from "../../../src/domains/serviceReservation/catalog/serviceCatalog.service.js";
test("stage commits reservations, capacity and one recoverable receipt with private details omitted", async t => {
  const f = fixture(t), op = await f.operation(), result = await f.stage(op);
  assert.equal(result.duplicate, false); assert.equal(result.receipt.result.status, "confirmed"); assert.equal(result.receipt.result.totalPrice, 75);
  assert.equal(f.inventory[0].bookedCount, 1); assert.equal(f.reservations.length, 1); assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].notificationPending, true); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(f.reservations[0].ownerName, "PRIVATE owner"); assert.equal(f.reservations[0].petName, "Milo");
  assert.deepEqual(new Set(f.fences), new Set(["User", "Pet", "ServiceLocation", "ServiceCatalog"]));
  assert.equal(f.commits, 1);
});
test("ordered multi-service booking shares grooming capacity rules with exact hourly prices", async t => {
  const f = fixture(t); delete f.payload.serviceType; delete f.payload.serviceOptionKey;
  f.payload.services = ["GROOMING", "SHOWERING", "CLINIC"].map(serviceType => ({ serviceType, serviceOptionKey: "option" }));
  const result = await f.stage(await f.operation());
  assert.equal(f.reservations.length, 3); assert.equal(f.inventory.length, 3); assert.equal(result.receipt.result.totalPrice, 275);
  assert.deepEqual(result.receipt.result.services.map(row => row.roomType), ["GROOMING_ROOM", "GROOMING_ROOM", "CLINIC_ROOM"]);
  assert.deepEqual(result.receipt.result.services.map(row => row.hour24), [14, 15, 16]);
});
test("Arabic confirmation retains the reviewed Arabic labels and owned pet snapshot", async t => {
  const f = fixture(t); f.definitions[0].name_ar = "كشف";
  const result = await f.stage(await f.operation("ar"));
  assert.equal(result.receipt.result.services[0].serviceName, "كشف");
  assert.equal(result.receipt.result.services[0].serviceOptionName, "اختيار"); assert.equal(result.receipt.result.pet.name, "Milo");
});
test("exact receipt replay/recovery never changes capacity even after location, price and time change", async t => {
  const f = fixture(t), op = await f.operation(), first = await f.stage(op), writes = f.inventoryWrites;
  op.resolvedLocation = { location: { source: "manual", governorate: { name: "cairo" } } }; f.definitions[0].options[0].price = 100;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(op.expectedQuote.services[0].startsAt) + 86400000 });
  assert.deepEqual((await f.stage(op)).receipt, first.receipt); assert.deepEqual((await f.recover(op)).receipt, first.receipt);
  assert.equal(f.inventoryWrites, writes); assert.equal(f.reservations.length, 1);
  await assert.rejects(f.stage({ ...op, owner: String(oid()) }), { code: "idempotency_conflict" });
  await assert.rejects(f.stage({ ...op, proposalFingerprint: "b".repeat(64) }), { code: "idempotency_conflict" });
});
test("a receipt insert failure rolls back every appointment, capacity and context fence", async t => {
  const f = fixture(t), op = await f.operation(); f.failReceipt = true;
  await assert.rejects(f.stage(op), /simulated receipt failure/);
  assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0); assert.equal(f.receipts.length, 0);
  assert.equal(f.user.__v, 0); assert.equal(f.pet.__v, 0); assert.equal(f.branch.__v, 0); assert.equal(f.definitions[0].__v, 0); assert.equal(f.aborts, 1);
});
test("inventory and reservation failures leave no partial multi-service booking", async t => {
  const f = fixture(t); delete f.payload.serviceType; delete f.payload.serviceOptionKey;
  f.payload.services = ["CLINIC", "GROOMING"].map(serviceType => ({ serviceType, serviceOptionKey: "option" }));
  const op = await f.operation(); f.failReservations = true; await assert.rejects(f.stage(op), /simulated reservation failure/);
  assert.equal(f.inventory.length, 0); assert.equal(f.reservations.length, 0); assert.equal(f.receipts.length, 0);
  f.failReservations = false; f.failInventory = true; await assert.rejects(f.stage(op), /simulated inventory failure/);
  assert.equal(f.inventory.length, 0); assert.equal(f.reservations.length, 0);
});
test("lost committed response recovers the original reservation IDs without another booking", async t => {
  const f = fixture(t), op = await f.operation(); f.loseResponse = true; await assert.rejects(f.stage(op), /simulated unknown commit response/);
  assert.equal(f.reservations.length, 1); assert.equal(f.receipts.length, 1);
  const writes = f.inventoryWrites, recovered = await f.stage(op); assert.equal(recovered.duplicate, true);
  assert.equal(recovered.receipt.result.services[0].reservationId, String(f.reservations[0]._id)); assert.equal(f.inventoryWrites, writes);
});
test("crossing the allowed current hour during staging rolls back the booking", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: DateTime.fromISO("2026-10-24T14:59:30", { zone: "Africa/Cairo" }).toMillis() });
  const f = fixture(t); f.payload.date = "2026-10-24"; f.payload.hour24 = 14;
  const op = await f.operation(); f.afterReservationInsert = () => t.mock.timers.tick(60000);
  await assert.rejects(f.stage(op), { statusCode: 400 });
  assert.equal(f.inventory.length, 0); assert.equal(f.reservations.length, 0); assert.equal(f.receipts.length, 0);
});
test("inventory uniqueness conflict aborts then retries the whole transaction against the independent winner", async t => {
  const f = fixture(t), op = await f.operation(); f.raceSlot = true; const result = await f.stage(op);
  assert.equal(result.duplicate, false); assert.equal(f.attempts, 2); assert.equal(f.aborts, 1);
  assert.equal(f.inventory.length, 1); assert.equal(f.inventory[0].bookedCount, 2); assert.equal(f.reservations.length, 1); assert.equal(f.receipts.length, 1);
});
test("freshness refuses changed price, branch, permission, owned pet and unknown geography", async t => {
  const f = fixture(t), op = await f.operation();
  f.definitions[0].options[0].price = 80; await assert.rejects(f.stage(op), { code: "booking_proposal_changed" }); f.definitions[0].options[0].price = 75;
  f.definitions[0].isActive = false; await assert.rejects(f.stage(op), { code: "booking_proposal_changed" }); f.definitions[0].isActive = true;
  f.branch.active = false; await assert.rejects(f.stage(op), { code: "booking_proposal_changed" }); f.branch.active = true;
  f.branch.city = "Cairo"; await assert.rejects(f.stage(op), { code: "booking_proposal_changed" }); f.branch.city = "Alexandria";
  f.user.active = false; await assert.rejects(f.stage(op), { code: "access_denied" }); f.user.active = true;
  f.pet.petOwner = oid(); await assert.rejects(f.stage(op), { code: "booking_proposal_changed" }); f.pet.petOwner = f.owner;
  await assert.rejects(f.stage({ ...op, resolvedLocation: null }), { statusCode: 409 });
  await assert.rejects(f.stage({ ...op, resolvedLocation: { location: { source: "manual", governorate: { name: "cairo" } } } }), { statusCode: 403 });
  assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0);
});
test("capacity corruption/full slots and actor conflicts fail before any new write", async t => {
  const f = fixture(t), op = await f.operation();
  f.inventory.push({ _id: oid(), location: f.branch._id, roomType: "CLINIC_ROOM", startsAt: new Date(op.expectedQuote.services[0].startsAt), capacity: 2, bookedCount: 2 });
  await assert.rejects(f.stage(op), { code: "booking_slot_unavailable" });
  f.inventory[0].bookedCount = -1; await assert.rejects(f.stage(op), { code: "booking_slot_unavailable" });
  f.inventory[0].bookedCount = 0;
  f.reservations.push({ _id: oid(), user: f.owner, startsAt: new Date(op.expectedQuote.services[0].startsAt), status: "BOOKED" });
  await assert.rejects(f.stage(op), { code: "booking_existing_reservation" }); assert.equal(f.inventoryWrites, 0);
});
test("missing/corrupt version fences and stale update matches abort without capacity changes", async t => {
  const f = fixture(t), op = await f.operation();
  delete f.branch.__v; await assert.rejects(f.stage(op), { code: "booking_context_unavailable" }); f.branch.__v = 0;
  f.failFence = "ServiceCatalog"; await assert.rejects(f.stage(op), { code: "context_changed" });
  assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0); assert.equal(f.user.__v, 0);
  f.failFence = null; f.failInventory = true;
  f.inventory.push({ _id: oid(), location: f.branch._id, roomType: "CLINIC_ROOM", startsAt: new Date(op.expectedQuote.services[0].startsAt), capacity: 2, bookedCount: 0 });
  await assert.rejects(f.stage(op), { code: "booking_slot_unavailable" });
  assert.equal(f.inventory[0].bookedCount, 0); assert.equal(f.user.__v, 0); assert.equal(f.receipts.length, 0);
});
test("readiness requires non-expiring receipt and actual inventory/actor uniqueness without DDL", async t => {
  const f = fixture(t), op = await f.operation();
  for (const name of ["receiptIndexes", "inventoryIndexes", "reservationIndexes"]) {
    const saved = f[name]; f[name] = []; await assert.rejects(f.stage(op)); f[name] = saved;
    f[name].push({ key: { recordedAt: 1 }, expireAfterSeconds: 0 }); await assert.rejects(f.stage(op)); f[name] = saved.slice(0, -1);
  }
  assert.equal(f.inventoryWrites, 0); assert.equal(f.reservations.length, 0);
});
test("invalid session, forged payload, nonfinite input and damaged receipt are refused", async t => {
  const f = fixture(t), op = await f.operation(); await assert.rejects(stageBookingWithReceipt(op), { code: "booking_transaction_required" });
  await assert.rejects(f.stage({ ...op, booking: { ...op.booking, serviceType: "BOARDING" } }));
  await assert.rejects(f.stage({ ...op, booking: { ...op.booking, age: NaN } }), { code: "invalid_request" });
  await f.stage(op); f.receipts[0].resultJson = f.receipts[0].resultJson.replace('"totalPrice":75', '"totalPrice":10');
  await assert.rejects(f.recover(op), { code: "booking_receipt_unavailable" }); assert.equal(f.reservations.length, 1);
});
test("shared default helpers preserve ordinary selection and snapshot behavior without a session", async t => {
  const f = fixture(t);
  const existing = await resolveServiceSelectionOrThrow({ serviceType: "CLINIC", optionKey: "option" });
  assert.deepEqual(resolveServiceSelectionFromDefinition({ serviceType: "CLINIC", optionKey: "option" }, f.definitions[0]), existing);
  assert.deepEqual(await resolveServiceSelectionOrThrow({ serviceType: "CLINIC" }), existing);
  const snapshot = await resolvePetSnapshot({ userId: String(f.owner), petId: String(f.pet._id), payload: f.payload, lang: "en" });
  assert.equal(snapshot.ownerName, f.user.name); assert.equal(snapshot.petName, f.pet.name); assert.equal(String(snapshot.pet), String(f.pet._id));
  assert.throws(() => resolveServiceSelectionFromDefinition({ serviceType: "GROOMING" }, f.definitions[1]), { statusCode: 400 });
});
