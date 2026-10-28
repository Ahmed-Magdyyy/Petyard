import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantChat, AssistantDietaryWarning, AssistantEvent, AssistantMemory, AssistantMessage, AssistantRun } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { mockSharedAssistantStorage } from "./sharedAssistantBoundaries.js";
import { customerRunFilter } from "../../../../src/domains/assistant/shared/assistant.purpose.js";

// Native publication only: all model operations must remain within these exact manifest records.
export function mockSharedCatalogBoundaries(t, manifest, { subjectId, client, checkTarget }) {
  assert.equal(manifest.suite, "catalogPublication");
  assert.match(subjectId, /^chat:[a-f\d-]{36}$/);
  const storage = mockSharedAssistantStorage(t, manifest);
  const owner = manifest.records.users[0], chat = manifest.records.assistantchats[0], run = manifest.records.assistantruns[0];
  const marker = manifest.marker;
  const owns = (value) => String(value) === owner;
  const originalEvent = AssistantEvent.create;
  t.mock.method(AssistantEvent, "create", async function (documents, options) {
    checkTarget(); assert.equal(documents.length, 1); assert.equal(options?.session?.client, client);
    const event = documents[0];
    if (event.type !== "dietary_warning_recorded") return originalEvent.call(this, documents, options);
    // Warning audits intentionally bind the owner/subject/warning rather than a run.
    assert.ok(owns(event.owner)); assert.ok(owns(event.actor)); assert.equal(event.run, null);
    assert.deepEqual(event.detail, { warningId: manifest.records.assistantdietarywarnings[0], subjectId, version: 1 });
    storage.events.push(event); return [{ _id: new mongoose.Types.ObjectId() }];
  });
  const methods = ["find", "findOne", "findOneAndUpdate", "updateOne", "updateMany", "insertOne", "insertMany", "deleteOne", "deleteMany",
    "aggregate", "countDocuments", "estimatedDocumentCount", "distinct", "bulkWrite", "replaceOne", "findOneAndDelete", "findOneAndReplace"];
  for (const Model of [UserModel, AssistantAccount, AssistantChat, AssistantRun, AssistantMessage, AssistantDietaryWarning]) {
    const name = Model.collection.name, ids = manifest.records[name]; assert.ok(ids);
    for (const method of methods) {
      const original = Model.collection[method];
      t.mock.method(Model.collection, method, function (filter, ...args) {
        checkTarget();
        if (!["find", "findOne", "findOneAndUpdate", "updateOne", "insertOne"].includes(method)) throw new Error("Catalog native suite forbids this collection operation");
        if (method === "insertOne") {
          assert.ok(args[0]?.session); assert.equal(args[0].session.client, client);
          assert.ok(ids.includes(String(filter._id))); assert.ok(owns(filter.owner));
          if (name === "assistantmessages") { assert.equal(String(filter._id), ids[1]); assert.equal(String(filter.chat), chat); assert.equal(String(filter.run), run); assert.equal(filter.role, "assistant"); }
          else {
            assert.equal(name, "assistantdietarywarnings"); assert.equal(filter.subjectId, subjectId);
            assert.equal(String(filter.sourceMessage), manifest.records.assistantmessages[0]);
          }
          return original.call(this, { ...filter, assistantTestRun: marker }, ...args);
        }
        assert.ok(filter && typeof filter === "object");
        let scope = filter;
        if (Object.hasOwn(filter, "$and")) {
          assert.equal(name, "assistantruns"); assert.deepEqual(Object.keys(filter), ["$and"]);
          assert.ok(Array.isArray(filter.$and)); assert.equal(filter.$and.length, 2);
          assert.deepEqual(filter.$and[1], customerRunFilter({}).$and[1]);
          scope = filter.$and[0]; assert.ok(scope && typeof scope === "object");
        }
        const byId = scope._id != null && ids.includes(String(scope._id));
        const byOwner = scope.owner != null && manifest.records.users.includes(String(scope.owner));
        assert.ok(byId || byOwner, "No broad or foreign model reads/writes");
        if (scope._id != null) assert.ok(byId);
        if (scope.owner != null) assert.ok(byOwner);
        if (name === "assistantdietarywarnings") { assert.ok(owns(filter.owner)); assert.equal(filter.subjectId, subjectId); }
        if (["updateOne", "findOneAndUpdate"].includes(method)) {
          assert.ok(args[1]?.session); assert.equal(args[1].session.client, client);
          assert.ok(["assistantaccounts", "assistantchats", "assistantruns"].includes(name));
          if (!byId) assert.ok(owns(filter.owner));
          for (const [operator, fields] of Object.entries(args[0])) {
            assert.ok(["$set", "$inc", "$unset", "$setOnInsert", "$push"].includes(operator));
            assert.ok(fields && typeof fields === "object");
            assert.equal(Object.keys(fields).some((key) => ["_id", "assistantTestRun", "chat", "run", "sourceMessage"].includes(key.split(".")[0])), false);
            assert.equal(Object.keys(fields).some((key) => key.startsWith("owner.")), false);
            if (Object.hasOwn(fields, "owner")) { assert.equal(operator, "$setOnInsert"); assert.ok(owns(fields.owner)); }
          }
          if (method === "findOneAndUpdate") {
            assert.ok(["assistantaccounts", "assistantchats"].includes(name));
            args[0] = { ...args[0], $setOnInsert: { ...args[0].$setOnInsert, _id: new mongoose.Types.ObjectId(ids[0]), assistantTestRun: marker } };
          }
        }
        return original.call(this, { ...filter, assistantTestRun: marker }, ...args);
      });
    }
  }
  for (const [Model, index] of [[AssistantMessage, 1], [AssistantDietaryWarning, 0]]) {
    const original = Model.create;
    t.mock.method(Model, "create", function (documents, options) {
      assert.equal(documents.length, 1); assert.ok(options?.session);
      return original.call(this, [{ ...documents[0], _id: new mongoose.Types.ObjectId(manifest.records[Model.collection.name][index]) }], options);
    });
  }
  // Unsaved subject and empty memory are deliberately simulated; no saved-pet or memory collection is touched.
  for (const method of methods) {
    t.mock.method(PetModel.collection, method, () => { throw new Error("Catalog native suite forbids saved-pet access"); });
    t.mock.method(AssistantMemory.collection, method, () => { throw new Error("Catalog native suite forbids memory storage"); });
  }
  t.mock.method(PetModel, "find", (filter) => {
    assert.deepEqual(Object.keys(filter), ["petOwner"]); assert.ok(owns(filter.petOwner));
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, session(value) { assert.ok(value); return this; }, async lean() { return []; } };
  });
  t.mock.method(AssistantMemory, "updateMany", async (filter, _update, options) => {
    assert.ok(owns(filter.owner)); assert.equal(filter.kind, "discussion_summary"); assert.equal(filter.state, "active");
    assert.ok(options?.session); return { modifiedCount: 0 };
  });
  return storage;
}
