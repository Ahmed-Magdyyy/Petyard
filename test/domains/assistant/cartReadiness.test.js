import assert from "node:assert/strict";
import test from "node:test";
import { readCartReadiness, ownerTypesPipeline, duplicateOwnersPipeline } from "./fixtures/cartReadiness.js";

function fixture() {
  const indexes = { carts: [{ name: "_id_", key: { _id: 1 } }, { name: "user_1", key: { user: 1 } }] };
  const state = { indexes, types: [{ _id: "objectId", count: 3 }, { _id: "missing", count: 2 }], duplicates: [], calls: [],
    reads: 0, db: null };
  const db = { databaseName: "petyard", listCollections(filter, options) {
    assert.deepEqual(options, { nameOnly: false }); assert.ok(["carts", "assistantcartproposals", "assistantcartreceipts"].includes(filter.name));
    state.calls.push("listCollections"); state.reads++; state.onRead?.();
    return { toArray: async () => indexes[filter.name] ? [{ name: filter.name, type: "collection", options: {} }] : [] };
  }, collection(name) {
    assert.ok(Object.hasOwn(indexes, name));
    return { listIndexes() { state.calls.push("listIndexes"); return { toArray: async () => structuredClone(indexes[name]) }; },
      aggregate(pipeline, options) {
        assert.equal(name, "carts"); assert.deepEqual(options, { maxTimeMS: 5000, allowDiskUse: false, readConcern: { level: "majority" } });
        state.calls.push("aggregate");
        if (pipeline === ownerTypesPipeline) return { toArray: async () => state.types };
        assert.deepEqual(pipeline, duplicateOwnersPipeline); return { toArray: async () => state.duplicates };
      } };
  } };
  const client = { options: { srvHost: "magdy.pbupj.mongodb.net", dbName: "petyard" } };
  state.connection = { db, name: "petyard", readyState: 1, getClient: () => client }; state.db = db; return state;
}
test("readiness uses only bounded metadata/count reads and reports absent stores without creating them", async () => {
  const s = fixture(), result = await readCartReadiness(s.connection);
  assert.deepEqual(result.readiness, { cartUnique: false, proposalReady: false, receiptReady: false });
  assert.deepEqual(result.duplicateOwners, { owners: 0, carts: 0, extraCarts: 0 });
  assert.deepEqual(result.ownerTypes, [{ type: "objectId", count: 3 }, { type: "missing", count: 2 }]);
  assert.equal(s.calls.length, 10); assert.equal(result.dataWrites, 0); assert.equal(result.schemaWrites, 0);
});
test("compatible unique indexes and existing application stores report ready", async () => {
  const s = fixture(); s.indexes.carts.push({ name: "signed_in_unique", key: { user: 1 }, unique: true, partialFilterExpression: { user: { $type: "objectId" } } });
  s.indexes.assistantcartproposals = [{ name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true }];
  s.indexes.assistantcartreceipts = [{ name: "_id_", key: { _id: 1 } }];
  assert.deepEqual((await readCartReadiness(s.connection)).readiness, { cartUnique: true, proposalReady: true, receiptReady: true });
});
test("duplicate summary exposes only counts and invalid aggregate output is rejected", async () => {
  const s = fixture(); s.duplicates = [{ owners: 2, carts: 5, extraCarts: 3 }];
  assert.deepEqual((await readCartReadiness(s.connection)).duplicateOwners, s.duplicates[0]);
  s.duplicates[0].owner = "private-id"; await assert.rejects(readCartReadiness(s.connection));
  s.duplicates = []; s.types[0].count = -1; await assert.rejects(readCartReadiness(s.connection));
});
test("wrong target, changing metadata and missing cart store fail without mutation", async () => {
  const s = fixture(); s.connection.name = "other"; await assert.rejects(readCartReadiness(s.connection)); assert.equal(s.calls.length, 0);
  s.connection.name = "petyard"; s.onRead = () => { if (s.reads === 4) s.indexes.carts.push({ name: "changed", key: { x: 1 } }); };
  await assert.rejects(readCartReadiness(s.connection), /metadata changed/);
  const missing = fixture(); delete missing.indexes.carts; await assert.rejects(readCartReadiness(missing.connection), /cart collection required/);
});
test("TTL, sparse and incompatible partial indexes cannot claim application readiness", async () => {
  const s = fixture();
  s.indexes.carts = [{ name: "user_unique", key: { user: 1 }, unique: true, sparse: true }];
  s.indexes.assistantcartproposals = [{ name: "owner_key", key: { owner: 1, key: 1 }, unique: true, partialFilterExpression: { active: true } }];
  s.indexes.assistantcartreceipts = [{ name: "_id_", key: { _id: 1 } }, { name: "expiry", key: { recordedAt: 1 }, expireAfterSeconds: 10 }];
  assert.deepEqual((await readCartReadiness(s.connection)).readiness, { cartUnique: false, proposalReady: false, receiptReady: false });
});
