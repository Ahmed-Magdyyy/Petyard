import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantMessage, AssistantMemory, AssistantBudget, AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { mockSharedCustomerBoundaries } from "./fixtures/sharedCustomerBoundaries.js";

test("customer settlement boundary preserves real validation and forces exact message ID and cleanup marker", async (t) => {
  const manifest = createSharedMongoManifest("persistence"); const writes = [];
  t.mock.method(AssistantMessage.collection, "insertOne", async (document) => {
    writes.push(document); return { acknowledged: true, insertedId: document._id };
  });
  mockSharedCustomerBoundaries(t, manifest);
  const document = { owner: manifest.records.users[0], chat: manifest.records.assistantchats[0], run: manifest.records.assistantruns[0],
    role: "assistant", sequence: 1, text: "Synthetic reply", expiresAt: new Date(Date.now() + 60000) };
  const session = {};
  const [message] = await AssistantMessage.create([document], { session });
  assert.equal(String(message._id), manifest.records.assistantmessages[0]);
  assert.equal(writes[0].assistantTestRun, manifest.marker);
  for (const invalid of [{ ...document, owner: new mongoose.Types.ObjectId() }, { ...document, role: "user" },
    { ...document, chat: new mongoose.Types.ObjectId() }, { ...document, run: new mongoose.Types.ObjectId() }, { ...document, text: "" }]) {
    await assert.rejects(AssistantMessage.create([invalid], { session }));
  }
  await assert.rejects(AssistantMessage.create([document], {})); assert.equal(writes.length, 1);
});

test("customer settlement boundary forbids memory/outbox/real-ledger access and scopes synthetic pet reads", async (t) => {
  const manifest = createSharedMongoManifest("persistence"); const { events } = mockSharedCustomerBoundaries(t, manifest);
  for (const call of [() => AssistantMemory.collection.find({}), () => AssistantMemory.collection.updateMany({}, {}),
    () => AssistantBudget.collection.updateOne({}, {}), () => NotificationOutboxModel.collection.insertOne({})]) assert.throws(call, /forbids/);
  assert.throws(() => PetModel.find({ petOwner: new mongoose.Types.ObjectId() }));
  assert.throws(() => PetModel.find({}));
  const query = PetModel.find({ petOwner: manifest.records.users[0] });
  assert.throws(() => query.session(null));
  assert.deepEqual(await query.select("name").sort({ _id: 1 }).limit(5).session({}).lean(), []);
  await AssistantEvent.create([{ owner: manifest.records.users[0], run: manifest.records.assistantruns[0] }], { session: {} });
  assert.equal(events.length, 1);
});
