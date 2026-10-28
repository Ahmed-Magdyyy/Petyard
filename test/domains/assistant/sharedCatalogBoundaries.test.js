import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantBudget, AssistantChat, AssistantDietaryWarning, AssistantEvent, AssistantMemory, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { mockSharedCatalogBoundaries } from "./fixtures/sharedCatalogBoundaries.js";
import { customerRunFilter } from "../../../src/domains/assistant/shared/assistant.purpose.js";

function fixture(t) {
  class SyntheticClient {}
  const manifest = createSharedMongoManifest("catalogPublication"), writes = [], reads = [], client = new SyntheticClient(), session = { client };
  const subjectId = "chat:12345678-1234-1234-1234-123456789012";
  for (const Model of [UserModel, AssistantAccount, AssistantChat, AssistantRun, AssistantMessage, AssistantDietaryWarning]) {
    for (const method of ["insertOne", "updateOne", "findOneAndUpdate", "find", "findOne"]) {
      t.mock.method(Model.collection, method, function (...args) {
        (method.startsWith("find") && method !== "findOneAndUpdate" ? reads : writes).push({ name: Model.collection.name, method, args });
        return Promise.resolve({ acknowledged: true, modifiedCount: 1 });
      });
    }
  }
  const target = { valid: true };
  mockSharedCatalogBoundaries(t, manifest, { subjectId, client, checkTarget() { assert.ok(target.valid, "target changed"); } });
  return { manifest, writes, reads, client, session, subjectId, target, owner: manifest.records.users[0] };
}

test("catalog boundary forces registered reply/warning IDs and marker while keeping actual model validation", async (t) => {
  const state = fixture(t), { manifest, owner, session, subjectId } = state;
  const message = { owner, chat: manifest.records.assistantchats[0], run: manifest.records.assistantruns[0], sequence: 2, role: "assistant",
    text: "Synthetic reply", expiresAt: new Date(Date.now() + 60000) };
  await AssistantMessage.create([message], { session });
  await AssistantDietaryWarning.create([{ owner, subjectId, sourceMessage: manifest.records.assistantmessages[0], source: "chat", text: "Synthetic caution" }], { session });
  assert.equal(state.writes.length, 2);
  assert.equal(String(state.writes[0].args[0]._id), manifest.records.assistantmessages[1]);
  assert.equal(String(state.writes[1].args[0]._id), manifest.records.assistantdietarywarnings[0]);
  assert.ok(state.writes.every((write) => write.args[0].assistantTestRun === manifest.marker));
  await assert.rejects(AssistantMessage.create([{ ...message, owner: new mongoose.Types.ObjectId() }], { session }));
  await assert.rejects(AssistantMessage.create([{ ...message, text: "" }], { session }));
  await assert.rejects(AssistantMessage.create([{ ...message, role: "user" }], { session }));
  await assert.rejects(AssistantDietaryWarning.create([{ owner, subjectId, sourceMessage: new mongoose.Types.ObjectId(), source: "chat", text: "Synthetic" }], { session }));
  assert.equal(state.writes.length, 2);
});

test("catalog boundary closes native writes by target, session, manifest IDs and immutable scope", async (t) => {
  const state = fixture(t), { manifest, owner, session } = state;
  await AssistantRun.collection.updateOne({ _id: new mongoose.Types.ObjectId(manifest.records.assistantruns[0]) }, { $set: { status: "completed" } }, { session });
  const update = state.writes[0]; assert.equal(update.args[0].assistantTestRun, manifest.marker);
  await AssistantAccount.collection.findOneAndUpdate({ owner }, { $setOnInsert: { owner } }, { session, upsert: true });
  const insert = state.writes[1].args[1].$setOnInsert;
  assert.equal(String(insert._id), manifest.records.assistantaccounts[0]); assert.equal(insert.assistantTestRun, manifest.marker);
  for (const call of [
    () => AssistantRun.collection.updateOne({}, { $set: { status: "completed" } }, { session }),
    () => AssistantRun.collection.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { status: "completed" } }, { session }),
    () => AssistantRun.collection.updateOne({ _id: manifest.records.assistantruns[0] }, { $set: { status: "completed" } }, { session: { client: {} } }),
    () => AssistantChat.collection.updateOne({ owner }, { $set: { owner: manifest.records.users[1] } }, { session }),
    () => AssistantChat.collection.updateOne({ owner }, { $unset: { assistantTestRun: 1 } }, { session }),
    () => AssistantChat.collection.updateOne({ owner }, { $set: { "owner.changed": manifest.records.users[1] } }, { session }),
    () => AssistantChat.collection.updateOne({ owner }, { $rename: { unrelated: "assistantTestRun" } }, { session }),
    () => UserModel.collection.updateOne({ _id: owner }, { $set: { role: "admin" } }, { session }),
    () => AssistantMessage.collection.insertOne({ _id: new mongoose.Types.ObjectId(), owner }, { session }),
    () => AssistantRun.collection.deleteMany({ _id: manifest.records.assistantruns[0] }, { session }),
  ]) assert.throws(call);
  assert.equal(state.writes.length, 2);
  state.target.valid = false;
  assert.throws(() => AssistantRun.collection.findOne({ _id: manifest.records.assistantruns[0] }), /target changed/);
});

