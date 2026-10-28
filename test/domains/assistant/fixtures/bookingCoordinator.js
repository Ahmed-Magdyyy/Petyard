import assert from "node:assert/strict";
import { bookingReceiptFixture, oid, clone, match } from "./bookingReceipts.js";
import { testConfig } from "./foundationPolicy.js";
import { prepareBookingProposal, confirmBookingProposal, getBookingProposalState } from "../../../../src/domains/assistant/customer/assistant.booking-proposals.js";
import { AssistantBookingProposal } from "../../../../src/domains/assistant/shared/assistant.booking-proposal.model.js";
import { AssistantBookingReceipt } from "../../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { AssistantAccount, AssistantChat, AssistantMessage, AssistantEvent } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { WarehouseModel } from "../../../../src/domains/warehouse/warehouse.model.js";

export function bookingCoordinatorFixture(t) {
  const f = bookingReceiptFixture(t);
  f.config = { ...testConfig(), bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true, rateMax: 100 };
  f.account = { _id: oid(), owner: f.owner, blocked: false, restrictionVersion: 0, __v: 0 };
  f.chat = { _id: oid(), owner: f.owner, activeSubject: `pet:${f.pet._id}`, contextVersion: 0, nextSequence: 0, subjects: [], __v: 0 };
  f.messages = []; f.events = [];
  t.mock.method(AssistantChat, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true);
    if (f.failTimeline || !match(f.chat, filter)) return { matchedCount: 0, modifiedCount: 0 };
    f.chat.nextSequence += update.$inc.nextSequence; f.chat.__v += update.$inc.__v;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(AssistantMessage, "findOne", filter => f.query(() => f.messages.find(row => match(row, filter)) ?? null));
  t.mock.method(AssistantMessage, "find", filter => f.query(() => f.messages.filter(row => match(row, filter))));
  t.mock.method(AssistantMessage, "create", async ([record], { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true);
    if (f.failMessageInsert) throw new Error("simulated timeline insertion failure");
    const doc = new AssistantMessage({ ...record, createdAt: new Date(), updatedAt: new Date() });
    assert.equal(doc.validateSync(), undefined); f.messages.push(doc.toObject()); return [doc];
  });
  t.mock.method(AssistantEvent, "create", async ([record], { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true); f.events.push(clone(record)); return [{ _id: oid() }];
  });
  f.proposals = []; f.otherPets = []; f.assertTransactionReads = true; f.resolveCalls = 0;
  for (const [Model, key] of [[AssistantAccount, "account"], [AssistantChat, "chat"]]) {
    t.mock.method(Model, "findOne", filter => f.query(() => match(f[key], filter) ? f[key] : null));
    t.mock.method(Model.collection, "updateOne", async (filter, update, { session }) => {
      assert.equal(session, f.session); assert.equal(session.active, true); f.fences.push(Model.modelName);
      if (f.failFence === Model.modelName || !match(f[key], filter)) return { matchedCount: 0, modifiedCount: 0 };
      assert.deepEqual(update, { $inc: { __v: 1 } }); f[key].__v++; return { matchedCount: 1, modifiedCount: 1 };
    });
  }
  t.mock.method(AssistantAccount, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true); assert.equal(String(filter.owner), String(f.owner));
    Object.assign(f.account, clone(update.$set)); return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(PetModel, "find", filter => f.query(() => [f.pet, ...f.otherPets].filter(pet => pet && match(pet, filter))));
  t.mock.method(PetModel, "findOne", filter => f.query(() => [f.pet, ...f.otherPets].find(pet => pet && match(pet, filter)) ?? null));
  const warehouse = { _id: oid(), governorate: "alexandria", code: "ALEXO03", active: true, fulfillment: { status: "OPERATIONAL" } };
  const resolvedWarehouse = () => f.query(async () => {
    assert.equal(f.session?.active ?? false, false, "resolve current area outside transaction");
    f.resolveCalls++; await f.onWarehouse?.(); return warehouse;
  });
  t.mock.method(WarehouseModel, "findOne", resolvedWarehouse); t.mock.method(WarehouseModel, "findById", resolvedWarehouse);
  t.mock.method(AssistantBookingProposal.collection, "indexes", async () => [{ key: { owner: 1, key: 1 }, unique: true },
    { key: { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 } }]);
  for (const method of ["createCollection", "createIndexes"]) t.mock.method(AssistantBookingProposal, method, () => assert.fail("No proposal store setup"));
  t.mock.method(AssistantBookingProposal, "findOne", filter => f.query(() => f.proposals.find(row => match(row, filter)) ?? null));
  t.mock.method(AssistantBookingProposal, "find", filter => f.query(() => f.proposals.filter(row => match(row, filter))));
  t.mock.method(AssistantBookingReceipt, "find", filter => f.query(() => f.receipts.filter(row => match(row, filter))));
  t.mock.method(AssistantBookingProposal.collection, "updateOne", async (filter, update, { session } = {}) => {
    if (session) { assert.equal(session, f.session); assert.equal(session.active, true); }
    const row = f.proposals.find(row => match(row, filter));
    if (!row || f.failFence === "AssistantBookingProposal") return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, clone(update.$set ?? {})); for (const key of Object.keys(update.$unset ?? {})) delete row[key];
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(AssistantBookingProposal, "create", async ([record], { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true);
    const doc = new AssistantBookingProposal(record); assert.equal(doc.validateSync(), undefined); f.proposals.push(doc.toObject()); return [doc];
  });
  f.location = { governorateCode: "alexandria", areaCode: "smouha" };
  f.prepare = async () => (await prepareBookingProposal(f.owner, { location: f.location, language: "en", booking: f.payload },
    "coordinator-prepare-1", f.config, { expiresAt: new Date(Date.now() + 60000) })).proposal;
  f.confirm = (proposal, changes = {}) => confirmBookingProposal(f.owner, proposal.id,
    { expectedVersion: proposal.version, fingerprint: proposal.fingerprint, location: f.location, ...changes }, f.config);
  f.status = proposal => getBookingProposalState(f.owner, proposal.id, f.config);
  return f;
}
