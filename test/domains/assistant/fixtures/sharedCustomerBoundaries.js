import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantMessage, AssistantMemory } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { mockSharedAssistantStorage } from "./sharedAssistantBoundaries.js";

export function mockSharedCustomerBoundaries(t, manifest) {
  const storage = mockSharedAssistantStorage(t, manifest);
  const owner = manifest.records.users[0]; const chat = manifest.records.assistantchats[0];
  const run = manifest.records.assistantruns[0]; const message = manifest.records.assistantmessages[0];
  // Pet retrieval and memory are outside this financial/publication check; never access their stores.
  t.mock.method(PetModel, "find", (filter) => {
    assert.deepEqual(Object.keys(filter), ["petOwner"]); assert.equal(String(filter.petOwner), owner);
    return { select() { return this; }, sort() { return this; }, limit() { return this; },
      session(value) { assert.ok(value); return this; }, async lean() { return []; } };
  });
  for (const method of ["find", "findOne", "findOneAndUpdate", "countDocuments", "updateOne", "updateMany", "insertOne", "insertMany", "deleteMany", "bulkWrite"]) {
    t.mock.method(AssistantMemory.collection, method, () => { throw new Error("Shared customer settlement test forbids memory access"); });
  }
  const check = (value) => {
    assert.equal(String(value.owner), owner); assert.equal(String(value.chat), chat);
    assert.equal(String(value.run), run); assert.equal(value.role, "assistant");
  };
  const create = AssistantMessage.create; const insert = AssistantMessage.collection.insertOne;
  t.mock.method(AssistantMessage, "create", async function (documents, options) {
    assert.equal(documents.length, 1); assert.ok(options?.session); check(documents[0]);
    return create.call(this, [{ ...documents[0], _id: new mongoose.Types.ObjectId(message) }], options);
  });
  t.mock.method(AssistantMessage.collection, "insertOne", function (document, options) {
    assert.ok(options?.session); check(document); assert.equal(String(document._id), message);
    return insert.call(this, { ...document, assistantTestRun: manifest.marker }, options);
  });
  return storage;
}
