import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import * as repository from "../../../src/domains/bundle/bundle.repository.js";
import { bundleNativeOptIn, bundleNativeCollections, validateBundleNativePlan, bundleNativeConnection, bundleNativeMarker,
  verifyBundleNativeEmpty, claimBundleNativeDatabase, inspectBundleNativeDatabase, cleanupBundleNativeDatabase,
  installBundleNativeGuard } from "./fixtures/bundleNativeTarget.js";

const plan = () => ({ host: "magdy.pbupj.mongodb.net", database: "ai_test_bundle_111111111111", run: "11111111-1111-1111-1111-111111111111",
  collections: [...bundleNativeCollections], maxInsertAttempts: 16, optIn: bundleNativeOptIn });
function fixture() {
  const p = plan(), f = { plan: p, stores: {}, writes: [], drops: [] };
  const db = { databaseName: p.database, listCollections: () => ({ toArray: async () => Object.keys(f.stores).map(name => ({ name })) }),
    async createCollection(name) { f.writes.push("create"); f.stores[name] = []; }, collection(name) {
      return { async insertOne(row) { f.writes.push("insert"); f.stores[name].push(row); },
        async findOne() { return f.stores[name]?.[0] ?? null; }, async countDocuments(filter) {
          const rows = f.stores[name] ?? []; return filter.fixtureRun ? rows.filter(row => row.fixtureRun !== filter.fixtureRun.$ne).length : rows.length;
        } };
    }, async dropCollection(name) { f.drops.push(name); if (f.denied === name) throw Error("drop denied"); delete f.stores[name]; } };
  const client = { options: { srvHost: p.host, dbName: "petyard" } };
  f.connection = { readyState: 1, name: p.database, db, getClient: () => client }; return f;
}

