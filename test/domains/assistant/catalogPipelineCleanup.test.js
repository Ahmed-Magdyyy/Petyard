import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { createSharedMongoManifest, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection, financialTestTime } from "./fixtures/isolatedBudget.js";
import { mockSharedCatalogPipelineBoundaries } from "./fixtures/sharedCatalogPipelineBoundaries.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

async function fixture(t) {
  t.mock.method(mongoose, "connect", () => assert.fail("Cleanup lifecycle regression must not connect"));
  t.mock.timers.enable({ apis: ["Date"], now: new Date(financialTestTime) });
  const config = testConfig(), budget = createIsolatedBudgetManifest(config), manifest = createSharedMongoManifest("catalogPipeline");
  manifest.records.users = [...budget.owners]; manifest.subjectId = `chat:${randomUUID()}`;
  const recorded = JSON.parse(await readFile(new URL("./fixtures/catalogCleanupIndexes.json", import.meta.url), "utf8"));
  const names = [...Object.keys(manifest.records), isolatedBudgetCollection], rows = Object.fromEntries(names.map((name) => [name, []]));
  const calls = [], failure = {}, client = { options: { srvHost: manifest.host, dbName: "petyard" } };
  let guarded = false;
  const matches = (row, filter) => filter._id.$in.some((id) => String(id) === String(row._id)) &&
    (!filter.assistantTestRun || row.assistantTestRun === filter.assistantTestRun);
  const collections = Object.fromEntries(names.map((name) => [name, {
    listIndexes() { return { async toArray() { return recorded.indexes[name] ?? [{ key: { _id: 1 }, name: "_id_" }]; } }; },
    async countDocuments(filter, options) {
      calls.push({ method: "countDocuments", name, filter, options });
      if (!guarded) return rows[name].filter((row) => matches(row, filter)).length;
      return mongoose.mongo.Collection.prototype.countDocuments.call({ aggregate: mongoose.mongo.Collection.prototype.aggregate }, filter, options);
    },
    async findOne(filter, options) {
      calls.push({ method: "findOne", name, filter, options });
      if (failure.find === name) throw new Error("synthetic absence read failure");
      return rows[name].find((row) => matches(row, filter)) ?? null;
    },
    async insertOne(row) { rows[name].push(row); },
    async insertMany(seed) { rows[name].push(...seed); },
    async deleteMany(filter, options) {
      calls.push({ method: "deleteMany", name, filter, options });
      if (failure.delete === name) throw new Error("synthetic deletion denied");
      rows[name] = rows[name].filter((row) => !matches(row, filter));
    },
  }]));
  const db = { databaseName: "petyard", collection(name) { assert.ok(Object.hasOwn(collections, name)); return collections[name]; },
    listCollections({ name }) { return { async toArray() { return [{ name }]; } }; }, admin() { return new mongoose.mongo.Admin(db); } };
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Db.prototype))) {
    if (name !== "constructor" && typeof descriptor.value === "function" && !["collection", "listCollections", "admin"].includes(name)) db[name] = () => assert.fail("Unexpected database operation");
  }
  client.db = () => db;
  const connection = { name: "petyard", readyState: 1, db, getClient: () => client };
  const application = sharedMongoRecords(connection, manifest), financial = isolatedBudgetRecords(connection, budget, config);
  await application.prepare(); await financial.prepare();
  for (const [name, ids] of Object.entries(manifest.records)) for (const id of ids) await application.insert(name, { _id: new mongoose.Types.ObjectId(id) });
  mockSharedCatalogPipelineBoundaries(t, manifest, { db, client, checkTarget() { assert.equal(connection.readyState, 1); } });
  financial.install(t); guarded = true; calls.length = 0;
  const cleanup = async () => {
    const failures = [];
    for (const scope of [application, financial]) try { await scope.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Pipeline cleanup incomplete; retain both manifests");
  };
  return { manifest, budget, rows, calls, failure, cleanup, connection };
}

test("successful native-body after-hook lifecycle cleans both scopes with aggregate still refused and restores all resources", async (t) => {
  const f = await fixture(t), lifecycle = [];
  const unrelated = { _id: new mongoose.Types.ObjectId(), assistantTestRun: f.manifest.marker };
  f.rows.users.push(unrelated);
  f.rows[isolatedBudgetCollection].push({ _id: "unregistered", assistantTestRun: f.budget.marker });
  t.after(async () => {
    assert.throws(() => mongoose.mongo.Collection.prototype.aggregate.call({}, []), /forbidden/);
    await cleanupAssistantTestResources({ servers: [{ listening: true, closeAllConnections() { lifecycle.push("connections"); }, close(done) { lifecycle.push("server"); done(); } }],
      cleanupCollections: f.cleanup, async disconnect() { lifecycle.push("disconnect"); }, restoreEnvironment() { lifecycle.push("restore"); t.mock.timers.reset(); } });
    assert.deepEqual(lifecycle, ["connections", "server", "disconnect", "restore"]);
    assert.deepEqual(f.rows.users, [unrelated]); assert.equal(f.rows[isolatedBudgetCollection].length, 1);
    assert.equal(Object.values(f.rows).flat().length, 2);
    const reads = f.calls.filter((call) => call.method === "findOne"); assert.equal(reads.length, 11);
    assert.equal(f.calls.some((call) => call.method === "countDocuments"), false);
    for (const call of reads) { assert.equal(call.filter.assistantTestRun, undefined); assert.deepEqual(call.options, { projection: { _id: 1 }, maxTimeMS: 5000 }); }
    for (const call of f.calls.filter((call) => call.method === "deleteMany")) {
      assert.equal(call.filter.assistantTestRun, call.name === isolatedBudgetCollection ? f.budget.marker : f.manifest.marker);
      assert.deepEqual(call.filter._id.$in.map(String), call.name === isolatedBudgetCollection ? f.budget.ids : f.manifest.records[call.name]);
    }
    assert.throws(() => mongoose.mongo.Collection.prototype.aggregate.call({}, []), /forbidden/);
  });
});

test("cleanup failures in both scopes remain reported while other collections, disconnect and Date restoration complete", async (t) => {
  const f = await fixture(t), lifecycle = [];
  f.failure.delete = "products"; f.failure.find = isolatedBudgetCollection;
  await assert.rejects(cleanupAssistantTestResources({ servers: [], cleanupCollections: f.cleanup,
    async disconnect() { lifecycle.push("disconnect"); }, restoreEnvironment() { lifecycle.push("restore"); t.mock.timers.reset(); } }),
  (error) => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] instanceof AggregateError &&
    /absence read failure/.test(error.errors[1].message));
  assert.deepEqual(lifecycle, ["disconnect", "restore"]);
  assert.equal(f.rows.products.length, 1); assert.equal(f.rows.users.length, 0); assert.equal(f.rows[isolatedBudgetCollection].length, 0);
  assert.equal(f.calls.filter((call) => call.method === "deleteMany").length, 11);
});

test("ID-only absence reads detect changed ownership markers after exact marked deletion in both scopes", async (t) => {
  const f = await fixture(t);
  f.rows.users[0].assistantTestRun = "changed"; f.rows[isolatedBudgetCollection][0].assistantTestRun = "changed";
  await assert.rejects(f.cleanup(), (error) => error instanceof AggregateError && error.errors.length === 2 &&
    /cleanup incomplete/.test(error.errors[1].message));
  assert.equal(f.rows.users.length, 1); assert.equal(f.rows[isolatedBudgetCollection].length, 1);
  t.mock.timers.reset();
});
