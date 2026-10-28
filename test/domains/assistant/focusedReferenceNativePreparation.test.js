import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mongoose from "mongoose";
import { focusedReferenceNativeCollections, focusedReferenceNativeOptIn, validateFocusedReferenceNativePlan, focusedReferenceNativeConnection,
  focusedReferenceNativeMarker, claimFocusedReferenceNativeDatabase, cleanupFocusedReferenceNativeDatabase, verifyFocusedReferenceNativeEmpty,
  installFocusedReferenceNativeGuard } from "./fixtures/focusedReferenceNative.js";

const index = { key: { key: 1 }, name: "key_1", unique: true, expireAfterSeconds: null };
function plan() {
  return { host: "magdy.pbupj.mongodb.net", database: "ai_test_embedding_111111111111", run: "11111111-1111-1111-1111-111111111111",
    optIn: focusedReferenceNativeOptIn, collections: [...focusedReferenceNativeCollections], maxInsertAttempts: 384, caseCount: 8,
    indexes: Object.fromEntries(focusedReferenceNativeCollections.filter(name => !["users", "pets", "assistanttestownership"].includes(name))
      .map(name => [name, name === "assistantembeddingbatches" ? [index] : []])) };
}
function fixture() {
  const p = plan(), f = { plan: p, stores: {}, drops: [] };
  const db = { databaseName: p.database, listCollections() { return { async toArray() { return Object.keys(f.stores).map(name => ({ name })); } }; },
    async createCollection(name) { f.stores[name] = []; }, collection(name) { return {
      async insertOne(row) { f.stores[name].push(row); }, async findOne() { return f.stores[name]?.[0] ?? null; },
      async countDocuments(filter = {}) { const rows = f.stores[name] ?? []; return filter.fixtureRun ? rows.filter(row => row.fixtureRun !== filter.fixtureRun.$ne).length : rows.length; },
    }; }, async dropCollection(name) { if (f.denied === name) throw Error("Fictional cleanup denial"); f.drops.push(name); delete f.stores[name]; await f.afterDrop?.(name); } };
  const client = { options: { srvHost: p.host, dbName: "petyard" } };
  f.connection = { readyState: 1, name: p.database, db, getClient: () => client };
  return f;
}

test("native plan rejects application targets, altered collection/index scope and larger attempt limits", () => {
  validateFocusedReferenceNativePlan(plan());
  for (const change of [{ database: "petyard" }, { host: "other.mongodb.net" }, { collections: [...focusedReferenceNativeCollections, "orders"] },
    { maxInsertAttempts: 385 }, { caseCount: 9 }, { optIn: "other" }, { run: "bad" }, { indexes: {} }]) assert.throws(() => validateFocusedReferenceNativePlan({ ...plan(), ...change }));
});

test("every connection fence detects changes to client, selected database, handle and topology target", () => {
  for (const mode of ["name", "database", "client", "host", "default", "handle", "state"]) {
    const f = fixture(), scope = focusedReferenceNativeConnection(f.connection, f.plan);
    if (mode === "name") f.connection.name = "petyard";
    if (mode === "database") f.connection.db.databaseName = "petyard";
    if (mode === "client") f.connection.getClient = () => ({});
    if (mode === "host") f.connection.getClient().options.srvHost = "other.mongodb.net";
    if (mode === "default") f.connection.getClient().options.dbName = "other";
    if (mode === "handle") f.connection.db = { ...f.connection.db };
    if (mode === "state") f.connection.readyState = 0;
    assert.throws(scope.check);
  }
});

test("ownership is exclusive and cleanup removes only owned collections with the marker last", async () => {
  const f = fixture(); await claimFocusedReferenceNativeDatabase(f.connection, f.plan);
  assert.deepEqual(f.stores.assistanttestownership, [focusedReferenceNativeMarker(f.plan)]);
  await assert.rejects(claimFocusedReferenceNativeDatabase(f.connection, f.plan));
  f.stores.assistantembeddingbatches = [{ _id: 1, fixtureRun: f.plan.run }]; f.stores.users = [];
  assert.equal((await cleanupFocusedReferenceNativeDatabase(f.connection, f.plan)).droppedOwnedCollections, 3);
  assert.equal(f.drops.at(-1), "assistanttestownership"); assert.equal((await verifyFocusedReferenceNativeEmpty(f.connection, f.plan)).collectionsRemaining, 0);
});

