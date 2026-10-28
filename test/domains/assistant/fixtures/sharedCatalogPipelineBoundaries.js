import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantRun, AssistantMessage, AssistantDietaryWarning, AssistantEvent, assistantModels, AssistantAdminChat, AssistantAdminMessage } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { NotificationOutboxModel } from "../../../../src/domains/notification/notificationOutbox.model.js";
import { mockSharedAssistantStorage } from "./sharedAssistantBoundaries.js";
import { pipelineAuditTypes } from "./catalogPipelineSeed.js";

const methods = [...new Set(["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "insertOne", "insertMany",
  "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "bulkWrite", "aggregate", "distinct", "countDocuments",
  "estimatedDocumentCount", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "findAndModify", "mapReduce",
  ...Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Collection.prototype))
    .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function").map(([name]) => name)])];
const writeStores = ["assistantaccounts", "assistantchats", "assistantruns"];

// Keep casting, sessions, transactions and audits real; contain all model I/O to the saved manifest.
export function mockSharedCatalogPipelineBoundaries(t, manifest, { db, client, checkTarget }) {
  assert.equal(manifest.suite, "catalogPipeline");
  assert.match(manifest.subjectId, /^chat:[a-f\d-]{36}$/);
  const records = structuredClone(manifest.records), marker = manifest.marker, subjectId = manifest.subjectId, operations = [];
  const owner = records.users[0], chat = records.assistantchats[0], run = records.assistantruns[0];
  const refuse = () => { checkTarget(); throw new Error("Pipeline low-level schema/unknown operation forbidden"); };
  // Transactions use driver operations directly; only the initializer's exact hello command is admitted here.
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Db.prototype))) {
    if (name !== "constructor" && typeof descriptor.value === "function" && !["collection", "admin"].includes(name)) {
      t.mock.method(db, name, refuse);
    }
  }
  const originalCollection = db.collection;
  t.mock.method(db, "collection", function (name, ...args) {
    checkTarget(); assert.ok(Object.hasOwn(records, name) || name === "assistanttestbudgets", "Unregistered raw store refused");
    return originalCollection.call(this, name, ...args);
  });
  t.mock.method(client, "db", function (name, ...args) {
    checkTarget(); assert.ok(name === undefined || name === "petyard", "Unregistered database refused");
    assert.equal(args.length, 0); return db;
  });
  const originalCommand = mongoose.mongo.Admin.prototype.command;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Admin.prototype))) {
    if (name === "constructor" || typeof descriptor.value !== "function") continue;
    t.mock.method(mongoose.mongo.Admin.prototype, name, name !== "command" ? refuse : function (command, options) {
      checkTarget(); assert.equal(this.s.db, db); assert.deepEqual(command, { hello: 1 });
      return originalCommand.call(this, command, options);
    });
  }
  const nativeOperations = new Set(["find", "findOne", "insertOne", "updateOne", "findOneAndUpdate", "updateMany", "deleteMany", "countDocuments", "listIndexes"]);
  for (const method of methods) if (!nativeOperations.has(method) && typeof Object.getOwnPropertyDescriptor(mongoose.mongo.Collection.prototype, method)?.value === "function") {
    t.mock.method(mongoose.mongo.Collection.prototype, method, refuse);
  }
  const realEventCreate = AssistantEvent.create;
  mockSharedAssistantStorage(t, manifest);
  AssistantEvent.create.mock.restore();
  const initializerModels = new Set([...Object.values(assistantModels), AssistantAdminChat, AssistantAdminMessage, NotificationOutboxModel]);
  const session = (options) => { assert.ok(options?.session); assert.equal(options.session.client, client); };
  const registered = (value, ids) => {
    const values = value && typeof value === "object" && !(value instanceof mongoose.Types.ObjectId)
      ? (assert.deepEqual(Object.keys(value), ["$in"]), value.$in) : [value];
    assert.ok(Array.isArray(values) && values.every((id) => ids.includes(String(id))), "Unregistered fixture ID/owner refused");
  };
  const validateFilter = (filter, ids) => {
    assert.ok(filter && typeof filter === "object" && !Array.isArray(filter));
    for (const [key, value] of Object.entries(filter)) {
      if (["$and", "$or", "$nor"].includes(key)) {
        assert.ok(Array.isArray(value)); for (const branch of value) validateFilter(branch, ids);
      } else if (key === "_id") registered(value, ids);
      else if (["owner", "petOwner"].includes(key)) registered(value, records.users);
      else if (["chat", "run", "sourceMessage"].includes(key) && value !== null) {
        registered(value, key === "chat" ? records.assistantchats : key === "run" ? records.assistantruns : records.assistantmessages);
      }
    }
  };
  const scope = (filter, ids) => ({ $and: [filter, { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, assistantTestRun: marker }] });
  const createModels = [AssistantRun, AssistantMessage, AssistantDietaryWarning, AssistantEvent];
  for (const Model of createModels) {
    const original = Model === AssistantEvent ? realEventCreate : Model.create;
    t.mock.method(Model, "create", function (documents, options) {
      checkTarget(); session(options); assert.equal(documents.length, 1);
      const doc = documents[0]; let index = 0;
      if (Model === AssistantMessage) { assert.ok(["user", "assistant"].includes(doc.role)); index = doc.role === "user" ? 0 : 1; }
      if (Model === AssistantEvent) { index = pipelineAuditTypes.indexOf(doc.type); assert.ok(index >= 0, "Unexpected native audit type"); }
      const id = records[Model.collection.name][index];
      if (doc._id != null) assert.equal(String(doc._id), id);
      return original.call(this, [{ ...doc, _id: new mongoose.Types.ObjectId(id) }], options);
    });
  }
  for (const Model of Object.values(mongoose.models)) {
    const name = Model.collection.name, ids = records[name];
    for (const method of ["createCollection", "createIndexes", "syncIndexes", "ensureIndexes"]) {
      if (typeof Model[method] === "function" && (!initializerModels.has(Model) || !["createCollection", "createIndexes"].includes(method))) {
        t.mock.method(Model, method, () => { throw new Error("Pipeline schema changes forbidden"); });
      }
    }
    for (const method of methods) {
      if (typeof Model.collection[method] !== "function") continue;
      const original = Model.collection[method];
      t.mock.method(Model.collection, method, function (filter, ...args) {
        checkTarget();
        if (!ids) throw new Error("Pipeline unrelated model access forbidden");
        const reading = ["find", "findOne"].includes(method);
        if (!reading && !["insertOne", "updateOne", "findOneAndUpdate", "updateMany"].includes(method)) throw new Error("Pipeline collection operation forbidden");
        if (method === "insertOne") {
          session(args[0]); assert.ok(createModels.includes(Model)); registered(filter._id, ids); assert.equal(String(filter.owner), owner);
          if (name === "assistantruns") { assert.equal(String(filter.chat), chat); assert.equal(filter.purpose, "customer"); }
          if (name === "assistantmessages") {
            assert.ok(["user", "assistant"].includes(filter.role));
            assert.equal(String(filter.chat), chat); assert.equal(String(filter.run), run);
            assert.equal(String(filter._id), ids[filter.role === "user" ? 0 : 1]);
            assert.equal(filter.sequence, filter.role === "user" ? 1 : 2);
          }
          if (name === "assistantdietarywarnings") {
            assert.equal(filter.subjectId, subjectId); assert.equal(String(filter.sourceMessage), records.assistantmessages[0]);
          }
          if (name === "assistantevents") {
            assert.equal(String(filter._id), ids[pipelineAuditTypes.indexOf(filter.type)]);
            if (filter.type === "dietary_warning_recorded") {
              assert.equal(filter.run, null); assert.equal(String(filter.actor), owner);
              assert.deepEqual(filter.detail, { warningId: records.assistantdietarywarnings[0], subjectId, version: 1 });
            } else { assert.equal(String(filter.run), run); assert.equal(filter.actor, null); }
          }
          operations.push({ name, method });
          return original.call(this, { ...filter, assistantTestRun: marker }, ...args);
        }
        validateFilter(filter, ids);
        if (!reading) {
          session(args[1]);
          if (method === "updateMany") {
            assert.equal(name, "assistantmemories"); assert.deepEqual(ids, []);
            assert.deepEqual(filter, { owner: new mongoose.Types.ObjectId(owner), kind: "discussion_summary", state: "active" });
            assert.deepEqual(args[0], { $inc: { version: 1 }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 },
              $set: { state: "forgotten", updatedAt: args[0].$set.updatedAt }, $setOnInsert: { createdAt: args[0].$setOnInsert.createdAt } });
            assert.notEqual(args[1].upsert, true);
          } else {
            assert.ok(writeStores.includes(name));
            const selected = filter._id != null && String(filter._id) === ids[0];
            assert.ok(selected || String(filter.owner) === owner, "Owned ID/owner required for writes");
            if (filter.owner != null) assert.equal(String(filter.owner), owner);
            for (const [operator, fields] of Object.entries(args[0])) {
              assert.ok(["$set", "$inc", "$unset", "$setOnInsert", "$push"].includes(operator));
              assert.ok(fields && typeof fields === "object" && !Array.isArray(fields));
              for (const [key, value] of Object.entries(fields)) {
                const root = key.split(".")[0];
                if (["_id", "owner"].includes(root) && operator === "$setOnInsert" && key === root) {
                  assert.equal(method, "findOneAndUpdate"); assert.ok(["assistantaccounts", "assistantchats"].includes(name));
                  assert.equal(String(value), root === "_id" ? ids[0] : owner);
                } else assert.ok(!["_id", "owner", "assistantTestRun", "chat", "run", "sourceMessage"].includes(root), "Protected fixture identity/link update refused");
                if (root === "activeRun" && value !== null) assert.equal(String(value), run);
                if (root === "responseMessage" && value !== null) assert.equal(String(value), records.assistantmessages[1]);
              }
            }
            if (method === "findOneAndUpdate") {
              assert.ok(["assistantaccounts", "assistantchats"].includes(name)); assert.equal(String(filter.owner), owner);
              args[0] = { ...args[0], $setOnInsert: { ...args[0].$setOnInsert, _id: new mongoose.Types.ObjectId(ids[0]), assistantTestRun: marker } };
            } else assert.notEqual(args[1].upsert, true);
          }
        }
        const optionsIndex = reading ? 0 : 1;
        const options = args[optionsIndex] ?? {};
        if (name === "products") {
          assert.equal(method, "find"); assert.ok(options.limit > 0 && options.limit <= 20);
          assert.deepEqual(options.sort, { _id: 1 }); assert.equal(options.maxTimeMS, 5000);
          assert.equal(options.projection?.desc_en, undefined); assert.equal(options.projection?.desc_ar, undefined);
        }
        args[optionsIndex] = { ...options, maxTimeMS: options.maxTimeMS ?? 5000 };
        operations.push({ name, method, filter, options: args[optionsIndex] });
        return original.call(this, scope(filter, ids), ...args);
      });
    }
  }
  return operations;
}
