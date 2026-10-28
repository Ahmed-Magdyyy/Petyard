import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { bookingNativeOptIn, bookingNativeCollections, validateBookingNativePlan, bookingNativeConnection, bookingNativeMarker,
  claimBookingNativeDatabase, inspectBookingNativeDatabase, cleanupBookingNativeDatabase, verifyBookingNativeDatabaseEmpty,
  installBookingNativeWriteGuard } from "./fixtures/bookingNativeTarget.js";

const plan = () => ({ host: "magdy.pbupj.mongodb.net", database: "ai_test_native_111111111111", run: "11111111-1111-1111-1111-111111111111",
  collections: [...bookingNativeCollections], maxDocuments: 96, optIn: bookingNativeOptIn });
function fixture() {
  const p = plan(), s = { p, collections: {}, calls: [], drops: [] };
  const db = { databaseName: p.database, listCollections: () => ({ toArray: async () => Object.keys(s.collections).map(name => ({ name })) }),
    async createCollection(name) { s.calls.push("create"); s.collections[name] = []; },
    collection(name) { return { async findOne() { return s.collections[name]?.[0] ?? null; }, async countDocuments(filter) {
      const rows = s.collections[name] ?? []; return filter.fixtureRun ? rows.filter(row => row.fixtureRun !== filter.fixtureRun.$ne).length : rows.length;
    },
      async insertOne(row) { s.calls.push("insert"); s.collections[name].push(row); } }; },
    async dropCollection(name) { s.drops.push(name); if (s.deny === name) throw Error("drop denied"); delete s.collections[name]; } };
  const client = { options: { srvHost: p.host, dbName: "petyard" } };
  s.connection = { readyState: 1, name: p.database, db, getClient: () => client }; return s;
}
test("plan validation refuses the application database, other hosts, oversized names, changed collections and broader budgets", () => {
  validateBookingNativePlan(plan());
  for (const change of [{ database: "petyard" }, { database: "ai_test_" + "x".repeat(30) + "_111111111111" },
    { host: "other.mongodb.net" }, { maxDocuments: 97 }, { collections: [...bookingNativeCollections, "carts"] }, { optIn: "other" }]) {
    assert.throws(() => validateBookingNativePlan({ ...plan(), ...change }));
  }
});
test("connection fence detects identity, client, database and host changes", () => {
  for (const mode of ["name", "database", "host", "client-default", "client", "handle", "state"]) {
    const s = fixture(), scope = bookingNativeConnection(s.connection, s.p);
    if (mode === "name") s.connection.name = "petyard";
    if (mode === "database") s.connection.db.databaseName = "petyard";
    if (mode === "host") s.connection.getClient().options.srvHost = "other";
    if (mode === "client-default") s.connection.getClient().options.dbName = "unapproved";
    if (mode === "client") s.connection.getClient = () => ({});
    if (mode === "handle") s.connection.db = { ...s.connection.db };
    if (mode === "state") s.connection.readyState = 0;
    assert.throws(scope.check);
  }
});
test("only a fresh empty database can be claimed with the exact ownership marker", async () => {
  const s = fixture(); await claimBookingNativeDatabase(s.connection, s.p);
  assert.deepEqual(s.collections.assistanttestownership, [bookingNativeMarker(s.p)]); assert.deepEqual(s.calls, ["create", "insert"]);
  await assert.rejects(claimBookingNativeDatabase(s.connection, s.p), /must be empty/); assert.equal(s.calls.length, 2);
});
test("cleanup drops only declared collections and removes the marker last", async () => {
  const s = fixture(); await claimBookingNativeDatabase(s.connection, s.p); s.collections.users = [{ _id: 1, fixtureRun: s.p.run }]; s.collections.assistantbookingreceipts = [];
  assert.equal((await inspectBookingNativeDatabase(s.connection, s.p)).documents, 2);
  const result = await cleanupBookingNativeDatabase(s.connection, s.p);
  assert.equal(result.droppedOwnedCollections, 3); assert.equal(s.drops.at(-1), "assistanttestownership");
  assert.equal((await verifyBookingNativeDatabaseEmpty(s.connection, s.p)).collectionsRemaining, 0);
});
test("missing/wrong ownership, unknown collections and exceeded document bounds prevent all cleanup", async () => {
  for (const mode of ["missing", "wrong", "unknown", "count", "foreign", "extra-marker"]) {
    const s = fixture(); await claimBookingNativeDatabase(s.connection, s.p);
    if (mode === "missing") s.collections.assistanttestownership = [];
    if (mode === "wrong") s.collections.assistanttestownership[0].run = "other";
    if (mode === "unknown") s.collections.foreign = [];
    if (mode === "count") s.collections.users = Array(96).fill({ _id: "fixture", fixtureRun: s.p.run });
    if (mode === "foreign") s.collections.users = [{ _id: "foreign" }];
    if (mode === "extra-marker") s.collections.assistanttestownership.push({ _id: "foreign" });
    await assert.rejects(cleanupBookingNativeDatabase(s.connection, s.p)); assert.equal(s.drops.length, 0);
  }
});
test("drop denial retains ownership and fresh verification detects remaining collections", async () => {
  const s = fixture(); await claimBookingNativeDatabase(s.connection, s.p); s.collections.users = []; s.deny = "users";
  await assert.rejects(cleanupBookingNativeDatabase(s.connection, s.p), /drop denied/);
  assert.ok(s.collections.assistanttestownership); await assert.rejects(verifyBookingNativeDatabaseEmpty(s.connection, s.p));
});
test("native write guard enforces database scope, insert attempt budget and rejects unbudgeted or destructive operations", t => {
  const s = fixture(), prototype = mongoose.mongo.Collection.prototype; let called = 0;
  const methods = ["insertOne", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "createIndex", "createIndexes"];
  const restorers = [], guardContext = { mock: { method(target, name, implementation) {
    const original = target[name]; restorers.push(() => { target[name] = original; }); target[name] = implementation;
  } } };
  // These methods are replaced twice; unwind both layers in reverse order.
  t.after(() => { while (restorers.length) restorers.pop()(); });
  for (const method of methods) guardContext.mock.method(prototype, method, row => {
    called++; if (method === "insertOne") assert.equal(row.fixtureRun, s.p.run);
    if (method === "insertMany") assert.ok(row.every(item => item.fixtureRun === s.p.run)); return "native";
  });
  const guard = installBookingNativeWriteGuard(guardContext, s.connection, s.p), owned = { client: s.connection.getClient(), dbName: s.p.database, collectionName: "users" };
  assert.throws(() => prototype.insertOne.call(owned, { fixtureRun: "other" }), /Foreign insert marker/);
  assert.equal(prototype.insertOne.call(owned, {}), "native");
  assert.equal(prototype.insertMany.call(owned, Array(94).fill({})), "native"); assert.equal(guard.insertAttempts(), 96);
  assert.throws(() => prototype.insertOne.call(owned, {}), /bound exceeded/);
  assert.throws(() => prototype.updateOne.call({ ...owned, dbName: "petyard" }, {}, {}));
  assert.throws(() => prototype.updateOne.call(owned, {}, {}, { upsert: true }), /upsert refused/);
  assert.throws(() => prototype.createIndex.call({ ...owned, dbName: "petyard" }, { x: 1 }));
  assert.throws(() => prototype.createIndex.call({ ...owned, client: {} }, { x: 1 }));
  for (const method of ["bulkWrite", "deleteMany", "rename", "drop"]) assert.throws(() => prototype[method].call(owned), /Unapproved/);
  assert.equal(called, 2);
});

