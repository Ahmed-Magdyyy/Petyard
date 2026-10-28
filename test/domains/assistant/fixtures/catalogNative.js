import assert from "node:assert/strict";
import mongoose from "mongoose";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "./mongoTarget.js";
import { nativeIndexDefinition } from "./automaticBundleNative.js";
import { assertOwnedSearchPilotIndex as assertOwnedCatalogIndex } from "./referenceSearchPilot.js";
export { assertOwnedCatalogIndex };

export const catalogNativeOptIn = "one-owned-catalog-semantic-native-run";
export const catalogNativeCollections = Object.freeze(["assistanttestownership", "assistantcatalogvectors", "assistantembeddingbatches", "assistantbudgets", "assistantruns", "products", "warehouses", "brands", "categories", "subcategories", "manualbundles", "collections"]);
export const catalogNativeIndex = Object.freeze({ name: "petyard_catalog_vector_v1", type: "vectorSearch", definition: { fields: [
  { type: "vector", path: "vector", numDimensions: 1536, similarity: "cosine" },
  { type: "filter", path: "warehouseIds" }, { type: "filter", path: "kind" },
] } });
export const catalogNativeIndexes = {
  assistantcatalogvectors: [nativeIndexDefinition({ kind: 1, sourceId: 1 })],
  assistantembeddingbatches: [nativeIndexDefinition({ key: 1 }, { unique: true }), nativeIndexDefinition({ kind: 1, vectorsExpireAt: 1 })],
  manualbundles: [nativeIndexDefinition({ origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" })],
};
export function validateCatalogNativePlan(plan) {
  assert.equal(plan?.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.equal(plan.optIn, catalogNativeOptIn); assert.equal(plan.maxInsertAttempts, 192); assert.equal(plan.caseCount, 8);
  assert.deepEqual(plan.collections, [...catalogNativeCollections]); assert.equal(plan.maxFakeCalls, 32); assert.deepEqual(plan.indexes, catalogNativeIndexes); assert.deepEqual(plan.index, catalogNativeIndex);
  for (const [name, indexes] of Object.entries(plan.indexes)) {
    assert.ok(plan.collections.includes(name) && ["assistantcatalogvectors", "assistantembeddingbatches", "manualbundles"].includes(name)); assert.ok(Array.isArray(indexes));
    for (const index of indexes) {
      assert.ok(index.key && Object.keys(index.key).length && Object.values(index.key).every(value => [1, -1].includes(value)));
      assert.equal(typeof index.name, "string"); assert.equal(typeof index.unique, "boolean");
      assert.ok(index.expireAfterSeconds === null || index.expireAfterSeconds === 0);
      assert.deepEqual(Object.keys(index).sort(), ["key", "name", "unique", "expireAfterSeconds"].sort());
    }
  }
  return plan;
}
export function catalogNativeConnection(connection, plan) {
  validateCatalogNativePlan(plan); const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database); assert.equal(connection.db, db);
    assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, client, check };
}
export const catalogNativeMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: plan.optIn });
async function assertOwnership(db, plan, check) {
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), catalogNativeMarker(plan));
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
}
export async function verifyCatalogNativeEmpty(connection, plan) {
  const { db, check } = catalogNativeConnection(connection, plan);
  const rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(); check(); assert.deepEqual(rows, []);
  return { database: plan.database, collectionsRemaining: 0 };
}
export async function catalogNativeCapacity(connection, plan) {
  const { client, check } = catalogNativeConnection(connection, plan);
  const inventory = await client.db(plan.database).admin().listDatabases({ nameOnly: true, authorizedDatabases: false, maxTimeMS: 5000 });
  assert.ok(inventory.databases.length <= 100); let collections = 0, indexes = 0;
  for (const { name } of inventory.databases) {
    if (["admin", "config", "local"].includes(name)) continue;
    const db = client.db(name), rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray();
    collections += rows.length; assert.ok(collections <= 500);
    for (const row of rows) indexes += (await db.collection(row.name)
      .aggregate([{ $listSearchIndexes: {} }, { $project: { _id: 0, id: 1 } }], { maxTimeMS: 5000 }).toArray()).length;
    check();
  }
  assert.ok(indexes < 3, "No free Search slot; existing indexes stay untouched");
  assert.ok(collections + plan.collections.length <= 500, "No free collection capacity");
  return { collections, indexes };
}
export async function claimCatalogNativeDatabase(connection, plan) {
  const { db, check } = catalogNativeConnection(connection, plan); await verifyCatalogNativeEmpty(connection, plan);
  await db.createCollection("assistanttestownership", { writeConcern: { w: "majority" }, maxTimeMS: 10000 }); check();
  await db.collection("assistanttestownership").insertOne(catalogNativeMarker(plan), { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); check();
}
export async function inspectCatalogNativeDatabase(connection, plan) {
  const { db, check } = catalogNativeConnection(connection, plan);
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
export async function cleanupCatalogNativeDatabase(connection, plan) {
  const { db, check } = catalogNativeConnection(connection, plan), snapshot = await inspectCatalogNativeDatabase(connection, plan);
  for (const name of snapshot.collectionNames) {
    assert.deepEqual(await db.collection(name).listSearchIndexes().toArray(), [], "Search indexes must be removed and verified before collections"); check();
  }
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
export function installCatalogNativeGuard(t, connection, plan) {
  const { client, check } = catalogNativeConnection(connection, plan), prototype = mongoose.mongo.Collection.prototype;
  let insertAttempts = 1, projectionUpserts = 0;
  const spend = () => assert.ok(++insertAttempts <= plan.maxInsertAttempts, "Native insert/upsert attempt budget exceeded");
  const scoped = value => { check(); assert.equal(value.client, client); assert.equal(value.dbName, plan.database); assert.ok(plan.collections.includes(value.collectionName)); };
  for (const method of ["find", "findOne", "countDocuments", "indexes", "listIndexes", "estimatedDocumentCount", "distinct"]) {
    const original = prototype[method]; t.mock.method(prototype, method, function (...args) { scoped(this); return original.apply(this, args); });
  }
  const aggregate = prototype.aggregate;
  t.mock.method(prototype, "aggregate", function (pipeline, ...args) {
    scoped(this); assert.ok(Array.isArray(pipeline));
    assert.ok(pipeline.every(stage => Object.keys(stage).every(key => ["$match", "$project", "$limit", "$group", "$vectorSearch", "$listSearchIndexes"].includes(key))));
    for (const stage of pipeline) {
      if (stage.$group) assert.deepEqual(stage, { $group: { _id: 1, n: { $sum: 1 } } });
      if (stage.$vectorSearch) assert.equal(this.collectionName, "assistantcatalogvectors");
      if (stage.$vectorSearch) {
        assert.equal(stage.$vectorSearch.index, plan.index.name); assert.equal(stage.$vectorSearch.path, "vector");
        assert.equal(stage.$vectorSearch.limit, 20); assert.equal(stage.$vectorSearch.numCandidates, 400);
        assert.ok(stage.$vectorSearch.filter?.$and?.[0]?.warehouseIds instanceof mongoose.Types.ObjectId);
      }
      if (stage.$listSearchIndexes?.name) assert.equal(stage.$listSearchIndexes.name, plan.index.name);
    }
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
        assert.deepEqual(Object.keys(filter.$and[0]).sort(), ["_id", "status", "attempt", "phase", "generation", "contextVersion"].sort());
        assert.equal(filter.$and[0].status, "dispatching"); assert.equal(filter.$and[0].phase, "resolve");
        assert.equal(filter.$and[0].generation, 0); assert.equal(filter.$and[0].contextVersion, 0); assert.equal(typeof filter.$and[0].attempt, "string");
      }
      assert.ok(typeof identity === "string" || identity instanceof mongoose.Types.ObjectId ||
        ["assistantaccounts", "assistantchats"].includes(this.collectionName) && filter.owner instanceof mongoose.Types.ObjectId, "Exact record or owner identity required");
      assert.ok(filter.fixtureRun === undefined || filter.fixtureRun === plan.run);
      assert.ok(update && typeof update === "object" && !Array.isArray(update));
      assert.ok(Object.keys(update).every(key => ["$set", "$unset", "$inc", "$setOnInsert"].includes(key)));
      for (const [operator, fields] of Object.entries(update)) for (const [field, value] of Object.entries(fields)) {
        if (field === "fixtureRun") assert.ok(operator === "$setOnInsert" && value === plan.run);
        else assert.ok(!field.startsWith("fixtureRun.") && !field.includes("$"));
      }
      const mutation = { ...update };
      if (options.upsert === true) {
        assert.ok(["assistantbudgets", "assistantcatalogvectors"].includes(this.collectionName)); spend(); mutation.$setOnInsert = { ...mutation.$setOnInsert, fixtureRun: plan.run };
        if (this.collectionName === "assistantcatalogvectors") projectionUpserts++;
      }
      return original.call(this, { ...filter, fixtureRun: plan.run }, mutation, options);
    });
  }
  for (const method of ["deleteOne", "deleteMany"]) {
    const original = prototype[method];
    t.mock.method(prototype, method, function (filter, ...args) {
      scoped(this); assert.ok(["products", "assistantcatalogvectors"].includes(this.collectionName));
      assert.ok(filter && (filter._id !== undefined || filter.kind && filter.sourceId));
      assert.ok(!filter.fixtureRun || filter.fixtureRun === plan.run);
      return original.call(this, { ...filter, fixtureRun: plan.run }, ...args);
    });
  }
  const allowIndex = (name, key, options) => {
    assert.ok(!options?.sparse && !options?.partialFilterExpression && !options?.hidden && !options?.collation);
    const definition = nativeIndexDefinition(key, options);
    assert.ok(plan.indexes[name]?.some(index => JSON.stringify(index) === JSON.stringify(definition)), "Unapproved index refused");
  };
  const createIndex = prototype.createIndex, createIndexes = prototype.createIndexes;
  t.mock.method(prototype, "createIndex", function (key, options) { scoped(this); allowIndex(this.collectionName, key, options); return createIndex.call(this, key, options); });
  t.mock.method(prototype, "createIndexes", function (indexes, options) { scoped(this); for (const { key, ...index } of indexes) allowIndex(this.collectionName, key, index); return createIndexes.call(this, indexes, options); });
  for (const method of ["insertMany", "bulkWrite", "replaceOne", "findOneAndDelete", "findOneAndReplace", "drop", "dropIndex", "dropIndexes", "rename",
    "initializeOrderedBulkOp", "initializeUnorderedBulkOp", "updateSearchIndex"]) {
    if (typeof prototype[method] === "function") t.mock.method(prototype, method, () => { throw Error("Unapproved native collection operation"); });
  }
  let indexCreates = 0, indexDrops = 0;
  const createSearchIndex = prototype.createSearchIndex, createSearchIndexes = prototype.createSearchIndexes, dropSearchIndex = prototype.dropSearchIndex;
  t.mock.method(prototype, "createSearchIndex", async function (definition, ...args) {
    scoped(this); assert.equal(this.collectionName, "assistantcatalogvectors"); assert.deepEqual(definition, plan.index);
    return createSearchIndex.call(this, definition, ...args);
  });
  t.mock.method(prototype, "createSearchIndexes", async function (definitions, ...args) {
    scoped(this); assert.equal(this.collectionName, "assistantcatalogvectors"); assert.deepEqual(definitions, [plan.index]);
    assert.equal(++indexCreates, 1); await inspectCatalogNativeDatabase(connection, plan);
    return createSearchIndexes.call(this, definitions, ...args);
  });
  t.mock.method(prototype, "dropSearchIndex", async function (name, ...args) {
    scoped(this); assert.equal(this.collectionName, "assistantcatalogvectors"); assert.equal(name, plan.index.name);
    assert.equal(++indexDrops, 1); await inspectCatalogNativeDatabase(connection, plan);
    const indexes = await this.listSearchIndexes().toArray(); assert.equal(indexes.length, 1);
    assertOwnedCatalogIndex(indexes[0], plan);
    return dropSearchIndex.call(this, name, ...args);
  });
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
  return { insertAttempts: () => insertAttempts, projectionUpserts: () => projectionUpserts, indexCreates: () => indexCreates, indexDrops: () => indexDrops };
}
