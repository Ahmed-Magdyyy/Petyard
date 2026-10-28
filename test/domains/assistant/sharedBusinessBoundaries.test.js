import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAdminMessage, AssistantBudget, AssistantRun, AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { mockSharedBusinessBoundaries, scopeSharedBusinessRecovery } from "./fixtures/sharedBusinessBoundaries.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

test("business test boundary keeps validated writes inside registered IDs and forces ownership markers", async (t) => {
  const manifest = createSharedMongoManifest("persistence"); const writes = [];
  for (const Model of [AssistantRun, AssistantAdminMessage]) t.mock.method(Model.collection, "insertOne", async (document) => {
    writes.push(document); return { acknowledged: true, insertedId: document._id };
  });
  mockSharedBusinessBoundaries(t, manifest);
  const session = {}; const owner = new mongoose.Types.ObjectId(manifest.records.users[0]);
  const chat = new mongoose.Types.ObjectId(manifest.records.assistantadminchats[0]);
  const [run] = await AssistantRun.create([{ owner, chat, key: "synthetic-key", hash: "synthetic-hash", input: "Synthetic input",
    purpose: "admin_business", phase: "plan", status: "queued", contextVersion: 0, userSequence: 1, config: testConfig() }], { session });
  assert.equal(String(run._id), manifest.records.assistantruns[0]);
  await AssistantAdminMessage.create([{ owner, chat, run: run._id, sequence: 1, role: "user", text: "Synthetic input", expiresAt: new Date(Date.now() + 60000) }], { session });
  await AssistantAdminMessage.create([{ owner, chat, run: run._id, sequence: 2, role: "assistant", text: "Synthetic reply", expiresAt: new Date(Date.now() + 60000) }], { session });
  assert.deepEqual(writes.map((document) => String(document._id)), [manifest.records.assistantruns[0], ...manifest.records.assistantadminmessages]);
  assert.ok(writes.every((document) => document.assistantTestRun === manifest.marker));
  await assert.rejects(AssistantAdminMessage.create([{ owner: new mongoose.Types.ObjectId(), chat, run: run._id, role: "user" }], { session }));
  assert.equal(writes.length, 3);
});

test("business test boundary prohibits ledger/outbox operations and stores audit observations only in memory", async (t) => {
  const manifest = createSharedMongoManifest("persistence"); const { events } = mockSharedBusinessBoundaries(t, manifest);
  assert.throws(() => AssistantBudget.collection.findOne({ _id: "control" }), /forbids/);
  assert.throws(() => AssistantBudget.collection.updateOne({}, {}), /forbids/);
  assert.throws(() => NotificationOutboxModel.collection.insertOne({}), /forbids/);
  await AssistantEvent.create([{ owner: manifest.records.users[0], run: manifest.records.assistantruns[0], type: "message_accepted" }], { session: {} });
  assert.equal(events.length, 1);
  assert.equal(await AssistantRun.createIndexes(), undefined);
});

test("shared recovery candidate query retains predicates and is constrained to exactly the registered owner/run", (t) => {
  const manifest = createSharedMongoManifest("persistence"); const calls = []; const query = {};
  const original = t.mock.method(AssistantRun, "find", (filter) => { calls.push(filter); return query; });
  const scoped = scopeSharedBusinessRecovery(t, manifest);
  const filter = { purpose: "admin_business", phase: "reports", accounting: "settled", $or: [{ status: "dispatching" }] };
  assert.equal(AssistantRun.find(filter), query);
  assert.deepEqual(calls[0].$or, filter.$or);
  assert.equal(String(calls[0]._id), manifest.records.assistantruns[0]);
  assert.equal(String(calls[0].owner), manifest.records.users[0]);
  assert.throws(() => AssistantRun.find({ ...filter, purpose: "customer" }));
  assert.throws(() => AssistantRun.find({ ...filter, owner: "another-owner" }));
  assert.equal(calls.length, 1, "Rejected queries must never reach the database boundary");
  scoped.mock.restore(); assert.equal(AssistantRun.find, original);
});