test("native plan admits only the short isolated namespace, exact test host, four named collections and fixed budget", () => {
  validateBundleNativePlan(plan());
  for (const change of [{ database: "petyard" }, { database: "ai_test_" + "x".repeat(30) + "_111111111111" },
    { host: "other.mongodb.net" }, { run: "invalid" }, { maxInsertAttempts: 17 }, { optIn: "other" },
    { collections: [...bundleNativeCollections, "carts"] }]) assert.throws(() => validateBundleNativePlan({ ...plan(), ...change }));
});
test("connection fencing catches database, host, client, handle and state changes", () => {
  for (const mode of ["name", "database", "client-default", "host", "client", "handle", "state"]) {
    const f = fixture(), scope = bundleNativeConnection(f.connection, f.plan);
    if (mode === "name") f.connection.name = "petyard";
    if (mode === "database") f.connection.db.databaseName = "petyard";
    if (mode === "client-default") f.connection.getClient().options.dbName = "other";
    if (mode === "host") f.connection.getClient().options.srvHost = "other";
    if (mode === "client") f.connection.getClient = () => ({});
    if (mode === "handle") f.connection.db = { ...f.connection.db };
    if (mode === "state") f.connection.readyState = 0;
    assert.throws(scope.check);
  }
});
test("claim requires empty namespace; cleanup validates ownership and drops marker last", async () => {
  const f = fixture(); await claimBundleNativeDatabase(f.connection, f.plan);
  assert.deepEqual(f.stores.assistanttestownership, [bundleNativeMarker(f.plan)]);
  await assert.rejects(claimBundleNativeDatabase(f.connection, f.plan)); assert.deepEqual(f.writes, ["create", "insert"]);
  f.stores.products = [{ _id: 1, fixtureRun: f.plan.run }]; f.stores.warehouses = []; f.stores.manualbundles = [];
  assert.equal((await inspectBundleNativeDatabase(f.connection, f.plan)).documents, 2);
  assert.deepEqual(await cleanupBundleNativeDatabase(f.connection, f.plan), { droppedOwnedCollections: 4, documentsBeforeCleanup: 2 });
  assert.equal(f.drops.at(-1), "assistanttestownership"); assert.equal((await verifyBundleNativeEmpty(f.connection, f.plan)).collectionsRemaining, 0);
});
test("unknown collections, foreign records, wrong marker or exceeded count block every cleanup drop", async () => {
  for (const mode of ["unknown", "foreign", "wrong", "extra-marker", "over-budget", "missing"]) {
    const f = fixture(); await claimBundleNativeDatabase(f.connection, f.plan);
    if (mode === "unknown") f.stores.carts = [];
    if (mode === "foreign") f.stores.products = [{ _id: 1 }];
    if (mode === "wrong") f.stores.assistanttestownership[0].run = "other";
    if (mode === "extra-marker") f.stores.assistanttestownership.push({ _id: "other" });
    if (mode === "over-budget") f.stores.products = Array(16).fill({ fixtureRun: f.plan.run });
    if (mode === "missing") f.stores.assistanttestownership = [];
    await assert.rejects(cleanupBundleNativeDatabase(f.connection, f.plan)); assert.deepEqual(f.drops, []);
  }
});
test("cleanup drop failure leaves marker for recovery and fresh emptiness verification refuses leftovers", async () => {
  const f = fixture(); await claimBundleNativeDatabase(f.connection, f.plan); f.stores.products = []; f.denied = "products";
  await assert.rejects(cleanupBundleNativeDatabase(f.connection, f.plan), /drop denied/);
  assert.ok(f.stores.assistanttestownership); await assert.rejects(verifyBundleNativeEmpty(f.connection, f.plan));
});
test("driver guard fences every supported write, binds mutation provenance and accepts only one declared index", t => {
  const f = fixture(), prototype = mongoose.mongo.Collection.prototype, calls = [], restorers = [];
  const context = { mock: { method(target, name, implementation) {
    const original = target[name]; restorers.push(() => { target[name] = original; }); target[name] = implementation;
  } } };
  t.after(() => { while (restorers.length) restorers.pop()(); });
  for (const name of ["insertOne", "updateOne", "findOneAndUpdate", "findOneAndDelete", "createIndex"]) context.mock.method(prototype, name, (...args) => { calls.push([name, ...args]); return "native"; });
  const guard = installBundleNativeGuard(context, f.connection, f.plan), owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "manualbundles" };
  const id = new mongoose.Types.ObjectId();
  assert.equal(prototype.insertOne.call(owned, { _id: id }), "native"); assert.equal(calls.at(-1)[1].fixtureRun, f.plan.run);
  assert.equal(prototype.findOneAndUpdate.call(owned, { _id: id, revision: 1 }, { $set: { status: "paused" }, $inc: { revision: 1 }, $setOnInsert: { createdAt: new Date() } }, { upsert: false }), "native");
  assert.equal(calls.at(-1)[1].fixtureRun, f.plan.run); assert.equal(calls.at(-1)[1].revision, 1);
  assert.equal(prototype.findOneAndDelete.call(owned, { _id: id }), "native");
  assert.equal(prototype.createIndex.call(owned, { origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" }), "native");
  for (const collection of [{ ...owned, dbName: "petyard" }, { ...owned, client: {} }, { ...owned, collectionName: "carts" }, { ...owned, collectionName: "assistanttestownership" }]) {
    assert.throws(() => prototype.insertOne.call(collection, { _id: id }));
  }
  for (const [filter, update, options] of [[{}, { $set: { price: 1 } }, {}], [{ _id: id }, { $unset: { fixtureRun: 1 } }, {}],
    [{ _id: { $gt: id } }, { $set: { price: 1 } }, {}],
    [{ _id: id }, { $set: { fixtureRun: "other" } }, {}], [{ _id: id }, { $set: { status: "published" } }, { upsert: true }],
    [{ _id: id }, [{ $set: { status: "published" } }], {}], [{ _id: id }, { $setOnInsert: { fixtureRun: f.plan.run } }, {}]]) {
    assert.throws(() => prototype.findOneAndUpdate.call(owned, filter, update, options));
  }
  assert.throws(() => prototype.findOneAndDelete.call({ ...owned, collectionName: "products" }, { _id: id }));
  assert.throws(() => prototype.createIndex.call(owned, { price: 1 }, { name: "other" }));
  assert.throws(() => prototype.createIndex.call({ ...owned, collectionName: "products" }, { origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" }));
  for (const method of ["bulkWrite", "insertMany", "deleteMany", "updateMany", "rename", "drop", "initializeOrderedBulkOp"]) assert.throws(() => prototype[method].call(owned));
  while (guard.insertAttempts() < 16) prototype.insertOne.call(owned, { _id: new mongoose.Types.ObjectId() });
  assert.throws(() => prototype.insertOne.call(owned, { _id: id }), /budget exceeded/);
});
test("database-level guard refuses app/foreign DDL, raw commands and whole-database deletion", t => {
  const f = fixture(), prototype = mongoose.mongo.Db.prototype, calls = [], restorers = [];
  const context = { mock: { method(target, name, implementation) {
    const original = target[name]; restorers.push(() => { target[name] = original; }); target[name] = implementation;
  } } };
  t.after(() => { while (restorers.length) restorers.pop()(); });
  for (const name of ["createCollection", "dropCollection"]) context.mock.method(prototype, name, value => { calls.push(value); return "native"; });
  installBundleNativeGuard(context, f.connection, f.plan);
  const owned = { client: f.connection.getClient(), databaseName: f.plan.database };
  assert.equal(prototype.createCollection.call(owned, "products"), "native");
  assert.equal(prototype.dropCollection.call(owned, "manualbundles"), "native");
  for (const foreign of [{ ...owned, databaseName: "petyard" }, { ...owned, client: {} }]) {
    assert.throws(() => prototype.createCollection.call(foreign, "products"));
    assert.throws(() => prototype.dropCollection.call(foreign, "manualbundles"));
  }
  assert.throws(() => prototype.createCollection.call(owned, "carts"));
  assert.throws(() => prototype.dropCollection.call(owned, "orders"));
  assert.throws(() => prototype.dropDatabase.call(owned)); assert.throws(() => prototype.command.call(owned, { dropDatabase: 1 }));
  assert.deepEqual(calls, ["products", "manualbundles"]);
});
test("actual Mongoose create and timestamped update paths fit the guarded single-document write contract offline", async t => {
  const id = new mongoose.Types.ObjectId(), actor = new mongoose.Types.ObjectId(), product = new mongoose.Types.ObjectId(), calls = [];
  t.mock.method(ManualBundle.collection, "insertOne", async row => { calls.push(["insert", row]); return { acknowledged: true, insertedId: row._id }; });
  t.mock.method(ManualBundle.collection, "findOneAndUpdate", async (filter, update, options) => {
    calls.push(["update", filter, update, options]); return { _id: id, origin: "manual", status: "draft", revision: 2 };
  });
  await ManualBundle.create({ _id: id, name_en: "Offline fixture", pricePiastres: 100, createdBy: actor, updatedBy: actor,
    components: [{ productId: product, productType: "SIMPLE", quantity: 1 }] });
  await repository.updateManualBundle(String(id), 1, "draft", { name_en: "Updated" });
  assert.equal(calls[0][0], "insert"); const change = calls.find(row => row[0] === "update");
  assert.ok(change[2].$set.updatedAt instanceof Date); assert.deepEqual(Object.keys(change[2].$setOnInsert), ["createdAt"]);
  assert.deepEqual(change[2].$inc, { revision: 1 }); assert.equal(change[3].upsert, undefined);
});
