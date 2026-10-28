import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { AssistantAccount, AssistantChat, AssistantRun, AssistantMessage, AssistantDietaryWarning, AssistantMemory, AssistantEvent, AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { mockSharedCatalogPipelineBoundaries } from "./fixtures/sharedCatalogPipelineBoundaries.js";
import { catalogPipelineSeed, pipelineAuditTypes } from "./fixtures/catalogPipelineSeed.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { createIsolatedBudgetManifest } from "./fixtures/isolatedBudget.js";

function fixture(t) {
  const manifest = createSharedMongoManifest("catalogPipeline"); manifest.subjectId = `chat:${randomUUID()}`;
  const db = { collection(name) { return { name }; } };
  const client = { db() { return db; } }, session = new (class { constructor() { this.client = client; } })(), calls = [], target = { valid: true };
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Db.prototype))) {
    if (name !== "constructor" && typeof descriptor.value === "function" && !["collection", "admin"].includes(name)) db[name] = () => assert.fail("Raw database operation reached driver");
  }
  db.admin = () => new mongoose.mongo.Admin(db);
  t.mock.method(mongoose.mongo.Admin.prototype, "command", async (command) => { assert.deepEqual(command, { hello: 1 }); return { setName: "synthetic-replica" }; });
  for (const Model of [AssistantAccount, AssistantChat, AssistantRun, AssistantMessage, AssistantDietaryWarning, AssistantMemory, AssistantEvent, ProductModel, PetModel, UserModel]) {
    for (const method of ["find", "findOne", "insertOne", "updateOne", "updateMany", "findOneAndUpdate"]) {
      t.mock.method(Model.collection, method, (filter, ...args) => {
        calls.push({ name: Model.collection.name, method, filter, args });
        return method === "find" ? { async toArray() { return []; } } : Promise.resolve({ acknowledged: true, modifiedCount: 0 });
      });
    }
  }
  const operations = mockSharedCatalogPipelineBoundaries(t, manifest, { db, client, checkTarget: () => assert.ok(target.valid, "target changed") });
  const owner = new mongoose.Types.ObjectId(manifest.records.users[0]);
  return { manifest, owner, client, db, session, calls, operations, target };
}

test("pipeline scopes native reads, preserves foreign ownership predicates and contains zero-record stores", async (t) => {
  const f = fixture(t), foreign = new mongoose.Types.ObjectId(f.manifest.records.users[1]);
  await AssistantMessage.find({ owner: foreign }).lean();
  await PetModel.find({ petOwner: f.owner }).lean();
  await ProductModel.find({ isActive: true }).select("_id name_en").sort({ _id: 1 }).limit(20).maxTimeMS(5000).lean();
  assert.equal(String(f.calls[0].filter.$and[0].owner), String(foreign));
  assert.deepEqual(f.calls[0].filter.$and[1]._id.$in.map(String), f.manifest.records.assistantmessages);
  assert.deepEqual(f.calls[1].filter.$and[1]._id.$in, []);
  assert.equal(f.calls[2].args[0].projection.name_en, 1);
  const original = [...f.manifest.records.products]; f.manifest.records.products.push(String(new mongoose.Types.ObjectId()));
  assert.throws(() => ProductModel.collection.find({ _id: f.manifest.records.products[1] }), /Unregistered/);
  assert.deepEqual(f.calls[2].filter.$and[1]._id.$in.map(String), original);
});

test("pipeline keeps real schema/create/driver path for all eight service-created rows and four native audit types", async (t) => {
  const f = fixture(t), config = testConfig(), budget = createIsolatedBudgetManifest(config);
  budget.owners = [...f.manifest.records.users];
  const planned = await catalogPipelineSeed(f.manifest, budget, config);
  const models = { assistantruns: AssistantRun, assistantmessages: AssistantMessage, assistantdietarywarnings: AssistantDietaryWarning, assistantevents: AssistantEvent };
  for (const row of planned.planned.filter((row) => Object.hasOwn(models, row.collection))) {
    const { _id, ...document } = row.document;
    await models[row.collection].create([document], { session: f.session });
  }
  assert.equal(f.calls.length, 8);
  assert.deepEqual(f.calls.filter((call) => call.name === "assistantevents").map((call) => call.filter.type), pipelineAuditTypes);
  for (const call of f.calls) {
    assert.ok(f.manifest.records[call.name].includes(String(call.filter._id)));
    assert.equal(call.filter.assistantTestRun, f.manifest.marker); assert.equal(call.args[0].session, f.session);
  }
  assert.throws(() => AssistantEvent.create([{ owner: f.owner, type: "memory_saved" }], { session: f.session }), /Unexpected/);
});