test("catalog boundary scopes native reads and forbids saved-pet, memory, real-budget and outbox storage", async (t) => {
  const state = fixture(t), { manifest, owner, subjectId, session } = state;
  await AssistantDietaryWarning.collection.find({ owner, subjectId, state: "active" });
  assert.equal(state.reads[0].args[0].assistantTestRun, manifest.marker);
  for (const call of [() => AssistantMessage.collection.find({}), () => AssistantRun.collection.findOne({ _id: new mongoose.Types.ObjectId() }),
    () => AssistantDietaryWarning.collection.find({ owner, subjectId: "chat:foreign" }), () => PetModel.collection.find({}),
    () => AssistantMemory.collection.find({}), () => AssistantBudget.collection.findOne({ _id: "control" }),
    () => NotificationOutboxModel.collection.insertOne({})]) assert.throws(call);
  assert.deepEqual(await PetModel.find({ petOwner: owner }).select("name").sort({ _id: 1 }).limit(10).session(session).lean(), []);
  assert.throws(() => PetModel.find({ petOwner: new mongoose.Types.ObjectId() }));
  await AssistantMemory.updateMany({ owner, kind: "discussion_summary", state: "active" }, { $set: { state: "forgotten" } }, { session });
  await assert.rejects(AssistantMemory.updateMany({ owner: manifest.records.users[1], kind: "discussion_summary", state: "active" }, {}, { session }));
});

test("catalog boundary accepts the exact customer purpose wrapper only with a registered conjunct", async (t) => {
  const { manifest, reads, owner } = fixture(t);
  const filter = customerRunFilter({ _id: new mongoose.Types.ObjectId(manifest.records.assistantruns[0]), status: "dispatching" });
  await AssistantRun.collection.findOne(filter);
  assert.deepEqual(reads[0].args[0], { ...filter, assistantTestRun: manifest.marker });
  for (const unsafe of [customerRunFilter({}), customerRunFilter({ _id: new mongoose.Types.ObjectId() }),
    customerRunFilter({ owner: new mongoose.Types.ObjectId() }), { $and: [{ owner }] },
    { $and: [{ owner }, { purpose: "business" }] }, { ...filter, owner: new mongoose.Types.ObjectId() }]) {
    assert.throws(() => AssistantRun.collection.findOne(unsafe));
  }
  assert.throws(() => AssistantChat.collection.findOne(customerRunFilter({ owner })));
  assert.equal(reads.length, 1);
});

test("catalog warning audit stub accepts only its exact registered warning, owner, subject and session", async (t) => {
  const { manifest, owner, subjectId, session } = fixture(t);
  const event = { owner, actor: owner, run: null, type: "dietary_warning_recorded",
    detail: { warningId: manifest.records.assistantdietarywarnings[0], subjectId, version: 1 } };
  assert.equal((await AssistantEvent.create([event], { session })).length, 1);
  for (const invalid of [{ ...event, owner: manifest.records.users[1] }, { ...event, actor: manifest.records.users[1] },
    { ...event, detail: { ...event.detail, warningId: String(new mongoose.Types.ObjectId()) } },
    { ...event, detail: { ...event.detail, subjectId: "chat:foreign" } }, { ...event, type: "run_completed" }]) {
    await assert.rejects(AssistantEvent.create([invalid], { session }));
  }
  await assert.rejects(AssistantEvent.create([event], { session: { client: {} } }));
});