test("foreign data, extra namespaces, marker changes and over-budget records stop all drops", async () => {
  for (const mode of ["foreign", "unknown", "marker", "extra-marker", "over-budget"]) {
    const f = fixture(); await claimFocusedReferenceNativeDatabase(f.connection, f.plan);
    if (mode === "foreign") f.stores.users = [{ _id: 1 }];
    if (mode === "unknown") f.stores.orders = [];
    if (mode === "marker") f.stores.assistanttestownership[0].run = "different";
    if (mode === "extra-marker") f.stores.assistanttestownership.push({ _id: "other" });
    if (mode === "over-budget") f.stores.users = Array(384).fill({ fixtureRun: f.plan.run });
    await assert.rejects(cleanupFocusedReferenceNativeDatabase(f.connection, f.plan)); assert.deepEqual(f.drops, []);
  }
  const f = fixture(); await claimFocusedReferenceNativeDatabase(f.connection, f.plan); f.stores.users = []; f.denied = "users";
  await assert.rejects(cleanupFocusedReferenceNativeDatabase(f.connection, f.plan)); assert.ok(f.stores.assistanttestownership);
});

test("ownership changed during cleanup stops before another collection can be dropped", async () => {
  const f = fixture(); await claimFocusedReferenceNativeDatabase(f.connection, f.plan);
  f.stores.assistantembeddingbatches = []; f.stores.users = [];
  f.afterDrop = () => { f.stores.assistanttestownership[0].run = "different"; };
  await assert.rejects(cleanupFocusedReferenceNativeDatabase(f.connection, f.plan));
  assert.equal(f.drops.length, 1); assert.ok(f.stores.assistanttestownership); assert.ok(f.stores.users);
});

test("driver writes are exact owned records, only budget upserts are allowed, and every attempt counts", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne", "findOneAndUpdate", "findOne"]) t.mock.method(p, method, (...args) => { calls.push(args); return "native"; });
  const guard = installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantbudgets" };
  assert.equal(p.insertOne.call(owned, { _id: "control" }), "native"); assert.equal(calls.at(-1)[0].fixtureRun, f.plan.run);
  assert.equal(p.updateOne.call(owned, { _id: "global:fictional" }, { $setOnInsert: { spent: 0 } }, { upsert: true }), "native");
  assert.equal(calls.at(-1)[1].$setOnInsert.fixtureRun, f.plan.run); assert.equal(guard.insertAttempts(), 3);
  for (const value of [{ ...owned, dbName: "petyard" }, { ...owned, client: {} }, { ...owned, collectionName: "orders" }]) {
    assert.throws(() => p.insertOne.call(value, { _id: 1 })); assert.throws(() => p.findOne.call(value, {}));
  }
  for (const [filter, update] of [[{}, { $set: { spent: 1 } }], [{ _id: { $gt: 0 } }, { $set: { spent: 1 } }],
    [{ _id: "control" }, { $unset: { fixtureRun: 1 } }], [{ _id: "control" }, { $set: { fixtureRun: "other" } }],
    [{ _id: "control" }, [{ $set: { spent: 1 } }]]]) assert.throws(() => p.updateOne.call(owned, filter, update));
  assert.throws(() => p.updateOne.call({ ...owned, collectionName: "users" }, { _id: new mongoose.Types.ObjectId() }, { $set: { role: "admin" } }, { upsert: true }));
  while (guard.insertAttempts() < 384) p.insertOne.call(owned, { _id: new mongoose.Types.ObjectId() });
  assert.throws(() => p.insertOne.call(owned, { _id: 1 }), /budget exceeded/);
});

test("only the narrow query-vector redaction is a permitted multi-record update", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  t.mock.method(p, "updateMany", (...args) => { calls.push(args); return "native"; }); installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantembeddingbatches" };
  const filter = { kind: "customer_query", vectorsExpireAt: { $lte: new Date() }, vectors: { $exists: true } };
  assert.equal(p.updateMany.call(owned, filter, { $unset: { vectors: 1 } }), "native"); assert.equal(calls[0][0].fixtureRun, f.plan.run);
  for (const [query, update, options] of [[{}, { $unset: { vectors: 1 } }, {}], [{ ...filter, kind: "reference" }, { $unset: { vectors: 1 } }, {}],
    [filter, { $unset: { reservation: 1 } }, {}], [filter, { $unset: { vectors: 1 }, $set: { accounting: "settled" } }, {}],
    [filter, { $unset: { vectors: 1 } }, { upsert: true }]]) assert.throws(() => p.updateMany.call(owned, query, update, options));
  assert.throws(() => p.updateMany.call({ ...owned, collectionName: "assistantbudgets" }, filter, { $unset: { vectors: 1 } }));
});

