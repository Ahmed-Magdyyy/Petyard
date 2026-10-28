import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { validateSearchPilotPlan, searchPilotOptIn, searchPilotCollections, searchPilotConnection,
  buildSearchPilotFixtures, searchPilotMarker, assertSearchPilotOwned, countTestClusterSearchIndexes,
  assertOwnedSearchPilotIndex } from "./fixtures/referenceSearchPilot.js";
import { referenceVectorIndex, AssistantReferencePassage } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { AssistantReference } from "../../../src/domains/assistant/references/assistant.reference.model.js";

const plan = () => ({ host: "magdy.pbupj.mongodb.net", database: "ai_test_search_111111111111", run: "11111111-1111-1111-1111-111111111111",
  optIn: searchPilotOptIn, caseCount: 4, maxInsertAttempts: 16, collections: [...searchPilotCollections], index: structuredClone(referenceVectorIndex) });
function fixture() {
  const p = plan(), f = { plan: p, stores: { assistanttestownership: [searchPilotMarker(p)] } };
  const db = { databaseName: p.database, listCollections: () => ({ async toArray() { return Object.keys(f.stores).map(name => ({ name })); } }),
    collection(name) { return { async findOne() { return f.stores[name]?.[0]; },
      async countDocuments(filter = {}) { return (f.stores[name] ?? []).filter(row => !filter.fixtureRun || row.fixtureRun !== filter.fixtureRun.$ne).length; } }; } };
  const client = { options: { srvHost: p.host, dbName: "petyard" } };
  f.connection = { readyState: 1, name: p.database, db, getClient: () => client }; return f;
}
test("Search pilot fixes the exact test namespace, collection scope, index and write ceiling", () => {
  validateSearchPilotPlan(plan());
  for (const change of [{ host: "production.example" }, { database: "petyard" }, { run: "-".repeat(36) }, { caseCount: 5 },
    { maxInsertAttempts: 17 }, { collections: [...searchPilotCollections, "orders"] }, { index: { ...referenceVectorIndex, name: "another" } }])
    assert.throws(() => validateSearchPilotPlan({ ...plan(), ...change }));
});
test("fixture passages use the actual source schema, manifest identifiers and finite 1536-dimensional geometry", async () => {
  const f = await buildSearchPilotFixtures(plan().run); assert.equal(f.references.length, 3); assert.equal(f.passages.length, 7);
  assert.equal(new Set(f.passages.map(row => row._id)).size, 7);
  for (const { source } of f.references) assert.equal(new AssistantReference(source).validateSync(), undefined);
  for (const row of f.passages) assert.equal(new AssistantReferencePassage(row).validateSync(), undefined);
  assert.ok(1 + f.references.length + f.passages.length <= plan().maxInsertAttempts);
  assert.equal(f.query.vector.length, 1536); assert.ok(f.passages[0].vector[0] > f.passages[1].vector[0]);
  assert.equal(f.references[0].source.species[0], "cat"); assert.equal(f.references[1].source.species[0], "dog");
  assert.equal(f.references[2].source.status, "disabled");
});
test("namespace and ownership checks reject changed handles, foreign rows and foreign collections", async () => {
  const f = fixture(); await assertSearchPilotOwned(f.connection, f.plan);
  f.stores.assistantreferences = [{ fixtureRun: "foreign" }]; await assert.rejects(assertSearchPilotOwned(f.connection, f.plan));
  delete f.stores.assistantreferences; f.stores.orders = []; await assert.rejects(assertSearchPilotOwned(f.connection, f.plan));
  f.connection.db.databaseName = "petyard"; assert.throws(() => searchPilotConnection(f.connection, f.plan));
  const other = fixture(); other.connection.getClient().options.srvHost = "production.example";
  assert.throws(() => searchPilotConnection(other.connection, other.plan));
});
test("Search cleanup accepts only the exact owned definition including harmless explicit no-quantization", () => {
  const p = plan(), index = { name: p.index.name, type: p.index.type, latestDefinition: structuredClone(p.index.definition) };
  assertOwnedSearchPilotIndex(index, p); index.latestDefinition.fields[0].quantization = "none"; assertOwnedSearchPilotIndex(index, p);
  index.latestDefinition.fields.reverse(); assertOwnedSearchPilotIndex(index, p); index.latestDefinition.fields.reverse();
  for (const change of [{ name: "foreign" }, { type: "search" }, { latestDefinition: { fields: [] } }])
    assert.throws(() => assertOwnedSearchPilotIndex({ ...index, ...change }, p));
  index.latestDefinition.fields[0].quantization = "binary"; assert.throws(() => assertOwnedSearchPilotIndex(index, p));
});
test("cluster capacity preflight requests complete names and Search metadata only, and permission failures propagate", async () => {
  const f = fixture(), client = f.connection.getClient(); let requests = 0;
  client.db = name => ({ admin: () => ({ async listDatabases(options) {
    assert.equal(options.authorizedDatabases, false); return { databases: [{ name: "petyard" }] };
  } }), listCollections: () => ({ async toArray() { return [{ name: "products" }]; } }), collection: collection => ({
    aggregate(pipeline) { requests++; assert.equal(name, "petyard"); assert.equal(collection, "products");
      assert.deepEqual(pipeline, [{ $listSearchIndexes: {} }, { $project: { _id: 0, id: 1 } }]); return { async toArray() { return []; } }; },
  }) });
  assert.deepEqual(await countTestClusterSearchIndexes(f.connection, f.plan), { collections: 1, indexes: 0 }); assert.equal(requests, 1);
  client.db = () => ({ admin: () => ({ async listDatabases() { throw Error("Fictional metadata denial"); } }) });
  await assert.rejects(countTestClusterSearchIndexes(f.connection, f.plan), /Fictional metadata denial/);
});
