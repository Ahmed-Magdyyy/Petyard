import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "./mongoTarget.js";

export const combinedNativeOptIn = "one-owned-combined-assistant-native-run";
export const combinedNativeCollections = Object.freeze(["assistanttestownership", "users", "pets", "warehouses", "products", "brands", "categories", "subcategories", "orders", "manualbundles", "carts", "collections", "loyaltysettings",
  "assistantchats", "assistantmessages", "assistantruns", "assistantaccounts", "assistantmemories", "assistantdietarywarnings",
  "assistantbudgets", "assistantevents", "notificationoutboxes", "assistantadminchats", "assistantadminmessages", "assistantcartproposals", "assistantcartreceipts", "assistantbookingreceipts"]);
const keyText = value => JSON.stringify(value);
const indexName = key => Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_");
export const nativeIndexDefinition = (key, options = {}) => ({ key, name: options.name ?? indexName(key),
  unique: options.unique === true, expireAfterSeconds: options.expireAfterSeconds ?? null });

export function validateCombinedNativePlan(plan) {
  assert.equal(plan?.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.equal(plan.optIn, combinedNativeOptIn); assert.equal(plan.maxInsertAttempts, 256); assert.equal(plan.maxFakeCalls, 4);
  assert.equal(plan.caseCount, 8); assert.deepEqual(plan.collections, [...combinedNativeCollections]);
  assert.ok(plan.indexes && Object.keys(plan.indexes).length === 16);
  for (const [name, indexes] of Object.entries(plan.indexes)) {
    assert.ok(plan.collections.includes(name) && !["assistanttestownership", "users", "products", "orders", "warehouses"].includes(name));
    assert.ok(Array.isArray(indexes));
    for (const index of indexes) {
      assert.ok(index.key && Object.keys(index.key).length > 0 && Object.values(index.key).every(value => [1, -1].includes(value)));
      assert.equal(typeof index.name, "string"); assert.equal(typeof index.unique, "boolean");
      assert.ok(index.expireAfterSeconds === null || index.expireAfterSeconds === 0);
      assert.deepEqual(Object.keys(index).sort(), ["key", "name", "unique", "expireAfterSeconds"].sort());
    }
  }
  return plan;
}

export function combinedNativeConnection(connection, plan) {
  validateCombinedNativePlan(plan);
  const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database); assert.equal(connection.db, db);
    assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, client, check };
}
export const combinedNativeMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: plan.optIn });

export async function verifyCombinedNativeEmpty(connection, plan) {
  const { db, check } = combinedNativeConnection(connection, plan);
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(rows, [], "Isolated database must contain no collections");
  return { database: plan.database, collectionsRemaining: 0 };
}
export async function claimCombinedNativeDatabase(connection, plan) {
  const { db, check } = combinedNativeConnection(connection, plan);
  await verifyCombinedNativeEmpty(connection, plan);
  await db.createCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  await db.collection("assistanttestownership").insertOne(combinedNativeMarker(plan), { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); check();
}
export async function inspectCombinedNativeDatabase(connection, plan) {
  const { db, check } = combinedNativeConnection(connection, plan);
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), combinedNativeMarker(plan)); check();
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.ok(rows.every(row => plan.collections.includes(row.name)), "Unknown collection prevents cleanup");
  let documents = 0;
  for (const { name } of rows) {
    const collection = db.collection(name);
    assert.deepEqual(await collection.listSearchIndexes().toArray(), [], "Unexpected Search index prevents cleanup");
    for (const row of await collection.indexes()) {
      assert.ok(!row.sparse && !row.partialFilterExpression && !row.hidden && (!row.collation || row.collation.locale === "simple"));
      const expected = nativeIndexDefinition(row.key, row);
      assert.ok(row.name === "_id_" && JSON.stringify(row.key) === '{"_id":1}' ||
        plan.indexes[name]?.some(index => JSON.stringify(index) === JSON.stringify(expected)), "Unexpected normal index prevents cleanup");
    }
    if (name !== "assistanttestownership") {
      assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0, "Foreign record prevents cleanup"); check();
    }
    documents += await db.collection(name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }); check();
  }
  assert.ok(Number.isSafeInteger(documents) && documents >= 1 && documents <= plan.maxInsertAttempts);
  return { collectionNames: rows.map(row => row.name).sort(), documents };
}
export async function cleanupCombinedNativeDatabase(connection, plan) {
  const { db, check } = combinedNativeConnection(connection, plan), snapshot = await inspectCombinedNativeDatabase(connection, plan);
  for (const name of snapshot.collectionNames.filter(value => value !== "assistanttestownership")) {
    check(); assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0);
    assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), combinedNativeMarker(plan));
    await db.dropCollection(name, { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  }
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.deepEqual(rows.map(row => row.name), ["assistanttestownership"]);
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), combinedNativeMarker(plan)); check();
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
  await db.dropCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  return { droppedOwnedCollections: snapshot.collectionNames.length, documentsBeforeCleanup: snapshot.documents };
}