test("pipeline permits native owned admission updates and empty summary invalidation, with exact outer scope", async (t) => {
  const f = fixture(t);
  await AssistantAccount.findOneAndUpdate({ owner: f.owner }, { $setOnInsert: { owner: f.owner } }, { upsert: true, new: true, session: f.session });
  await AssistantMemory.updateMany({ owner: f.owner, kind: "discussion_summary", state: "active" }, {
    $set: { state: "forgotten" }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 }, $inc: { version: 1 } }, { session: f.session });
  assert.equal(String(f.calls[0].args[0].$setOnInsert._id), f.manifest.records.assistantaccounts[0]);
  assert.equal(f.calls[0].args[0].$setOnInsert.assistantTestRun, f.manifest.marker);
  assert.deepEqual(f.calls[1].filter.$and[1]._id.$in, []);
});

test("pipeline refuses unrelated writes, unregistered identities, missing/foreign sessions, DDL and changed targets before delegation", async (t) => {
  const f = fixture(t), own = { owner: f.owner }, options = { session: f.session };
  for (const operation of [
    () => AssistantBudget.collection.findOne({ _id: "control" }),
    () => NotificationOutboxModel.collection.insertOne({}),
    () => UserModel.collection.updateOne(own, { $set: { active: false } }, options),
    () => AssistantRun.collection.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { status: "queued" } }, options),
    () => AssistantAccount.collection.updateOne({ owner: f.manifest.records.users[1] }, { $set: { blocked: true } }, options),
    () => AssistantAccount.collection.updateOne(own, { $set: { owner: f.owner } }, options),
    () => AssistantAccount.collection.updateOne(own, { $rename: { activeRun: "chat" } }, options),
    () => AssistantRun.collection.updateOne(own, { $set: { "chat.x": 1 } }, options),
    () => AssistantAccount.collection.updateOne(own, { $inc: { dayMessages: 1 } }),
    () => AssistantAccount.collection.updateOne(own, { $inc: { dayMessages: 1 } }, { session: { client: {} } }),
    () => ProductModel.collection.find({}, { sort: { _id: -1 }, limit: 20, maxTimeMS: 5000 }),
    () => AssistantRun.collection.deleteMany({}), () => AssistantRun.collection.createIndex({ owner: 1 }),
    () => AssistantEvent.collection.insertOne({ _id: f.manifest.records.assistantevents[0], owner: f.owner, type: "run_completed", run: f.manifest.records.assistantruns[0], actor: null }, options),
  ]) assert.throws(operation);
  assert.equal(f.calls.length, 0);
  f.target.valid = false;
  assert.throws(() => AssistantAccount.collection.findOne(own), /target changed/);
  assert.equal(f.calls.length, 0);
});

test("pipeline blocks database/admin/raw collection DDL and unknown driver APIs while retaining only the actual hello shape", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.db.admin().command({ hello: 1 }), { setName: "synthetic-replica" });
  assert.equal(f.client.db("petyard"), f.db); assert.equal(f.db.collection("assistanttestbudgets").name, "assistanttestbudgets");
  for (const operation of [
    () => f.db.createCollection("arbitrary"), () => f.db.dropDatabase(), () => f.db.dropCollection("products"),
    () => f.db.listCollections({}),
    () => f.db.command({ create: "products" }), () => f.db.runCursorCommand({ aggregate: "products", pipeline: [] }),
    () => f.db.admin().command({ hello: 1, dropDatabase: 1 }), () => f.db.admin().command({ dropDatabase: 1 }),
    () => f.db.admin().removeUser("synthetic"), () => f.client.db("other"), () => f.db.collection("assistantbudgets"),
    () => ProductModel.collection.createSearchIndex({}), () => ProductModel.collection.rename("elsewhere"),
    () => ProductModel.collection.initializeUnorderedBulkOp(),
    () => mongoose.mongo.Collection.prototype.createIndex.call({}, { owner: 1 }),
    () => mongoose.mongo.Collection.prototype.rename.call({}, "elsewhere"),
    () => mongoose.mongo.Collection.prototype.updateSearchIndex.call({}, "name", {}),
  ]) assert.throws(operation);
  assert.equal(f.calls.length, 0);
});

test("actual driver countDocuments remains refused because its internal aggregate hits the unchanged boundary", async (t) => {
  const f = fixture(t);
  const collection = { aggregate: mongoose.mongo.Collection.prototype.aggregate };
  await assert.rejects(mongoose.mongo.Collection.prototype.countDocuments.call(collection,
    { _id: { $in: [] }, assistantTestRun: f.manifest.marker }, { maxTimeMS: 5000 }), /schema\/unknown operation forbidden/);
  assert.equal(f.calls.length, 0);
});
