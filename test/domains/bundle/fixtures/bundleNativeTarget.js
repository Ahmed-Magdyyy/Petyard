import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "../../assistant/fixtures/mongoTarget.js";

export const bundleNativeOptIn = "one-owned-isolated-bundle-native-run";
export const bundleNativeCollections = Object.freeze(["assistanttestownership", "warehouses", "products", "manualbundles"]);
export function validateBundleNativePlan(plan) {
  assert.equal(plan?.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.deepEqual(plan.collections, [...bundleNativeCollections]); assert.equal(plan.maxInsertAttempts, 16);
  assert.equal(plan.optIn, bundleNativeOptIn); return plan;
}
export const bundleNativeMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: bundleNativeOptIn });
export function bundleNativeConnection(connection, plan) {
  validateBundleNativePlan(plan); const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database);
    assert.equal(connection.db, db); assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, client, check };
}
export async function verifyBundleNativeEmpty(connection, plan) {
  const { db, check } = bundleNativeConnection(connection, plan);
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(rows, [], "Isolated bundle database is not empty"); return { database: plan.database, collectionsRemaining: 0 };
}
export async function claimBundleNativeDatabase(connection, plan) {
  const { db, check } = bundleNativeConnection(connection, plan); await verifyBundleNativeEmpty(connection, plan);
  await db.createCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  await db.collection("assistanttestownership").insertOne(bundleNativeMarker(plan), { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); check();
}
export async function inspectBundleNativeDatabase(connection, plan) {
  const { db, check } = bundleNativeConnection(connection, plan);
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), bundleNativeMarker(plan)); check();
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.ok(rows.every(row => plan.collections.includes(row.name)), "Unknown collection blocks run/cleanup");
  let documents = 0;
  for (const { name } of rows) {
    if (name !== "assistanttestownership") {
      assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0, "Foreign data blocks run/cleanup"); check();
    }
    documents += await db.collection(name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }); check();
  }
  assert.ok(documents >= 1 && documents <= plan.maxInsertAttempts); return { collectionNames: rows.map(row => row.name).sort(), documents };
}
export async function cleanupBundleNativeDatabase(connection, plan) {
  const { db, check } = bundleNativeConnection(connection, plan), before = await inspectBundleNativeDatabase(connection, plan);
  for (const name of before.collectionNames.filter(name => name !== "assistanttestownership")) {
    check(); assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0); check();
    await db.dropCollection(name, { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  }
  const last = await inspectBundleNativeDatabase(connection, plan); assert.deepEqual(last.collectionNames, ["assistanttestownership"]);
  await db.dropCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  return { droppedOwnedCollections: before.collectionNames.length, documentsBeforeCleanup: before.documents };
}
export function installBundleNativeGuard(t, connection, plan) {
  const { client, check } = bundleNativeConnection(connection, plan), prototype = mongoose.mongo.Collection.prototype;
  let attempts = 1;
  const scoped = value => {
    check(); assert.equal(value.client, client); assert.equal(value.dbName, plan.database);
    assert.ok(plan.collections.includes(value.collectionName), "Unapproved bundle collection");
  };
  const insert = prototype.insertOne;
  t.mock.method(prototype, "insertOne", function (row, options) {
    scoped(this); assert.notEqual(this.collectionName, "assistanttestownership");
    assert.ok(row && row._id && (row.fixtureRun === undefined || row.fixtureRun === plan.run));
    assert.ok(attempts < plan.maxInsertAttempts, "Native bundle insert budget exceeded"); attempts++;
    return insert.call(this, { ...row, fixtureRun: plan.run }, options);
  });
  for (const name of ["updateOne", "findOneAndUpdate", "findOneAndDelete"]) {
    const original = prototype[name];
    t.mock.method(prototype, name, function (filter, ...args) {
      scoped(this); assert.notEqual(this.collectionName, "assistanttestownership");
      assert.match(String(filter?._id), /^[a-f\d]{24}$/i, "Exact fixture ID required");
      assert.ok(filter.fixtureRun === undefined || filter.fixtureRun === plan.run);
      if (name !== "findOneAndDelete") {
        assert.notEqual(args[1]?.upsert, true); assert.notEqual(args[1]?.overwrite, true);
        assert.ok(args[0] && !Array.isArray(args[0]) && Object.keys(args[0]).every(key => ["$set", "$inc", "$setOnInsert"].includes(key)));
        if (args[0].$setOnInsert) assert.deepEqual(Object.keys(args[0].$setOnInsert), ["createdAt"]);
        for (const values of Object.values(args[0])) assert.ok(Object.keys(values).every(key => !["fixtureRun", "_id"].some(root => key === root || key.startsWith(root + "."))));
      } else assert.equal(this.collectionName, "manualbundles");
      return original.call(this, { ...filter, fixtureRun: plan.run }, ...args);
    });
  }
  const createIndex = prototype.createIndex;
  t.mock.method(prototype, "createIndex", function (key, options) {
    scoped(this); assert.equal(this.collectionName, "manualbundles");
    assert.deepEqual(key, { origin: 1, status: 1, _id: -1 }); assert.deepEqual(options, { name: "manual_bundle_catalog_v1" });
    return createIndex.call(this, key, options);
  });
  for (const name of ["insertMany", "bulkWrite", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndReplace", "createIndexes", "drop", "dropIndex", "dropIndexes", "rename", "initializeOrderedBulkOp", "initializeUnorderedBulkOp"]) {
    if (typeof prototype[name] === "function") t.mock.method(prototype, name, () => { throw Error("Unapproved bundle native operation"); });
  }
  const dbPrototype = mongoose.mongo.Db.prototype;
  for (const name of ["createCollection", "dropCollection"]) {
    const original = dbPrototype[name];
    t.mock.method(dbPrototype, name, function (collection, ...args) {
      check(); assert.equal(this.client, client); assert.equal(this.databaseName, plan.database);
      assert.ok(plan.collections.includes(collection)); return original.call(this, collection, ...args);
    });
  }
  for (const name of ["dropDatabase", "command"]) t.mock.method(dbPrototype, name, () => { throw Error("Raw/drop database operations outside bundle plan"); });
  return { insertAttempts: () => attempts };
}
