import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "./mongoTarget.js";
import { nativeIndexDefinition } from "./automaticBundleNative.js";

export const focusedReferenceNativeOptIn = "one-owned-focused-reference-native-run";
export const focusedReferenceNativeCollections = Object.freeze(["assistanttestownership", "users", "assistantchats", "assistantmessages",
  "assistantruns", "assistantaccounts", "assistantmemories", "assistantdietarywarnings", "assistantbudgets", "assistantevents",
  "notificationoutboxes", "assistantembeddingbatches", "assistantreferences", "pets"]);
export function validateFocusedReferenceNativePlan(plan) {
  assert.equal(plan?.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.equal(plan.optIn, focusedReferenceNativeOptIn); assert.equal(plan.maxInsertAttempts, 384); assert.equal(plan.caseCount, 8);
  assert.deepEqual(plan.collections, [...focusedReferenceNativeCollections]); assert.equal(Object.keys(plan.indexes ?? {}).length, 11);
  for (const [name, indexes] of Object.entries(plan.indexes)) {
    assert.ok(plan.collections.includes(name) && !["users", "pets", "assistanttestownership"].includes(name)); assert.ok(Array.isArray(indexes));
    for (const index of indexes) {
      assert.ok(index.key && Object.keys(index.key).length && Object.values(index.key).every(value => [1, -1].includes(value)));
      assert.equal(typeof index.name, "string"); assert.equal(typeof index.unique, "boolean");
      assert.ok(index.expireAfterSeconds === null || index.expireAfterSeconds === 0);
      assert.deepEqual(Object.keys(index).sort(), ["key", "name", "unique", "expireAfterSeconds"].sort());
    }
  }
  return plan;
}
export function focusedReferenceNativeConnection(connection, plan) {
  validateFocusedReferenceNativePlan(plan); const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database); assert.equal(connection.db, db);
    assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, client, check };
}
export const focusedReferenceNativeMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: plan.optIn });
async function assertOwnership(db, plan, check) {
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), focusedReferenceNativeMarker(plan));
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
}
export async function verifyFocusedReferenceNativeEmpty(connection, plan) {
  const { db, check } = focusedReferenceNativeConnection(connection, plan);
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check(); assert.deepEqual(rows, []);
  return { database: plan.database, collectionsRemaining: 0 };
}
export async function claimFocusedReferenceNativeDatabase(connection, plan) {
  const { db, check } = focusedReferenceNativeConnection(connection, plan); await verifyFocusedReferenceNativeEmpty(connection, plan);
  await db.createCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  await db.collection("assistanttestownership").insertOne(focusedReferenceNativeMarker(plan), { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); check();
}
export async function inspectFocusedReferenceNativeDatabase(connection, plan) {
  const { db, check } = focusedReferenceNativeConnection(connection, plan);
  await assertOwnership(db, plan, check);
  const collections = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check();
  assert.ok(collections.every(row => plan.collections.includes(row.name)), "Unknown collection prevents cleanup");
  let documents = 0;
  for (const { name } of collections) {
    if (name !== "assistanttestownership") assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0, "Foreign record prevents cleanup");
    documents += await db.collection(name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }); check();
  }
  assert.ok(documents >= 1 && documents <= plan.maxInsertAttempts); return { collectionNames: collections.map(row => row.name).sort(), documents };
}
export async function cleanupFocusedReferenceNativeDatabase(connection, plan) {
  const { db, check } = focusedReferenceNativeConnection(connection, plan), snapshot = await inspectFocusedReferenceNativeDatabase(connection, plan);
  for (const name of snapshot.collectionNames.filter(name => name !== "assistanttestownership")) {
    check(); assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0);
    await assertOwnership(db, plan, check);
    await db.dropCollection(name, { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  }
  assert.deepEqual((await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray()).map(row => row.name), ["assistanttestownership"]);
  await assertOwnership(db, plan, check);
  await db.dropCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  return { droppedOwnedCollections: snapshot.collectionNames.length, documentsBeforeCleanup: snapshot.documents };
}

// Test-code containment uses the successful native guard pattern; it is not a sandbox against arbitrary code.
export function installFocusedReferenceNativeGuard(t, connection, plan) {
  const { client, check } = focusedReferenceNativeConnection(connection, plan), prototype = mongoose.mongo.Collection.prototype;
  let insertAttempts = 1;
  const spend = () => assert.ok(++insertAttempts <= plan.maxInsertAttempts, "Native insert/upsert attempt budget exceeded");
  const scoped = value => { check(); assert.equal(value.client, client); assert.equal(value.dbName, plan.database); assert.ok(plan.collections.includes(value.collectionName)); };
  for (const method of ["find", "findOne", "countDocuments", "indexes", "listIndexes", "estimatedDocumentCount", "distinct"]) {
    const original = prototype[method]; t.mock.method(prototype, method, function (...args) { scoped(this); return original.apply(this, args); });
  }
  const aggregate = prototype.aggregate;
  t.mock.method(prototype, "aggregate", function (pipeline, ...args) {
    scoped(this); assert.ok(Array.isArray(pipeline));
    assert.ok(pipeline.every(stage => !Object.keys(stage).some(key => ["$out", "$merge", "$lookup", "$graphLookup", "$unionWith", "$search", "$vectorSearch", "$listSearchIndexes"].includes(key))));
    return aggregate.call(this, pipeline, ...args);
  });
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
      let identity = filter._id;
      if (this.collectionName === "assistantruns" && filter.$and !== undefined) {
        assert.equal(method, "updateOne"); assert.notEqual(options.upsert, true);
        assert.deepEqual(Object.keys(filter), ["$and"]); assert.equal(filter.$and.length, 2);
        assert.deepEqual(filter.$and[1], { $or: [{ purpose: "customer" }, { purpose: { $exists: false } }] });
        assert.ok(filter.$and[0]?._id instanceof mongoose.Types.ObjectId); identity = filter.$and[0]._id;
        assert.deepEqual(Object.keys(filter.$and[0]).sort(), ["_id", "status", "phase", "generation", "contextVersion", "referenceFlowVersion"].sort());
        assert.equal(filter.$and[0].status, "queued"); assert.equal(filter.$and[0].phase, "answer");
        assert.equal(filter.$and[0].generation, 2); assert.equal(filter.$and[0].contextVersion, 1); assert.equal(filter.$and[0].referenceFlowVersion, "focused-v1");
      }
      assert.ok(typeof identity === "string" || identity instanceof mongoose.Types.ObjectId ||
        ["assistantaccounts", "assistantchats"].includes(this.collectionName) && filter.owner instanceof mongoose.Types.ObjectId, "Exact record or owner identity required");
      assert.ok(filter.fixtureRun === undefined || filter.fixtureRun === plan.run);
      assert.ok(update && typeof update === "object" && !Array.isArray(update));
      assert.ok(Object.keys(update).every(key => ["$set", "$unset", "$inc", "$setOnInsert", "$push"].includes(key)));
      if (update.$push) {
        assert.equal(this.collectionName, "assistantruns"); assert.equal(method, "updateOne");
        assert.ok(filter._id instanceof mongoose.Types.ObjectId && options.upsert !== true);
        assert.deepEqual(Object.keys(update.$push), ["attempts"]);
        assert.deepEqual(Object.keys(update.$push.attempts ?? {}), ["$each"]);
        const attempts = update.$push.attempts.$each;
        assert.ok(Array.isArray(attempts) && attempts.length === 1);
        assert.match(attempts[0].id, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
        assert.ok([[1,"resolve"],[2,"normalize"],[2,"answer"],[3,"answer"]].some(([number, phase]) => attempts[0].number === number && attempts[0].phase === phase));
        assert.equal(attempts[0].accounting, "reserved");
      }
      for (const [operator, fields] of Object.entries(update)) for (const [field, value] of Object.entries(fields)) {
        if (field === "fixtureRun") assert.ok(operator === "$setOnInsert" && value === plan.run);
        else assert.ok(!field.startsWith("fixtureRun.") && !field.includes("$"));
      }
      const mutation = { ...update };
      if (options.upsert === true) {
        assert.ok(["assistantbudgets", "assistantaccounts", "assistantchats"].includes(this.collectionName)); spend(); mutation.$setOnInsert = { ...mutation.$setOnInsert, fixtureRun: plan.run };
      }
      return original.call(this, { ...filter, fixtureRun: plan.run }, mutation, options);
    });
  }
  const updateMany = prototype.updateMany;
  t.mock.method(prototype, "updateMany", function (filter, update, options = {}) {
    scoped(this); assert.notEqual(options.upsert, true);
    if (this.collectionName === "assistantmemories") {
      assert.deepEqual(Object.keys(filter).sort(), ["state", "validUntil"].sort()); assert.equal(filter.state, "active");
      assert.deepEqual(Object.keys(filter.validUntil), ["$lte"]); assert.ok(filter.validUntil.$lte instanceof Date && Number.isFinite(filter.validUntil.$lte.getTime()));
      assert.equal(update.$set?.state, "forgotten"); assert.deepEqual(update.$unset, { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 });
      assert.deepEqual(update.$inc, { version: 1 });
      assert.ok(Object.keys(update).every(key => ["$set", "$unset", "$inc", "$setOnInsert"].includes(key)));
      assert.ok(Object.keys(update.$set).every(key => ["state", "updatedAt"].includes(key)));
      if (update.$set.updatedAt !== undefined) assert.ok(update.$set.updatedAt instanceof Date && Number.isFinite(update.$set.updatedAt.getTime()));
      if (update.$setOnInsert) { assert.deepEqual(Object.keys(update.$setOnInsert), ["createdAt"]); assert.ok(update.$setOnInsert.createdAt instanceof Date && Number.isFinite(update.$setOnInsert.createdAt.getTime())); }
      return updateMany.call(this, { ...filter, fixtureRun: plan.run }, update, options);
    }
    assert.equal(this.collectionName, "assistantembeddingbatches");
    assert.deepEqual(Object.keys(filter).sort(), ["kind", "vectors", "vectorsExpireAt"].sort()); assert.equal(filter.kind, "customer_query");
    assert.deepEqual(filter.vectors, { $exists: true }); assert.deepEqual(Object.keys(filter.vectorsExpireAt), ["$lte"]);
    assert.ok(filter.vectorsExpireAt.$lte instanceof Date && Number.isFinite(filter.vectorsExpireAt.$lte.getTime()));
    assert.deepEqual(update.$unset, { vectors: 1 }); assert.ok(Object.keys(update).every(key => ["$unset", "$set", "$setOnInsert"].includes(key)));
    for (const [operator, field] of [["$set", "updatedAt"], ["$setOnInsert", "createdAt"]]) if (update[operator]) {
      assert.deepEqual(Object.keys(update[operator]), [field]); assert.ok(update[operator][field] instanceof Date);
    }
    return updateMany.call(this, { ...filter, fixtureRun: plan.run }, update, options);
  });
  const allowIndex = (name, key, options) => {
    assert.ok(!options?.sparse && !options?.partialFilterExpression && !options?.hidden && !options?.collation);
    const definition = nativeIndexDefinition(key, options);
    assert.ok(plan.indexes[name]?.some(index => JSON.stringify(index) === JSON.stringify(definition)), "Unapproved index refused");
  };
  const createIndex = prototype.createIndex, createIndexes = prototype.createIndexes;
  t.mock.method(prototype, "createIndex", function (key, options) { scoped(this); allowIndex(this.collectionName, key, options); return createIndex.call(this, key, options); });
  t.mock.method(prototype, "createIndexes", function (indexes, options) { scoped(this); for (const { key, ...index } of indexes) allowIndex(this.collectionName, key, index); return createIndexes.call(this, indexes, options); });
  for (const method of ["insertMany", "bulkWrite", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace", "drop", "dropIndex", "dropIndexes", "rename",
    "initializeOrderedBulkOp", "initializeUnorderedBulkOp", "createSearchIndex", "createSearchIndexes", "updateSearchIndex", "dropSearchIndex"]) {
    if (typeof prototype[method] === "function") t.mock.method(prototype, method, () => { throw Error("Unapproved native collection operation"); });
  }
  const dbPrototype = mongoose.mongo.Db.prototype;
  const dbScope = value => { check(); assert.equal(value.client, client); assert.equal(value.databaseName, plan.database); };
  for (const method of ["createCollection", "dropCollection"]) {
    const original = dbPrototype[method]; t.mock.method(dbPrototype, method, function (name, ...args) { dbScope(this); assert.ok(plan.collections.includes(name)); return original.call(this, name, ...args); });
  }
  const list = dbPrototype.listCollections;
  t.mock.method(dbPrototype, "listCollections", function (...args) { dbScope(this); return list.apply(this, args); });
  t.mock.method(dbPrototype, "dropDatabase", () => { throw Error("Whole-database deletion refused"); });
  t.mock.method(dbPrototype, "command", () => { throw Error("Raw database command refused"); });
  if (mongoose.mongo.Admin?.prototype.command) {
    const command = mongoose.mongo.Admin.prototype.command;
    t.mock.method(mongoose.mongo.Admin.prototype, "command", function (value, ...args) { check(); assert.deepEqual(value, { hello: 1 }); return command.call(this, value, ...args); });
  }
  return { insertAttempts: () => insertAttempts };
}
