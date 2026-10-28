import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAdminMessage, AssistantRun } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { mockSharedAssistantStorage } from "./sharedAssistantBoundaries.js";

// Recovery is global in production; a shared-DB test must never select another run.
export function scopeSharedBusinessRecovery(t, manifest) {
  const find = AssistantRun.find;
  return t.mock.method(AssistantRun, "find", function (filter) {
    assert.deepEqual(Object.keys(filter).sort(), ["$or", "accounting", "phase", "purpose"]);
    assert.equal(filter.purpose, "admin_business"); assert.equal(filter.phase, "reports"); assert.equal(filter.accounting, "settled");
    assert.ok(Array.isArray(filter.$or));
    return find.call(this, { ...filter, _id: new mongoose.Types.ObjectId(manifest.records.assistantruns[0]),
      owner: new mongoose.Types.ObjectId(manifest.records.users[0]) });
  });
}

// Call only after sharedMongoRecords.prepare(): native sessions/queries/writes remain real.
export function mockSharedBusinessBoundaries(t, manifest) {
  const owner = manifest.records.users[0]; const chat = manifest.records.assistantadminchats[0];
  const run = manifest.records.assistantruns[0]; const storage = mockSharedAssistantStorage(t, manifest);
  for (const Model of [AssistantRun, AssistantAdminMessage]) {
    const create = Model.create; const insert = Model.collection.insertOne;
    const expectedId = (value) => Model === AssistantRun ? run
      : manifest.records.assistantadminmessages[value.role === "user" ? 0 : 1];
    const check = (value) => {
      assert.equal(String(value.owner), owner); assert.equal(String(value.chat), chat);
      if (Model === AssistantRun) { assert.equal(value.purpose, "admin_business"); assert.equal(value.phase, "plan"); assert.equal(value.status, "queued"); }
      else { assert.ok(["user", "assistant"].includes(value.role)); assert.equal(String(value.run), run); }
    };
    t.mock.method(Model, "create", async function (documents, options) {
      assert.equal(documents.length, 1); assert.ok(options?.session); check(documents[0]);
      return create.call(this, [{ ...documents[0], _id: new mongoose.Types.ObjectId(expectedId(documents[0])) }], options);
    });
    t.mock.method(Model.collection, "insertOne", async function (document, options) {
      assert.ok(options?.session); check(document); assert.equal(String(document._id), expectedId(document));
      return insert.call(this, { ...document, assistantTestRun: manifest.marker }, options);
    });
  }
  return storage;
}
