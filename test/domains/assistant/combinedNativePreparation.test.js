import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import { validateCombinedNativePlan, combinedNativeConnection, combinedNativeMarker, claimCombinedNativeDatabase,
  cleanupCombinedNativeDatabase, installCombinedNativeGuard, nativeIndexDefinition } from "./fixtures/combinedNative.js";
import { combinedNativeModels, combinedNativeConfig } from "./fixtures/combinedNativeModels.js";
const directory = ".scratch/assistant-acceptance/combined-native-v5/";
const plan = JSON.parse(await readFile(new URL("./fixtures/combinedNativePlan.json", import.meta.url), "utf8"));
mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
function fixture() {
  const p = structuredClone(plan), stores = {}, drops = [], client = { options: { srvHost: p.host, dbName: "petyard" } };
  const f = { p, stores, drops, client, search: [], extraIndex: null };
  const db = { databaseName: p.database,
    listCollections: () => ({ toArray: async () => Object.keys(stores).map(name => ({ name })) }),
    async createCollection(name) { stores[name] = []; }, async dropCollection(name) { drops.push(name); delete stores[name]; },
    collection(name) { return {
      async insertOne(row) { (stores[name] ??= []).push(structuredClone(row)); },
      async findOne(filter) { return stores[name]?.find(row => row._id === filter._id) ?? null; },
      async countDocuments(filter = {}) { return (stores[name] ?? []).filter(row => !filter.fixtureRun || row.fixtureRun !== filter.fixtureRun.$ne).length; },
      indexes: async () => [{ key: { _id: 1 }, name: "_id_" }, ...(f.extraIndex ? [f.extraIndex] : [])],
      listSearchIndexes: () => ({ toArray: async () => f.search }),
    }; },
  };
  f.connection = { readyState: 1, name: p.database, db, getClient: () => client }; return f;
}
function collection(f, name) {
  const value = Object.create(mongoose.mongo.Collection.prototype);
  Object.defineProperties(value, { client: { value: f.client }, dbName: { value: f.p.database }, collectionName: { value: name } });
  return value;
}
test("combined plan pins scope, ceilings, operational namespace and exact current model indexes", async () => {
  validateCombinedNativePlan(plan);
  for (const patch of [{ host: "production.invalid" }, { database: "petyard" }, { caseCount: 9 }, { maxInsertAttempts: 257 },
    { maxFakeCalls: 5 }, { collections: [...plan.collections, "payments"] }, { indexes: {} }])
    assert.throws(() => validateCombinedNativePlan({ ...plan, ...patch }));
  const m = await combinedNativeModels(); const expected = Object.fromEntries(m.indexed.map(model =>
    [model.collection.name, model.schema.indexes().map(([key, options]) => nativeIndexDefinition(key, options))]));
  expected.carts = [nativeIndexDefinition({ user: 1 }, { unique: true })];
  assert.deepEqual(plan.indexes, expected); assert.equal(plan.collections.length, 27); assert.equal(Object.values(expected).flat().length, 40);
});
test("ownership cleanup refuses foreign rows, namespaces, normal indexes and Search indexes", async () => {
  for (const mode of ["row", "namespace", "normal-index", "search-index", "marker"]) {
    const f = fixture(); await claimCombinedNativeDatabase(f.connection, f.p);
    if (mode === "row") f.stores.products = [{ _id: "foreign" }];
    if (mode === "namespace") f.stores.foreign = [];
    if (mode === "normal-index") f.extraIndex = { key: { unexpected: 1 }, name: "unexpected_1" };
    if (mode === "search-index") f.search = [{ name: "foreign" }];
    if (mode === "marker") f.stores.assistanttestownership[0].run = "changed";
    await assert.rejects(cleanupCombinedNativeDatabase(f.connection, f.p)); assert.deepEqual(f.drops, []);
  }
  const f = fixture(); await claimCombinedNativeDatabase(f.connection, f.p);
  f.stores.products = [{ _id: "owned", fixtureRun: f.p.run }];
  assert.equal((await cleanupCombinedNativeDatabase(f.connection, f.p)).droppedOwnedCollections, 2);
  assert.deepEqual(f.drops, ["products", "assistanttestownership"]);
});
test("the actual native configuration enables every exercised cart and business capability before connection", async () => {
  const config = await combinedNativeConfig("1".repeat(24));
  const { requireCartActions } = await import("../../../src/domains/assistant/shared/assistant.config.js");
  const { businessConfigSnapshot } = await import("../../../src/domains/assistant/admin/assistant.admin-policy.js");
  requireCartActions(config); assert.equal(config.bundleCartEnabled, true); assert.equal(config.adminEnabled, true);
  assert.equal(config.cartPolicy.proposalSeconds, 600); assert.ok(businessConfigSnapshot(config).adminPromptVersion);
});
test("a raw catalog result is not a persisted card snapshot; the production snapshot builder supplies its contract", async () => {
  const { buildCatalogSnapshot, storedCatalogDto } = await import("../../../src/domains/assistant/products/assistant.product-cards.js");
  const warehouse = "1".repeat(24), product = "2".repeat(24);
  const outcome = { status: "results", requestedWarehouseId: warehouse, effectiveWarehouseId: warehouse, rerouted: false,
    generatedAt: null, products: [{ id: product, slug: "toy", name: "Toy", type: "SIMPLE", image: null,
      price: 100, discountedPrice: null, inStock: true, hasVariants: false, priceDisplay: "exact" }] };
  assert.equal(storedCatalogDto(JSON.stringify(outcome)), null);
  const snapshot = buildCatalogSnapshot(outcome, { constrained: false }, { warehouseId: warehouse }, null, "en");
  assert.deepEqual(storedCatalogDto(JSON.stringify(snapshot)), snapshot);
  assert.equal(snapshot.version, 1); assert.equal(snapshot.subjectId, null); assert.equal(snapshot.products[0].id, product);
});
test("connection and driver reads refuse foreign handles and nested aggregate writes", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype;
  t.mock.method(p, "aggregate", () => ({ next: async () => ({ n: 1 }), close: async () => {} }));
  installCombinedNativeGuard(t, f.connection, f.p);
  const owned = collection(f, "products");
  assert.equal(await p.countDocuments.call(owned, {}), 1, "installed driver counting delegation remains supported");
  assert.throws(() => p.aggregate.call(owned, [{ $lookup: { from: "petyard.products", pipeline: [] } }]));
  assert.throws(() => p.aggregate.call(owned, [{ $facet: { result: [{ $out: "orders" }] } }]));
  p.aggregate.call(owned, [{ $lookup: { from: "assistantcartproposals", pipeline: [{ $match: {} }] } }]);
  const scope = combinedNativeConnection(f.connection, f.p); f.connection.name = "petyard"; assert.throws(scope.check);
});
test("mutations tag owned rows, retain exact identity, cap attempts and refuse undeclared operations", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne", "findOneAndUpdate", "createIndex"]) t.mock.method(p, method, (...args) => { calls.push(args); return "offline"; });
  const counters = installCombinedNativeGuard(t, f.connection, f.p), accounts = collection(f, "assistantaccounts"), admin = collection(f, "assistantadminchats");
  const owner = new mongoose.Types.ObjectId();
  p.findOneAndUpdate.call(admin, { owner }, { $setOnInsert: { owner } }, { upsert: true });
  assert.equal(calls.at(-1)[0].fixtureRun, f.p.run); assert.equal(calls.at(-1)[1].$setOnInsert.fixtureRun, f.p.run);
  assert.throws(() => p.updateOne.call(accounts, {}, { $set: { blocked: true } }));
  assert.throws(() => p.updateOne.call(accounts, { owner }, { $set: { fixtureRun: "changed" } }));
  p.updateOne.call(accounts, { _id: owner, fixtureRun: { $eq: f.p.run, $exists: true } }, { $inc: { __v: 1 } });
  assert.equal(calls.at(-1)[0].fixtureRun, f.p.run);
  assert.throws(() => p.updateOne.call(accounts, { _id: owner, fixtureRun: { $ne: "foreign" } }, { $inc: { __v: 1 } }));
  assert.throws(() => p.insertOne.call(collection(f, "payments"), { _id: owner }));
  for (const method of ["bulkWrite", "insertMany", "deleteMany", "replaceOne", "createSearchIndex", "createSearchIndexes", "updateSearchIndex", "dropSearchIndex"])
    assert.throws(() => p[method].call(accounts, []));
  p.createIndex.call(collection(f, "carts"), { user: 1 }, { unique: true });
  assert.throws(() => p.createIndex.call(collection(f, "products"), { arbitrary: 1 }));
  while (counters.insertAttempts() < f.p.maxInsertAttempts) p.insertOne.call(accounts, { _id: new mongoose.Types.ObjectId(), owner });
  assert.throws(() => p.insertOne.call(accounts, { _id: owner }));
});
test("administrative entry permits only pinned topology hello and keeps raw database commands blocked", async t => {
  const f = fixture(), p = mongoose.mongo.Admin.prototype, calls = [];
  t.mock.method(p, "command", async value => { calls.push(value); return { setName: "offline" }; });
  installCombinedNativeGuard(t, f.connection, f.p);
  const admin = new mongoose.mongo.Admin({ client: f.client, databaseName: f.p.database });
  assert.deepEqual(await admin.command({ hello: 1 }), { setName: "offline" });
  await assert.rejects(async () => admin.command({ dropDatabase: 1 }));
  await assert.rejects(async () => new mongoose.mongo.Admin({ client: f.client, databaseName: "petyard" }).command({ hello: 1 }));
  assert.equal(calls.length, 1);
  assert.throws(() => mongoose.mongo.Db.prototype.command.call({}, { hello: 1 }));
});
test("default native invocation skips before private input, database or provider work", () => {
  const env = { ...process.env, ASSISTANT_COMBINED_NATIVE_TEST: "not-authorized", ASSISTANT_COMBINED_NATIVE_URI: "must-not-read", ASSISTANT_COMBINED_NATIVE_PLAN: "must-not-read" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--test", "test/domains/assistant/combined.native.mongo.test.js"], { env, encoding: "utf8", timeout: 20000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /# skipped 1\b/); assert.match(child.stdout, /# fail 0\b/);
});
test("prepared launcher verifies pins without a connection, credential read or consumed claim", async t => {
  try { await access(directory + "preparation.json"); } catch (error) { if (error.code === "ENOENT") { t.skip("Pins not prepared yet"); return; } throw error; }
  const child = spawnSync(process.execPath, [directory + "run.mjs", "--check"], { encoding: "utf8", timeout: 20000, windowsHide: true,
    env: { ...process.env, OPENAI_API_KEY: "must-not-read", MONGO_URI: "must-not-read" }, input: "must-not-read\n" });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /no connection, credentials, claim or writes/);
  await assert.rejects(access(directory + "approved-claim.json"), { code: "ENOENT" });
});
