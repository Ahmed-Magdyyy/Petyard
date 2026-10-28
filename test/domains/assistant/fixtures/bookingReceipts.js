import assert from "node:assert/strict";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import { mockAssistantTransactions } from "./mockAssistantTransactions.js";
import { transaction } from "../../../../src/domains/assistant/shared/assistant.store.js";
import { AssistantBookingReceipt } from "../../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { stageBookingWithReceipt, recoverBookingReceipt } from "../../../../src/domains/assistant/customer/assistant.booking-receipts.js";
import { previewUserReservationService } from "../../../../src/domains/serviceReservation/reservations/serviceReservation.preview.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { ServiceCatalogModel } from "../../../../src/domains/serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceLocationModel } from "../../../../src/domains/serviceReservation/locations/serviceLocation.model.js";
import { ServiceSlotInventoryModel } from "../../../../src/domains/serviceReservation/inventory/serviceSlotInventory.model.js";
import { ServiceReservationModel } from "../../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";

export const oid = () => new mongoose.Types.ObjectId();
export const clone = value => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const match = (row, filter) => Object.entries(filter).every(([key, expected]) => {
  if (key === "$or") return expected.some(part => match(row, part));
  const value = row[key];
  if (expected?.constructor === Object) return Object.entries(expected).every(([op, operand]) => {
    if (op === "$eq") return same(value, operand);
    if (op === "$exists") return Object.hasOwn(row, key) === operand;
    if (op === "$in") return operand.some(item => same(value, item));
    if (op === "$nin") return !operand.some(item => same(value, item));
    if (op === "$lte") return value != null && value <= operand;
    if (op === "$gt") return value != null && value > operand;
    if (op === "$lt") return value != null && value < operand;
    throw new Error("Unsupported fixture operator " + op);
  });
  return Array.isArray(value) ? value.some(item => same(item, expected)) : same(value, expected);
});
export function bookingReceiptFixture(t) {
  mockAssistantTransactions(t);
  const owner = oid(), location = oid(), petId = oid();
  const f = { owner, receipts: [], inventory: [], reservations: [], fences: [], inventoryWrites: 0, reservationWrites: 0,
    commits: 0, aborts: 0, attempts: 0, session: null, confirming: false,
    user: { _id: owner, active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed", __v: 0, name: "PRIVATE owner", phone: "PRIVATE phone" },
    pet: { _id: petId, petOwner: owner, name: "Milo", type: "cat", gender: "male", birthDate: new Date("2023-01-01"), __v: 0 },
    branch: { _id: location, active: true, name_en: "Alex branch", name_ar: "الفرع", city: "Alexandria", slug: "alex", timezone: "Africa/Cairo", __v: 0,
      capacityByRoomType: { clinicRoom: 2, groomingRoom: 2 } },
    definitions: ["CLINIC", "GROOMING", "SHOWERING"].map(type => ({ _id: oid(), type, __v: 0, isActive: true, name_en: type, name_ar: type,
      options: [{ key: "option", name_en: "Option", name_ar: "اختيار", price: type === "CLINIC" ? 75 : 100 }] })),
    receiptIndexes: [{ name: "_id_", key: { _id: 1 } }],
    inventoryIndexes: [{ key: { location: 1, roomType: 1, startsAt: 1 }, unique: true }],
    reservationIndexes: [{ key: { user: 1, startsAt: 1 }, unique: true, partialFilterExpression: { status: "BOOKED" } }],
    resolvedLocation: { location: { source: "manual", governorate: { name: "alexandria" } } } };
  const query = (get) => {
    let session;
    const execute = async () => { if (f.confirming || f.assertTransactionReads && f.session?.active) assert.equal(session, f.session, "all transactional reads share the session"); return clone(await get()); };
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, session(value) { session = value; return this; },
      lean: execute, then(resolve, reject) { return execute().then(resolve, reject); } };
  };
  f.query = query;
  t.mock.method(UserModel, "findById", id => query(() => String(id) === String(owner) ? f.user : null));
  t.mock.method(PetModel, "findOne", filter => query(() => f.pet && match(f.pet, filter) ? f.pet : null));
  t.mock.method(ServiceLocationModel, "findById", id => query(() => String(id) === String(location) ? f.branch : null));
  t.mock.method(ServiceCatalogModel, "findOne", filter => query(() => f.definitions.find(row => match(row, filter)) ?? null));
  t.mock.method(ServiceSlotInventoryModel, "find", filter => query(() => f.inventory.filter(row => match(row, filter))));
  t.mock.method(ServiceSlotInventoryModel, "findOne", filter => query(() => {
    if (f.externalSlot && !f.inventory.some(row => String(row._id) === String(f.externalSlot._id))) f.inventory.push(clone(f.externalSlot));
    return f.inventory.find(row => match(row, filter)) ?? null;
  }));
  t.mock.method(ServiceReservationModel, "findOne", filter => query(() => f.reservations.find(row => match(row, filter)) ?? null));
  t.mock.method(AssistantBookingReceipt, "findOne", filter => query(() => f.receipts.find(row => match(row, filter)) ?? null));
  for (const [Model, name] of [[ServiceSlotInventoryModel, "inventoryIndexes"], [ServiceReservationModel, "reservationIndexes"], [AssistantBookingReceipt, "receiptIndexes"]])
    t.mock.method(Model.collection, "indexes", async () => f[name]);
  for (const method of ["createCollection", "createIndexes"]) t.mock.method(AssistantBookingReceipt, method, () => assert.fail("No receipt schema setup"));
  t.mock.method(mongoose, "startSession", async () => ({ active: false, inTransaction() { return this.active; }, async endSession() {},
    async withTransaction(callback) {
      f.session = this; f.attempts++; const saved = clone({ receipts: f.receipts, inventory: f.inventory, reservations: f.reservations, user: f.user, pet: f.pet, branch: f.branch, definitions: f.definitions,
        ...(f.account ? { account: f.account, chat: f.chat, proposals: f.proposals, otherPets: f.otherPets } : {}),
        ...(f.messages ? { messages: f.messages, events: f.events } : {}), ...(f.outbox ? { outbox: f.outbox } : {}) });
      let committed = false; this.active = true;
      try {
        const result = await callback(); f.commits++; committed = true;
        if (f.loseResponse && (!f.loseAfterBooking || f.receipts.length)) { f.loseResponse = false; throw new Error("simulated unknown commit response"); }
        return result;
      } catch (error) { if (!committed) { Object.assign(f, saved); f.aborts++; } throw error; }
      finally { this.active = false; }
    } }));
  const live = session => { assert.equal(session, f.session); assert.equal(session.active, true); };
  for (const Model of [UserModel, PetModel, ServiceLocationModel, ServiceCatalogModel]) t.mock.method(Model.collection, "updateOne", async (filter, update, { session }) => {
    live(session); f.fences.push(Model.modelName);
    const row = Model === UserModel ? f.user : Model === PetModel ? [f.pet, ...(f.otherPets ?? [])].find(pet => pet && String(pet._id) === String(filter._id)) : Model === ServiceLocationModel ? f.branch : f.definitions.find(row => String(row._id) === String(filter._id));
    if (f.failFence === Model.modelName || !row || !match(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
    assert.deepEqual(update, { $inc: { __v: 1 } }); row.__v++; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(ServiceSlotInventoryModel, "updateOne", async (filter, update, { session }) => {
    live(session); f.inventoryWrites++; const row = f.inventory.find(row => match(row, filter));
    if (!row || f.failInventory) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, update.$set); row.bookedCount += update.$inc.bookedCount; return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(ServiceSlotInventoryModel, "create", async ([row], { session }) => {
    live(session); f.inventoryWrites++;
    if (f.raceSlot) { f.raceSlot = false; f.externalSlot = { _id: oid(), ...row }; throw Object.assign(new Error("simulated inventory uniqueness race"), { code: 11000 }); }
    if (f.failInventory) throw new Error("simulated inventory failure");
    f.inventory.push({ _id: oid(), ...row }); return [f.inventory.at(-1)];
  });
  t.mock.method(ServiceReservationModel, "insertMany", async (docs, { session, ordered }) => {
    live(session); assert.equal(ordered, true); f.reservationWrites++;
    if (f.failReservations) throw new Error("simulated reservation failure");
    const created = docs.map(row => { const doc = new ServiceReservationModel(row); assert.equal(doc.validateSync(), undefined); return doc.toObject(); });
    f.reservations.push(...created); f.afterReservationInsert?.(); return created;
  });
  t.mock.method(AssistantBookingReceipt, "create", async ([row], { session }) => {
    live(session); if (f.failReceipt) throw new Error("simulated receipt failure");
    const doc = new AssistantBookingReceipt(row); assert.equal(doc.validateSync(), undefined); f.receipts.push(doc.toObject()); return [doc];
  });
  f.payload = { locationId: String(location), serviceType: "CLINIC", serviceOptionKey: "option", petId: String(petId),
    date: DateTime.now().setZone("Africa/Cairo").plus({ days: 2 }).toISODate(), hour24: 14, comment: "PRIVATE note" };
  f.operation = async (lang = "en") => ({ owner: String(owner), proposalId: String(oid()), proposalFingerprint: "a".repeat(64), booking: clone(f.payload), language: lang,
    resolvedLocation: clone(f.resolvedLocation), expectedQuote: JSON.parse(JSON.stringify({ eligible: true, reason: null, governorateCode: "alexandria",
      ...await previewUserReservationService({ userId: String(owner), payload: f.payload, resolvedLocation: f.resolvedLocation, lang }) })) });
  f.stage = value => transaction(async session => { f.confirming = true; try { return await stageBookingWithReceipt(value, { session }); } finally { f.confirming = false; } });
  f.recover = value => transaction(async session => { f.confirming = true; try { return await recoverBookingReceipt(value, { session }); } finally { f.confirming = false; } });
  return f;
}
