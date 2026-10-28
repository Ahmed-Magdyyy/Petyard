import assert from "node:assert/strict";
import { sharedMongoConnection, createSharedMongoManifest } from "./sharedMongo.js";

export const catalogPipelineSetupApproval = "create-two-empty-catalog-pipeline-test-stores";
export function catalogPipelineSetupPlan() {
  return {
    assistantevents: [
      { key: { owner: 1, createdAt: -1 }, name: "owner_1_createdAt_-1" },
      { key: { owner: 1, type: 1, _id: -1 }, name: "owner_1_type_1__id_-1" },
      { key: { type: 1, createdAt: -1, owner: 1 }, name: "type_1_createdAt_-1_owner_1" },
      { key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 },
    ],
    assistantmemories: [
      { key: { owner: 1, subjectId: 1, key: 1 }, name: "owner_1_subjectId_1_key_1", unique: true },
      { key: { owner: 1, state: 1, updatedAt: -1 }, name: "owner_1_state_1_updatedAt_-1" },
      { key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 },
    ],
  };
}
const sorted = (indexes) => [...indexes].sort((a, b) => a.name.localeCompare(b.name));

// Explicit setup only: no fixture inserts, existing-index repair, drop, delete or automatic recovery.
export async function setupCatalogPipelineStores(connection, approval, persist) {
  assert.equal(approval, catalogPipelineSetupApproval); assert.equal(typeof persist, "function");
  const { db, check } = sharedMongoConnection(connection), plan = catalogPipelineSetupPlan();
  const names = [...Object.keys(createSharedMongoManifest("catalogPipeline").records), "assistanttestbudgets"];
  const before = {}, journal = { status: "preflight", plan, before, completed: [], pending: null };
  for (const name of names) {
    check(); const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).some((entry) => entry.name === name);
    if (Object.hasOwn(plan, name)) assert.equal(exists, false, `Setup refuses an existing target: ${name}`);
    else {
      assert.equal(exists, true, `Setup requires existing store: ${name}`);
      check(); before[name] = await db.collection(name).listIndexes().toArray();
    }
  }
  journal.status = "ready"; await persist(structuredClone(journal));
  const mutation = async (operation, action) => {
    journal.pending = operation; await persist(structuredClone(journal)); check();
    await action(); journal.completed.push(operation); journal.pending = null;
    await persist(structuredClone(journal));
  };
  for (const [name, indexes] of Object.entries(plan)) {
    check(); assert.deepEqual(await db.listCollections({ name }, { nameOnly: true }).toArray(), [], `Setup target appeared: ${name}`);
    await mutation({ method: "createCollection", collection: name }, () => db.createCollection(name, { writeConcern: { w: "majority" } }));
    check(); assert.equal(await db.collection(name).countDocuments({}, { maxTimeMS: 5000 }), 0);
    for (const { key, ...options } of indexes) {
      await mutation({ method: "createIndex", collection: name, name: options.name }, () => db.collection(name).createIndex(key, { ...options, writeConcern: { w: "majority" } }));
    }
  }
  for (const [name, expected] of Object.entries(before)) {
    check(); assert.deepEqual(sorted(await db.collection(name).listIndexes().toArray()), sorted(expected), `Existing indexes changed: ${name}`);
  }
  for (const [name, indexes] of Object.entries(plan)) {
    check(); assert.equal(await db.collection(name).countDocuments({}, { maxTimeMS: 5000 }), 0, `New store is not empty: ${name}`);
    check(); const actual = await db.collection(name).listIndexes().toArray();
    assert.equal(actual.length, indexes.length + 1);
    const supported = actual.map(({ key, name: indexName, unique, expireAfterSeconds, sparse, partialFilterExpression, collation, hidden }) => {
      assert.equal(sparse, undefined); assert.equal(partialFilterExpression, undefined); assert.equal(collation, undefined); assert.equal(hidden, undefined);
      return { key, name: indexName, ...(unique === undefined ? {} : { unique }), ...(expireAfterSeconds === undefined ? {} : { expireAfterSeconds }) };
    });
    assert.deepEqual(sorted(supported), sorted([{ key: { _id: 1 }, name: "_id_" }, ...indexes]));
  }
  journal.status = "verified_empty_stores_existing_indexes_unchanged"; await persist(structuredClone(journal));
  return journal;
}