test("native customer state permits only exact-owner account/chat upserts, never broad or foreign-owner writes", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["findOneAndUpdate", "updateOne"]) t.mock.method(p, method, (...args) => { calls.push(args); return "native"; });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const owner = new mongoose.Types.ObjectId();
  for (const name of ["assistantaccounts", "assistantchats"]) {
    const scoped = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: name };
    assert.equal(p.findOneAndUpdate.call(scoped, { owner }, { $setOnInsert: { owner } }, { upsert: true }), "native");
    assert.equal(calls.at(-1)[0].fixtureRun, f.plan.run); assert.equal(calls.at(-1)[1].$setOnInsert.fixtureRun, f.plan.run);
    for (const filter of [{}, { owner: { $ne: owner } }, { owner: String(owner) }])
      assert.throws(() => p.findOneAndUpdate.call(scoped, filter, { $set: { activeRun: null } }, { upsert: true }));
    assert.throws(() => p.updateOne.call({ ...scoped, dbName: "petyard" }, { owner }, { $set: { activeRun: null } }));
  }
  assert.throws(() => p.findOneAndUpdate.call({ client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantreferences" },
    { owner }, { $set: { status: "disabled" } }, { upsert: true }));
});

test("real installed Mongoose receipt create/save and timestamped redaction pass the guarded driver offline", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne", "updateMany"]) t.mock.method(p, method, async (...args) => {
    calls.push({ method, args }); return { acknowledged: true, insertedId: args[0]._id, matchedCount: 1, modifiedCount: 1 };
  });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const { AssistantEmbeddingBatch } = await import("../../../src/domains/assistant/references/assistant.embedding-batch.model.js");
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantembeddingbatches" };
  for (const method of ["insertOne", "updateOne", "updateMany"]) t.mock.method(AssistantEmbeddingBatch.collection, method, (...args) => p[method].call(owned, ...args));
  const [row] = await AssistantEmbeddingBatch.create([{ key: "a".repeat(64), kind: "customer_query", owner: new mongoose.Types.ObjectId(), run: new mongoose.Types.ObjectId(),
    queryContextHash: "b".repeat(64), batchHash: "c".repeat(64), vectorsExpireAt: new Date(), model: "text-embedding-3-small", dimensions: 1536,
    config: {}, reservation: {}, status: "uncertain", accounting: "reserved" }]);
  assert.equal(calls[0].method, "insertOne"); assert.equal(calls[0].args[0].fixtureRun, f.plan.run);
  row.accounting = "charged_reservation"; row.status = "failed";
  row.reconciliation = { resolution: "charge_reserved", reason: "Fictional offline guard check", actor: new mongoose.Types.ObjectId(), at: new Date() };
  await row.save(); assert.equal(calls[1].method, "updateOne"); assert.equal(calls[1].args[0].fixtureRun, f.plan.run);
  const { scrubExpiredQueryVectors } = await import("../../../src/domains/assistant/customer/assistant.query-embedding.js");
  await scrubExpiredQueryVectors(); assert.equal(calls[2].method, "updateMany"); assert.ok(calls[2].args[1].$set.updatedAt instanceof Date);
});

test("real installed Mongoose chat-attempt append uses the exact guarded run-save shape", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne"]) t.mock.method(p, method, async (...args) => {
    calls.push({ method, args }); return { acknowledged: true, insertedId: args[0]._id, matchedCount: 1, modifiedCount: 1 };
  });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const { AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { beginAttempt } = await import("../../../src/domains/assistant/shared/assistant.attempts.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantruns" };
  for (const method of ["insertOne", "updateOne"]) t.mock.method(AssistantRun.collection, method, (...args) => p[method].call(owned, ...args));
  const [run] = await AssistantRun.create([{ owner: new mongoose.Types.ObjectId(), chat: new mongoose.Types.ObjectId(), key: "fictional-offline-key",
    hash: "fictional-offline-hash", status: "queued", phase: "resolve", input: "Fictional general question", userSequence: 1, contextVersion: 0, config: testConfig() }]);
  beginAttempt(run, { amount: 1000, budgetIds: ["fictional-month", "fictional-day"] }); await run.save();
  const [filter, update] = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "updateOne"); assert.equal(filter.fixtureRun, f.plan.run);
  assert.equal(update.$push.attempts.$each.length, 1); assert.equal(update.$push.attempts.$each[0].phase, "resolve");
  assert.throws(() => p.updateOne.call(owned, { _id: run._id }, { $push: { attempts: { $each: [] } } }));
  assert.throws(() => p.updateOne.call({ ...owned, collectionName: "assistantreferences" }, { _id: run._id }, update));
});