// Pinned test-code containment, not a sandbox against arbitrary code. No production model is modified.
export function installCombinedNativeGuard(t, connection, plan) {
  const { check, client } = combinedNativeConnection(connection, plan), prototype = mongoose.mongo.Collection.prototype;
  let insertAttempts = 1;
  const spend = () => { assert.ok(++insertAttempts <= plan.maxInsertAttempts, "Native insert/upsert attempt budget exceeded"); };
  const scoped = value => { check(); assert.equal(value.client, client); assert.equal(value.dbName, plan.database); assert.ok(plan.collections.includes(value.collectionName)); };
  for (const method of ["find", "findOne", "countDocuments", "distinct", "indexes", "listIndexes", "listSearchIndexes", "estimatedDocumentCount"]) {
    const original = prototype[method];
    if (typeof original === "function") t.mock.method(prototype, method, function (...args) { scoped(this); return original.apply(this, args); });
  }
  const aggregate = prototype.aggregate;
  const readPipeline = pipeline => {
    assert.ok(Array.isArray(pipeline));
    for (const stage of pipeline) {
      assert.ok(!Object.keys(stage).some(key => ["$out", "$merge", "$unionWith", "$graphLookup", "$search", "$vectorSearch", "$listSearchIndexes"].includes(key)));
      if (stage.$lookup) { assert.ok(plan.collections.includes(stage.$lookup.from)); readPipeline(stage.$lookup.pipeline ?? []); }
      if (stage.$facet) for (const branch of Object.values(stage.$facet)) readPipeline(branch);
    }
  };
  t.mock.method(prototype, "aggregate", function (pipeline, ...args) { scoped(this); readPipeline(pipeline); return aggregate.call(this, pipeline, ...args); });
  const insert = prototype.insertOne;
  t.mock.method(prototype, "insertOne", function (row, ...args) {
    scoped(this); assert.notEqual(this.collectionName, "assistanttestownership");
    assert.ok(row && typeof row === "object" && !Array.isArray(row)); assert.ok(row.fixtureRun === undefined || row.fixtureRun === plan.run);
    spend(); return insert.call(this, { ...row, fixtureRun: plan.run }, ...args);
  });
  for (const method of ["updateOne", "findOneAndUpdate"]) {
    const original = prototype[method];
    t.mock.method(prototype, method, function (filter, update, options = {}) {
      scoped(this); assert.notEqual(this.collectionName, "assistanttestownership");
      assert.ok(filter && typeof filter === "object" && !Array.isArray(filter));
      if (filter.fixtureRun !== undefined && filter.fixtureRun !== plan.run)
        assert.deepEqual(filter.fixtureRun, { $eq: plan.run, $exists: true }, "Foreign update marker refused");
      assert.ok(filter._id != null && (typeof filter._id === "string" || filter._id instanceof mongoose.Types.ObjectId) ||
        ["assistantaccounts", "assistantadminchats"].includes(this.collectionName) && filter.owner instanceof mongoose.Types.ObjectId, "An exact owned ID/owner is required");
      assert.ok(update && typeof update === "object" && !Array.isArray(update));
      assert.ok(Object.keys(update).every(operator => ["$set", "$unset", "$inc", "$setOnInsert", "$push"].includes(operator)));
      for (const [operator, fields] of Object.entries(update)) {
        assert.ok(fields && typeof fields === "object" && !Array.isArray(fields));
        if (operator === "$push") {
          assert.equal(this.collectionName, "assistantruns"); assert.equal(method, "updateOne");
          assert.ok(filter._id instanceof mongoose.Types.ObjectId && options.upsert !== true);
          assert.deepEqual(Object.keys(fields), ["attempts"]);
          assert.deepEqual(Object.keys(fields.attempts ?? {}), ["$each"]);
          assert.ok(Array.isArray(fields.attempts.$each) && fields.attempts.$each.length === 1);
          const attempt = fields.attempts.$each[0];
          assert.match(attempt.id, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
          assert.equal(attempt.number, 1); assert.equal(attempt.phase, "plan"); assert.equal(attempt.accounting, "reserved");
        }
        for (const [field, value] of Object.entries(fields)) {
          if (field === "fixtureRun") assert.ok(operator === "$setOnInsert" && value === plan.run);
          else assert.ok(!field.startsWith("fixtureRun.") && !field.includes("$"));
        }
      }
      const owned = { ...filter, fixtureRun: plan.run }, mutation = { ...update };
      if (options.upsert === true) {
        assert.ok(["assistantaccounts", "assistantbudgets", "assistantadminchats"].includes(this.collectionName), "Only accounting/account/admin-chat upserts are allowed");
        spend(); mutation.$setOnInsert = { ...mutation.$setOnInsert, fixtureRun: plan.run };
      }
      return original.call(this, owned, mutation, options);
    });
  }
  const allowIndex = (name, key, options) => {
    assert.ok(!options?.sparse && !options?.partialFilterExpression && !options?.hidden && !options?.collation);
    const definition = nativeIndexDefinition(key, options);
    assert.ok(plan.indexes[name]?.some(row => keyText(row) === keyText(definition)), "Unapproved index refused");
  };
  const createIndex = prototype.createIndex, createIndexes = prototype.createIndexes;
  t.mock.method(prototype, "createIndex", function (key, options) { scoped(this); allowIndex(this.collectionName, key, options); return createIndex.call(this, key, options); });
  t.mock.method(prototype, "createIndexes", function (indexes, options) {
    scoped(this); for (const { key, ...index } of indexes) allowIndex(this.collectionName, key, index);
    return createIndexes.call(this, indexes, options);
  });
  for (const method of ["insertMany", "bulkWrite", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace",
    "drop", "dropIndex", "dropIndexes", "rename", "initializeOrderedBulkOp", "initializeUnorderedBulkOp", "createSearchIndex", "createSearchIndexes", "updateSearchIndex", "dropSearchIndex"]) {
    if (typeof prototype[method] === "function") t.mock.method(prototype, method, () => { throw Error("Unapproved native collection operation"); });
  }
  const dbPrototype = mongoose.mongo.Db.prototype;
  const dbScope = value => { check(); assert.equal(value.client, client); assert.equal(value.databaseName, plan.database); };
  for (const method of ["createCollection", "dropCollection"]) {
    const original = dbPrototype[method];
    t.mock.method(dbPrototype, method, function (name, ...args) {
      dbScope(this); assert.ok(plan.collections.includes(name)); return original.call(this, name, ...args);
    });
  }
  const list = dbPrototype.listCollections;
  t.mock.method(dbPrototype, "listCollections", function (...args) { dbScope(this); return list.apply(this, args); });
  t.mock.method(dbPrototype, "dropDatabase", () => { throw Error("Whole-database deletion refused"); });
  t.mock.method(dbPrototype, "command", () => { throw Error("Raw database command refused"); });
  const adminCommand = mongoose.mongo.Admin.prototype.command;
  t.mock.method(mongoose.mongo.Admin.prototype, "command", async function (value, ...args) {
    check(); assert.equal(this.s.db.client, client); assert.equal(this.s.db.databaseName, plan.database);
    assert.deepEqual(value, { hello: 1 }); return adminCommand.call(this, value, ...args);
  });
  return { insertAttempts: () => insertAttempts };
}
