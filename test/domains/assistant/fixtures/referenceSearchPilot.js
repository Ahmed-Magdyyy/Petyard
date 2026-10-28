import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { embeddingProfile } from "../../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { assistantTestDbPattern, authorizedAssistantAtlasHost } from "./mongoTarget.js";

export const searchPilotOptIn = "one-owned-reference-vector-search-pilot";
export const searchPilotCollections = ["assistanttestownership", "assistantreferences", "assistantreferencepassages"];
export function validateSearchPilotPlan(plan) {
  assert.equal(plan.host, authorizedAssistantAtlasHost); assert.match(plan.database, assistantTestDbPattern);
  assert.ok(Buffer.byteLength(plan.database) <= 38); assert.match(plan.run, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.equal(plan.optIn, searchPilotOptIn); assert.equal(plan.caseCount, 4); assert.equal(plan.maxInsertAttempts, 16);
  assert.deepEqual(plan.collections, searchPilotCollections);
  assert.deepEqual(plan.index, { name: "petyard_reference_vector_v1", type: "vectorSearch", definition: { fields: [
    { type: "vector", path: "vector", numDimensions: 1536, similarity: "cosine" },
    ...["reference", "manifestHash", "species"].map(path => ({ type: "filter", path })),
  ] } });
  return plan;
}
export function searchPilotConnection(connection, plan) {
  validateSearchPilotPlan(plan); const db = connection.db, client = connection.getClient();
  const check = () => {
    assert.equal(connection.readyState, 1); assert.equal(connection.name, plan.database); assert.equal(connection.db, db);
    assert.equal(db.databaseName, plan.database); assert.equal(connection.getClient(), client);
    assert.equal(client.options.srvHost, plan.host); assert.equal(client.options.dbName, "petyard");
  };
  check(); return { db, check };
}
export async function verifySearchPilotEmpty(connection, plan) {
  const { db, check } = searchPilotConnection(connection, plan);
  assert.deepEqual(await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray(), []); check();
  return { database: plan.database, collectionsRemaining: 0 };
}
export const searchPilotMarker = plan => ({ _id: "owner", run: plan.run, database: plan.database, purpose: plan.optIn });
export function assertOwnedSearchPilotIndex(index, plan) {
  assert.equal(index.name, plan.index.name); assert.equal(index.type, plan.index.type);
  const definition = structuredClone(index.latestDefinition);
  for (const field of definition?.fields ?? []) if (field.type === "vector" && field.quantization === "none") delete field.quantization;
  const expected = structuredClone(plan.index.definition);
  const byPath = (a, b) => a.path.localeCompare(b.path);
  definition?.fields?.sort(byPath); expected.fields.sort(byPath);
  assert.deepEqual(definition, expected);
}
export async function countTestClusterSearchIndexes(connection, plan) {
  const { check } = searchPilotConnection(connection, plan), client = connection.getClient();
  const inventory = await client.db(plan.database).admin().listDatabases({ nameOnly: true, authorizedDatabases: false, maxTimeMS: 5000 });
  assert.ok(inventory.databases.length <= 100); let collections = 0, indexes = 0;
  for (const { name } of inventory.databases) {
    if (["admin", "config", "local"].includes(name)) continue;
    const db = client.db(name), rows = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray();
    collections += rows.length; assert.ok(collections <= 500);
    for (const row of rows) {
      const found = await db.collection(row.name).aggregate([{ $listSearchIndexes: {} }, { $project: { _id: 0, id: 1 } }], { maxTimeMS: 5000 }).toArray();
      indexes += found.length; check();
    }
  }
  return { collections, indexes };
}
export async function assertSearchPilotOwned(connection, plan) {
  const { db, check } = searchPilotConnection(connection, plan);
  assert.deepEqual(await db.collection("assistanttestownership").findOne({ _id: "owner" }, { maxTimeMS: 5000 }), searchPilotMarker(plan));
  assert.equal(await db.collection("assistanttestownership").countDocuments({}, { maxTimeMS: 5000 }), 1); check();
  const collections = await db.listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray();
  assert.ok(collections.every(row => plan.collections.includes(row.name)));
  let documents = 0;
  for (const { name } of collections) {
    if (name !== "assistanttestownership") assert.equal(await db.collection(name).countDocuments({ fixtureRun: { $ne: plan.run } }, { maxTimeMS: 5000 }), 0);
    documents += await db.collection(name).countDocuments({}, { maxTimeMS: 5000 });
  }
  assert.ok(documents >= 1 && documents <= plan.maxInsertAttempts); check(); return { documents, collections };
}

// Fixture vectors test geometry and filtering only; they do not represent learned language meaning.
export async function buildSearchPilotFixtures(run) {
  const { prepareReferencePassages } = await import("../../../../src/domains/assistant/references/assistant.reference-passages.js");
  const { referenceEmbeddingBatchKey } = await import("../../../../src/domains/assistant/references/assistant.embedding-batches.js");
  const { referencePassageDocumentId } = await import("../../../../src/domains/assistant/references/assistant.reference-projection.js");
  const { queryEmbeddingIdentity } = await import("../../../../src/domains/assistant/customer/assistant.query-embedding.js");
  const hash = value => createHash("sha256").update(value).digest("hex"), actor = new mongoose.Types.ObjectId();
  const vector = (first = 1, second = 0) => Array.from({ length: 1536 }, (_, index) => index === 0 ? first : index === 1 ? second : 0);
  const references = [], passages = [];
  for (const [label, species, count] of [["cat", "cat", 2], ["dog", "dog", 2], ["disabled", "cat", 1]]) {
    const source = { _id: new mongoose.Types.ObjectId(), sha256: hash(run + label), creator: actor, title: `Fictional ${label} source`,
      species: [species], filename: "fictional.txt", format: "txt", bytes: 1, sourceStored: true, version: 1,
      status: label === "disabled" ? "disabled" : "processing", stage: label === "disabled" ? "disabled" : "awaiting_search" };
    const prepared = prepareReferencePassages(source, { sha256: source.sha256,
      units: Array.from({ length: count }, (_, i) => ({ locator: `Fictional page ${i + 1}`, text: `Fictional ${label} evidence ${i + 1}.` })) },
    { maxPages: 10, maxTextBytes: 10000 });
    const manifest = Buffer.from(JSON.stringify(prepared));
    Object.assign(source, { passageHash: hash(manifest), passageVersion: prepared.version, passageCount: count, storedPassageCount: count });
    references.push({ source, manifest });
    for (const [index, passage] of prepared.passages.entries()) {
      const batchKey = referenceEmbeddingBatchKey(source._id, source.passageHash, 0);
      passages.push({ _id: referencePassageDocumentId(batchKey, passage.id), reference: source._id, sourceHash: source.sha256,
        manifestHash: source.passageHash, passageId: passage.id, batchKey, model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
        species: source.species, text: passage.text, locator: passage.locator, unitIndex: passage.unitIndex,
        startOffset: passage.startOffset, endOffset: passage.endOffset, previousId: passage.previousId, nextId: passage.nextId,
        vector: index ? vector(0.8, 0.6) : vector() });
    }
  }
  for (const foreign of [false, true]) {
    const row = { ...passages[0], manifestHash: hash(run + (foreign ? "foreign" : "old-manifest")) };
    if (foreign) row.reference = new mongoose.Types.ObjectId();
    row.batchKey = referenceEmbeddingBatchKey(row.reference, row.manifestHash, 0);
    row._id = referencePassageDocumentId(row.batchKey, row.passageId); passages.push(row);
  }
  const scope = { audience: "customer", ownerId: String(actor), runId: String(new mongoose.Types.ObjectId()), subjectId: null,
    contextVersion: 0, generation: 0, phase: "resolve", species: "cat", profileFingerprint: null, query: "Fictional cat question" };
  const identity = queryEmbeddingIdentity(scope);
  return { references, passages, scope, query: { status: "completed", accounting: "settled", receiptKey: identity.key,
    queryContextHash: identity.queryContextHash, vector: vector() } };
}
