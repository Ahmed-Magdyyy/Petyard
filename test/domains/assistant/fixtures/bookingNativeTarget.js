import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "./mongoTarget.js";

export const bookingNativeOptIn = "one-owned-isolated-booking-native-run";
export const bookingNativeCollections = Object.freeze(["assistanttestownership", "users", "pets", "warehouses", "servicecatalogs", "servicelocations",
  "servicereservations", "serviceslotinventories", "assistantbookingproposals", "assistantbookingreceipts", "notificationoutboxes",
  "assistantaccounts", "assistantchats", "assistantmessages", "assistantruns", "assistantmemories", "assistantdietarywarnings", "assistantbudgets", "assistantevents"]);
export function validateBookingNativePlan(plan) {
  assert.equal(plan?.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.deepEqual(plan.collections, [...bookingNativeCollections]); assert.equal(plan.maxDocuments, 96);
  assert.equal(plan.optIn, bookingNativeOptIn); return plan;
}
export function bookingNativeConnection(connection, plan) {
  validateBookingNativePlan(plan); const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database);
    assert.equal(connection.db, db); assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    // Mongoose selects client.db(plan.database) but keeps the validated URI database as the client's default.
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, client, check };
}
export const bookingNativeMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: bookingNativeOptIn });
export async function claimBookingNativeDatabase(connection, plan) {
  const { db, check } = bookingNativeConnection(connection, plan);
  const collections = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(collections, [], "Temporary test database must be empty before ownership claim");
  await db.createCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  await db.collection("assistanttestownership").insertOne(bookingNativeMarker(plan), { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); check();
}
export async function inspectBookingNativeDatabase(connection, plan) {
  const { db, check } = bookingNativeConnection(connection, plan);
  const marker = await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }); check();
  assert.deepEqual(marker, bookingNativeMarker(plan), "Temporary database ownership marker mismatch");
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1,
    "Unexpected ownership record blocks native run and cleanup"); check();
  const collections = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.ok(collections.every(row => plan.collections.includes(row.name)), "Unexpected collection blocks native run and cleanup");
  let documents = 0;
  for (const row of collections) {
    if (row.name !== "assistanttestownership") {
      assert.equal(await db.collection(row.name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0,
        "Foreign document blocks native run and cleanup"); check();
    }
    documents += await db.collection(row.name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }); check();
  }
  assert.ok(Number.isSafeInteger(documents) && documents >= 1 && documents <= plan.maxDocuments, "Temporary document bound exceeded");
  return { collectionNames: collections.map(row => row.name).sort(), documents };
}
export async function cleanupBookingNativeDatabase(connection, plan) {
  const { db, check } = bookingNativeConnection(connection, plan), snapshot = await inspectBookingNativeDatabase(connection, plan);
  for (const name of snapshot.collectionNames.filter(name => name !== "assistanttestownership")) {
    check(); assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0,
      "Foreign document appeared before cleanup");
    check(); await db.dropCollection(name, { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  }
  const remaining = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(remaining.map(row => row.name), ["assistanttestownership"], "Unexpected collection appeared during cleanup");
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), bookingNativeMarker(plan)); check();
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
  await db.dropCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  return { droppedOwnedCollections: snapshot.collectionNames.length, fixtureDocumentsBeforeCleanup: snapshot.documents };
}
export async function verifyBookingNativeDatabaseEmpty(connection, plan) {
  const { db, check } = bookingNativeConnection(connection, plan);
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(rows, [], "Temporary collections remain after cleanup"); return { collectionsRemaining: 0, database: plan.database };
}

export function installBookingNativeWriteGuard(t, connection, plan) {
  const { check, client } = bookingNativeConnection(connection, plan); let insertAttempts = 1; // Ownership marker was inserted first.
  const collection = value => { check(); assert.equal(value.client, client); assert.equal(value.dbName, plan.database); assert.ok(plan.collections.includes(value.collectionName)); };
  const prototype = mongoose.mongo.Collection.prototype, pendingBulk = new WeakMap();
  for (const [method, count] of [["insertOne", () => 1], ["insertMany", rows => { assert.ok(Array.isArray(rows)); return rows.length; }]]) {
    const original = prototype[method];
    t.mock.method(prototype, method, function (...args) {
      collection(this); const requested = count(args[0]);
      assert.ok(Number.isSafeInteger(requested) && requested >= 1 && insertAttempts + requested <= plan.maxDocuments, "Native insert-attempt bound exceeded");
      const own = row => { assert.ok(row && typeof row === "object" && !Array.isArray(row));
        assert.ok(row.fixtureRun === undefined || row.fixtureRun === plan.run, "Foreign insert marker refused"); return { ...row, fixtureRun: plan.run }; };
      args[0] = method === "insertOne" ? own(args[0]) : args[0].map(own);
      insertAttempts += requested;
      if (method !== "insertMany") return original.apply(this, args);
      // The pinned driver delegates synchronously; allow one bulk call for these exact, already budgeted documents.
      pendingBulk.set(this, args[0]);
      try { return original.apply(this, args); } finally { pendingBulk.delete(this); }
    });
  }
  const originalBulkWrite = prototype.bulkWrite;
  t.mock.method(prototype, "bulkWrite", function (operations, ...args) {
    collection(this); const documents = pendingBulk.get(this); pendingBulk.delete(this);
    assert.ok(documents && Array.isArray(operations) && operations.length === documents.length, "Unapproved native collection operation");
    operations.forEach((operation, index) => {
      assert.deepEqual(Object.keys(operation), ["insertOne"]); assert.deepEqual(Object.keys(operation.insertOne), ["document"]);
      assert.equal(operation.insertOne.document, documents[index]); assert.equal(documents[index].fixtureRun, plan.run);
    });
    return originalBulkWrite.call(this, operations, ...args);
  });
  for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"]) {
    const original = prototype[method];
    t.mock.method(prototype, method, function (...args) {
      collection(this); assert.notEqual(args[2]?.upsert, true, "Unbudgeted native upsert refused"); return original.apply(this, args);
    });
  }
  for (const method of ["createIndex", "createIndexes"]) {
    const original = prototype[method];
    t.mock.method(prototype, method, function (...args) { collection(this); return original.apply(this, args); });
  }
  for (const method of ["deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace", "drop", "dropIndex", "dropIndexes", "rename"]) {
    if (typeof prototype[method] === "function") t.mock.method(prototype, method, () => { throw Error("Unapproved native collection operation"); });
  }
  const dbPrototype = mongoose.mongo.Db.prototype;
  for (const method of ["createCollection", "dropCollection"]) {
    const original = dbPrototype[method];
    t.mock.method(dbPrototype, method, function (name, ...args) {
      check(); assert.equal(this.client, client); assert.equal(this.databaseName, plan.database); assert.ok(plan.collections.includes(name)); return original.call(this, name, ...args);
    });
  }
  t.mock.method(dbPrototype, "dropDatabase", () => { throw Error("Database drop is outside this plan"); });
  t.mock.method(dbPrototype, "command", () => { throw Error("Raw database commands are outside this plan"); });
  return { insertAttempts: () => insertAttempts };
}
