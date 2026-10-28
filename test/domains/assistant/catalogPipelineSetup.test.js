import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantEvent, AssistantMemory } from "../../../src/domains/assistant/shared/assistant.models.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { catalogPipelineSetupApproval, catalogPipelineSetupPlan, setupCatalogPipelineStores } from "./fixtures/catalogPipelineSetup.js";

function fixture() {
  const manifest = createSharedMongoManifest("catalogPipeline"), plan = catalogPipelineSetupPlan(), calls = [], journal = [], fail = {};
  const data = Object.fromEntries([...Object.keys(manifest.records), "assistanttestbudgets"]
    .filter((name) => !Object.hasOwn(plan, name)).map((name) => [name, [{ v: 2, key: { _id: 1 }, name: "_id_" }]]));
  const client = { options: { srvHost: manifest.host, dbName: "petyard" } };
  const connection = { name: "petyard", readyState: 1, getClient: () => client, db: { databaseName: "petyard",
    listCollections({ name }, options) {
      assert.deepEqual(options, { nameOnly: true }); calls.push({ method: "list", name });
      return { async toArray() { return Object.hasOwn(data, name) ? [{ name }] : []; } };
    },
    async createCollection(name, options) {
      calls.push({ method: "createCollection", name, options }); assert.equal(Object.hasOwn(plan, name), true);
      assert.equal(Object.hasOwn(data, name), false); assert.deepEqual(options, { writeConcern: { w: "majority" } });
      data[name] = [{ v: 2, key: { _id: 1 }, name: "_id_" }];
    },
    collection(name) { assert.ok(Object.hasOwn(data, name)); return {
      listIndexes() { return { async toArray() { return structuredClone(data[name]); } }; },
      async countDocuments(filter, options) { assert.deepEqual(filter, {}); assert.deepEqual(options, { maxTimeMS: 5000 }); return fail.nonempty === name ? 1 : 0; },
      async createIndex(key, { writeConcern, ...options }) {
        calls.push({ method: "createIndex", name, key, options });
        assert.equal(Object.hasOwn(plan, name), true); assert.deepEqual(writeConcern, { w: "majority" });
        if (fail.index) throw new Error("synthetic index failure");
        data[name].push({ v: 2, key, ...options });
      },
    }; },
  } };
  return { connection, calls, data, fail, journal, persist: async (value) => { journal.push(value); } };
}

test("setup plan matches exactly two actual model index definitions and creates only empty stores with seven indexes", async (t) => {
  t.mock.method(mongoose, "connect", () => assert.fail("Offline setup check must not connect"));
  const plan = catalogPipelineSetupPlan();
  assert.deepEqual(Object.keys(plan), ["assistantevents", "assistantmemories"]);
  for (const Model of [AssistantEvent, AssistantMemory]) {
    assert.deepEqual(plan[Model.collection.name].map(({ key, name, ...options }) => [key, options]), Model.schema.indexes());
  }
  const f = fixture(), before = structuredClone(f.data);
  const result = await setupCatalogPipelineStores(f.connection, catalogPipelineSetupApproval, f.persist);
  assert.equal(result.status, "verified_empty_stores_existing_indexes_unchanged");
  assert.equal(f.calls.filter((call) => call.method === "createCollection").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "createIndex").length, 7);
  for (const [name, indexes] of Object.entries(before)) assert.deepEqual(f.data[name], indexes);
  assert.equal(Object.keys(result.before).length, 14); assert.equal(result.completed.length, 9);
  assert.equal(f.journal[0].status, "ready"); assert.equal(f.journal[0].completed.length, 0);
  assert.deepEqual(f.journal[1].pending, { method: "createCollection", collection: "assistantevents" });
  await assert.rejects(setupCatalogPipelineStores(f.connection, catalogPipelineSetupApproval, f.persist), /existing target/);
  assert.equal(f.calls.filter((call) => call.method === "createCollection").length, 2, "No replay of completed setup");
});

test("setup refuses wrong approval/target, missing prerequisites or preexisting target before any schema write", async () => {
  for (const change of [
    (f) => { f.approval = "wrong"; }, (f) => { f.connection.name = "production"; },
    (f) => { delete f.data.users; }, (f) => { delete f.data.assistanttestbudgets; },
    (f) => { f.data.assistantevents = []; }, (f) => { f.data.assistantmemories = []; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(setupCatalogPipelineStores(f.connection, f.approval ?? catalogPipelineSetupApproval, f.persist));
    assert.equal(f.calls.some((call) => call.method.startsWith("create")), false);
  }
});

test("setup journals partial failure and stops without rollback deletion, index repair or creating the second store", async () => {
  const f = fixture(); f.fail.index = true;
  await assert.rejects(setupCatalogPipelineStores(f.connection, catalogPipelineSetupApproval, f.persist), /synthetic index failure/);
  assert.deepEqual(f.journal.at(-1).pending, { method: "createIndex", collection: "assistantevents", name: "owner_1_createdAt_-1" });
  assert.deepEqual(f.journal.at(-1).completed, [{ method: "createCollection", collection: "assistantevents" }]);
  assert.equal(Object.hasOwn(f.data, "assistantmemories"), false);
  assert.equal(f.data.assistantevents.length, 1);
});

test("setup checks target before every mutation and refuses a nonempty new store before indexing", async () => {
  const changed = fixture();
  await assert.rejects(setupCatalogPipelineStores(changed.connection, catalogPipelineSetupApproval, async (journal) => {
    if (journal.pending) changed.connection.readyState = 0;
  }), /not authorized/);
  assert.equal(changed.calls.some((call) => call.method.startsWith("create")), false);
  const nonempty = fixture(); nonempty.fail.nonempty = "assistantevents";
  await assert.rejects(setupCatalogPipelineStores(nonempty.connection, catalogPipelineSetupApproval, nonempty.persist));
  assert.equal(nonempty.calls.some((call) => call.method === "createIndex"), false);
});