test("real installed Mongoose queued customer fence retains the exact purpose conjunction and run identity", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  t.mock.method(p, "updateOne", async (...args) => { calls.push(args); return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }; });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const { AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { queuedWorkFilter } = await import("../../../src/domains/assistant/shared/assistant.attempts.js");
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantruns" };
  t.mock.method(AssistantRun.collection, "updateOne", (...args) => p.updateOne.call(owned, ...args));
  const id = new mongoose.Types.ObjectId(), filter = queuedWorkFilter(id, { phase: "answer", generation: 2, contextVersion: 1, referenceFlowVersion: "focused-v1" });
  await AssistantRun.updateOne(filter, { $inc: { queryEmbeddingFence: 1 } });
  assert.deepEqual(calls[0][0].$and, filter.$and); assert.equal(calls[0][0].fixtureRun, f.plan.run);
  assert.equal(calls[0][1].$inc.queryEmbeddingFence, 1);
  for (const invalid of [{ $and: [{ ...filter.$and[0], _id: { $ne: id } }, filter.$and[1]] },
    { $and: [{ _id: id }, filter.$and[1]] },
    ...[{ status: "completed" }, { phase: "resolve" }, { generation: 1 }, { contextVersion: 0 }, { referenceFlowVersion: "other" }].map(change =>
      ({ $and: [{ ...filter.$and[0], ...change }, filter.$and[1]] })),
    { $and: [filter.$and[0], { $or: [{ purpose: "admin_business" }] }] }, { $and: filter.$and, $or: [{ status: "queued" }] }])
    assert.throws(() => p.updateOne.call(owned, invalid, { $inc: { queryEmbeddingFence: 1 } }));
  assert.throws(() => p.updateOne.call({ ...owned, collectionName: "assistantreferences" }, filter, { $inc: { retrievalFence: 1 } }));
});

test("normal schema indexes are pinned and Search, bulk, raw command and whole-database operations are refused", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, d = mongoose.mongo.Db.prototype;
  t.mock.method(p, "createIndex", () => "native"); t.mock.method(p, "aggregate", () => "native");
  for (const method of ["createCollection", "dropCollection"]) t.mock.method(d, method, () => "native");
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantembeddingbatches" };
  assert.equal(p.createIndex.call(owned, { key: 1 }, { unique: true }), "native");
  assert.throws(() => p.createIndex.call(owned, { other: 1 }, {})); assert.throws(() => p.createIndex.call(owned, { key: 1 }, { unique: true, sparse: true }));
  for (const stage of ["$out", "$merge", "$lookup", "$unionWith", "$vectorSearch", "$search", "$listSearchIndexes"]) assert.throws(() => p.aggregate.call(owned, [{ [stage]: {} }]));
  for (const method of ["insertMany", "bulkWrite", "deleteMany", "rename", "createSearchIndex", "dropSearchIndex"]) if (typeof p[method] === "function") assert.throws(() => p[method].call(owned));
  const db = { client: f.connection.getClient(), databaseName: f.plan.database };
  assert.equal(d.createCollection.call(db, "users"), "native"); assert.throws(() => d.createCollection.call(db, "orders"));
  assert.throws(() => d.dropDatabase.call(db)); assert.throws(() => d.command.call(db, { dropDatabase: 1 }));
});