test("installed driver insertMany can delegate only its already guarded documents without another insert charge", async t => {
  const p = plan(), client = new mongoose.mongo.MongoClient(`mongodb+srv://${p.host}/petyard`), db = client.db(p.database);
  client.topology = {}; // Only the bulk executor is stubbed; no driver connect or wire operation is permitted.
  t.mock.method(client, "connect", () => { throw Error("Unexpected network connection"); });
  const operations = [], prototype = mongoose.mongo.Collection.prototype;
  const bulk = () => ({ raw(operation) { operations.push(operation); }, async execute() {
    return { insertedCount: operations.length, insertedIds: Object.fromEntries(operations.map((operation, index) => [index, operation.insertOne.document._id])) };
  } });
  t.mock.method(prototype, "initializeOrderedBulkOp", bulk); t.mock.method(prototype, "initializeUnorderedBulkOp", bulk);
  const connection = { readyState: 1, name: p.database, db, getClient: () => client };
  const guard = installBookingNativeWriteGuard(t, connection, p), owned = db.collection("users");
  const result = await owned.insertMany([{ _id: 1 }, { _id: 2 }], { ordered: true });
  assert.equal(result.insertedCount, 2); assert.equal(guard.insertAttempts(), 3);
  assert.ok(operations.every(operation => operation.insertOne.document.fixtureRun === p.run));
  assert.throws(() => owned.bulkWrite([{ insertOne: { document: { _id: 3 } } }]), /Unapproved/);
  assert.throws(() => owned.bulkWrite([{ deleteMany: { filter: {} } }]), /Unapproved/);
  assert.throws(() => client.db("petyard").collection("users").insertMany([{ _id: 4 }]));
});
