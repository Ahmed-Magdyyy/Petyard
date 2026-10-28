import test from "node:test";
import assert from "node:assert/strict";
import { AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection } from "./fixtures/isolatedBudget.js";

function fixture() {
  const config = testConfig(); const manifest = createIsolatedBudgetManifest(config); let rows = []; const calls = []; const failures = {};
  const matches = (row, filter) => (typeof filter._id === "string" ? row._id === filter._id : filter._id.$in.includes(row._id)) &&
    (!filter.assistantTestRun || row.assistantTestRun === filter.assistantTestRun);
  const collection = {
    async countDocuments(filter) { calls.push(["count", filter]); return rows.filter((row) => matches(row, filter)).length; },
    async findOne(filter, options) { calls.push(["findOne", filter, options]); return rows.find((row) => matches(row, filter)) ?? null; },
    async insertMany(seed) { rows.push(...(failures.insert ? seed.slice(0, 1) : seed)); if (failures.insert) throw new Error("partial insert"); },
    async deleteMany(filter) { calls.push(["delete", filter]); if (failures.delete) throw new Error("delete denied"); rows = rows.filter((row) => !matches(row, filter)); },
    async updateOne(...args) { calls.push(["updateOne", ...args]); return { modifiedCount: 1 }; },
    async findOneAndUpdate(...args) { calls.push(["findOneAndUpdate", ...args]); return { _id: args[0]._id }; },
  };
  const client = { options: { srvHost: manifest.host, dbName: "petyard" } };
  const connection = { readyState: 1, name: "petyard", getClient: () => client,
    db: { databaseName: "petyard", collection(name) { assert.equal(name, isolatedBudgetCollection); return collection; },
      listCollections(filter) { assert.deepEqual(filter, { name: isolatedBudgetCollection }); return { async toArray() { return failures.missing ? [] : [{ name: isolatedBudgetCollection }]; } }; } } };
  return { config, manifest, client, connection, calls, failures, rows: () => rows };
}

test("isolated financial manifest closes collection/IDs/owner scope before database access", () => {
  for (const mutate of [(f) => { f.manifest.collection = "assistantbudgets"; }, (f) => { f.manifest.ids.push("foreign"); },
    (f) => { f.manifest.owners[1] = f.manifest.owners[0]; }, (f) => { f.connection.name = "production"; }]) {
    const f = fixture(); mutate(f); assert.throws(() => isolatedBudgetRecords(f.connection, f.manifest, f.config));
    assert.deepEqual(f.calls, []);
  }
});

test("missing ledger or existing IDs refuse insertion and leave cleanup unarmed", async () => {
  for (const missing of [true, false]) {
    const f = fixture(); if (missing) f.failures.missing = true; else f.rows().push({ _id: "control", assistantTestRun: f.manifest.marker });
    const owned = isolatedBudgetRecords(f.connection, f.manifest, f.config);
    await assert.rejects(owned.prepare(), missing ? /missing/ : /already exist/); await owned.cleanup();
    assert.equal(f.calls.some((call) => call[0] === "delete"), false);
  }
});

test("budget model writes redirect only exact registered IDs and matching sessions to the marked test ledger", async (t) => {
  const f = fixture(); const owned = isolatedBudgetRecords(f.connection, f.manifest, f.config);
  assert.throws(() => owned.install(t), /Prepare/); await owned.prepare(); owned.install(t);
  assert.equal(f.rows().length, 5); assert.ok(f.rows().every((row) => row.assistantTestRun === f.manifest.marker));
  const session = { client: f.client };
  await AssistantBudget.collection.updateOne({ _id: "control", frozen: false }, { $set: { frozen: true } }, { session });
  const call = f.calls.at(-1); assert.equal(call[0], "updateOne");
  assert.deepEqual(call[1], { _id: "control", frozen: false, assistantTestRun: f.manifest.marker });
  assert.equal(call[2].$setOnInsert.assistantTestRun, f.manifest.marker);
  await AssistantBudget.collection.findOneAndUpdate({ _id: "control" }, { $setOnInsert: { spent: 0 } }, { session });
  assert.equal(f.calls.at(-1)[0], "findOneAndUpdate");
  const count = f.calls.length;
  for (const [filter, options] of [[{ _id: "foreign" }, { session }], [{}, { session }], [{ _id: "control" }, { session: { client: {} } }]]) {
    await assert.rejects(AssistantBudget.collection.updateOne(filter, { $inc: { spent: 1 } }, options));
  }
  assert.equal(f.calls.length, count);
  assert.throws(() => AssistantBudget.collection.findOne({ _id: "control" }), /forbidden/);
  assert.throws(() => AssistantBudget.createCollection(), /forbidden/);
  await owned.cleanup(); assert.equal(f.rows().length, 0);
});

test("partial seed failures clean exact marked records and preserve unrelated records", async () => {
  const f = fixture(); f.failures.insert = true;
  const foreign = { _id: "unrelated", assistantTestRun: f.manifest.marker }; f.rows().push(foreign);
  const owned = isolatedBudgetRecords(f.connection, f.manifest, f.config); await assert.rejects(owned.prepare(), /partial insert/);
  await owned.cleanup(); assert.deepEqual(f.rows(), [foreign]);
});

test("ownership changes or delete denial remain visible without deleting unowned records", async () => {
  for (const denied of [true, false]) {
    const f = fixture(); const owned = isolatedBudgetRecords(f.connection, f.manifest, f.config); await owned.prepare();
    if (denied) f.failures.delete = true; else f.rows()[0].assistantTestRun = "foreign";
    await assert.rejects(owned.cleanup(), denied ? /delete denied/ : /cleanup incomplete/);
    assert.ok(f.rows().length > 0);
  }
});