test("prepared launcher check is offline and does not consume a claim", async t => {
  const directory = ".scratch/assistant-retrieval/focused-native/"; let before, proof;
  try { before = await readdir(directory); proof = JSON.parse(await readFile(directory + "preparation.json", "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; t.skip("Local approval artifacts are absent from a clean checkout"); return; }
  assert.equal(proof.executed, false);
  const check = () => promisify(execFile)(process.execPath, [directory + "run.mjs", "--check"], { windowsHide: true });
  if (before.includes("approved-claim.json")) await assert.rejects(check(), error => error.code === 1 && /Prepared file changed:/.test(error.stderr));
  else { const { stdout } = await check(); assert.match(stdout, /no connection, credentials, claim or writes/); }
  assert.deepEqual(await readdir(directory), before);
});

test("all three real Mongoose attempt saves and their settlements pass the scoped driver", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne"]) t.mock.method(p, method, async (...args) => {
    calls.push({ method, args }); return { acknowledged: true, insertedId: args[0]._id, matchedCount: 1, modifiedCount: 1 };
  });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const { AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { beginAttempt, recordAttempt, queueAnswer } = await import("../../../src/domains/assistant/shared/assistant.attempts.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantruns" };
  for (const method of ["insertOne", "updateOne"]) t.mock.method(AssistantRun.collection, method, (...args) => p[method].call(owned, ...args));
  const run = new AssistantRun({ owner: new mongoose.Types.ObjectId(), chat: new mongoose.Types.ObjectId(), key: "focused-offline",
    hash: "focused-hash", purpose: "customer", referenceFlowVersion: "focused-v1", status: "queued", phase: "resolve", contextVersion: 1,
    input: "Fictional question", userSequence: 1, config: testConfig() });
  await run.save();
  for (const phase of ["resolve", "normalize", "answer"]) {
    assert.equal(run.phase, phase); beginAttempt(run, { amount: 1000, budgetIds: ["fictional-month", "fictional-day"] });
    run.status = "dispatching"; await run.save(); run.accounting = "settled"; run.chargedMicroUsd = 198; recordAttempt(run); await run.save();
    if (phase !== "answer") { queueAnswer(run, phase === "resolve" ? "normalize" : "answer"); await run.save(); }
  }
  const appends = calls.filter(c => c.args[1]?.$push?.attempts).map(c => c.args[1].$push.attempts.$each[0]);
  assert.deepEqual(appends.map(a => [a.number, a.phase]), [[1, "resolve"], [2, "normalize"], [3, "answer"]]);
  const illegal = { ...appends[2], number: 4 };
  assert.throws(() => p.updateOne.call(owned, { _id: run._id }, { $push: { attempts: { $each: [illegal] } } }));
});

test("real recovery memory redaction is timestamp-safe and cannot broaden into arbitrary bulk changes", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  t.mock.method(p, "updateMany", async (...args) => { calls.push(args); return { acknowledged: true, modifiedCount: 0 }; });
  installFocusedReferenceNativeGuard(t, f.connection, f.plan);
  const { AssistantMemory } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantmemories" };
  t.mock.method(AssistantMemory.collection, "updateMany", (...args) => p.updateMany.call(owned, ...args));
  const filter = { state: "active", validUntil: { $lte: new Date() } };
  const update = { $set: { state: "forgotten" }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 }, $inc: { version: 1 } };
  await AssistantMemory.updateMany(filter, update); assert.equal(calls[0][0].fixtureRun, f.plan.run);
  for (const [query, change] of [[{}, update], [{ ...filter, state: "forgotten" }, update],
    [{ ...filter, validUntil: { $lte: new Date("invalid") } }, update], [filter, { ...update, $inc: { version: 2 } }],
    [filter, { ...update, $set: { state: "forgotten", value: "REINTRODUCED" } }]]) {
    assert.throws(() => p.updateMany.call(owned, query, change));
  }
});

test("the eight native fixtures use valid real admission inputs and one explicit owned pet", async () => {
  const source = await readFile("test/domains/assistant/focusedReference.native.mongo.test.js", "utf8");
  const labels = [...source.matchAll(/fixture\("([a-z_]+)"/g)].map(m => m[1]); assert.equal(new Set(labels).size, 8);
  assert.ok(source.includes('key = `${plan.run}:${label}`'));
  const { submission } = await import("../../../src/domains/assistant/shared/assistant.validation.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  for (const label of labels) {
    const input = submission({ text: `Fictional ${label}`, subjectId: `pet:${new mongoose.Types.ObjectId()}` },
      `11111111-1111-1111-1111-111111111111:${label}`, testConfig({ queueTimeoutMs: 600000 }));
    assert.ok(input.subjectId.startsWith("pet:"));
  }
});
