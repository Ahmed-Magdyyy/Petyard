import assert from "node:assert/strict";
import test from "node:test";
import { ownerTypesPipeline } from "./fixtures/cartReadiness.js";
import { normalCartSetupApproval, setupNormalCartStores, verifyNormalCartStores, inspectNormalCartServer } from "./fixtures/normalCartSetup.js";

const baseline = { carts: { type: "collection", options: {}, indexes: [
  { key: { _id: 1 }, name: "_id_" }, { key: { checkoutKey: 1 }, name: "checkoutKey_1" },
  { key: { guestId: 1 }, name: "guestId_1" }, { key: { lastActivityAt: 1 }, name: "lastActivityAt_1" },
  { key: { status: 1 }, name: "status_1" }, { key: { status: 1, lastActivityAt: 1 }, name: "status_1_lastActivityAt_1" },
  { key: { user: 1 }, name: "user_1" }, { key: { warehouse: 1 }, name: "warehouse_1" },
] }, assistantcartproposals: null, assistantcartreceipts: null };

function fake() {
  const calls = [], journals = [], state = { stores: structuredClone(baseline), duplicates: [], types: [
    { type: "missing", count: 2 }, { type: "objectId", count: 3 },
  ], fail: null, hello: { isWritablePrimary: true, setName: "fixture", maxWireVersion: 25 }, build: { version: "8.0.15", versionArray: [8, 0, 15, 0] } };
  const connection = { name: "petyard", readyState: 1, getClient: () => client, db: { databaseName: "petyard",
    admin() { return { async command(command) {
      assert.equal(command.maxTimeMS, 5000);
      if (command.hello === 1) { assert.deepEqual(Object.keys(command).sort(), ["hello", "maxTimeMS"]); return state.hello; }
      assert.deepEqual(command, { buildInfo: 1, maxTimeMS: 5000 });
      if (state.buildError) throw state.buildError;
      return state.build;
    } }; },
    listCollections({ name }) { return { toArray: async () => state.stores[name] ? [{ name, ...structuredClone(state.stores[name]) }] : [] }; },
    collection(name) { return {
      listIndexes: () => ({ toArray: async () => structuredClone(state.stores[name]?.indexes ?? []) }),
      aggregate(pipeline, options) { assert.equal(name, "carts"); assert.equal(options.maxTimeMS, 5000);
        return { toArray: async () => pipeline === ownerTypesPipeline ? state.types.map(({ type, count }) => ({ _id: type, count })) : state.duplicates }; },
      async createIndex(key, options) { calls.push({ operation: "createIndex", name, key, options });
        if (state.fail === `${name}:createIndex`) throw new Error("Synthetic index failure");
        state.stores[name].indexes.push({ key: structuredClone(key), name: options.name, unique: options.unique,
          ...(options.partialFilterExpression ? { partialFilterExpression: structuredClone(options.partialFilterExpression) } : {}) });
        state.stores[name].indexes.sort((a, b) => a.name.localeCompare(b.name)); },
      async countDocuments(filter, options) { assert.deepEqual(filter, {}); assert.equal(options.maxTimeMS, 5000); return state.counts?.[name] ?? 0; },
    }; },
    async createCollection(name, options) { calls.push({ operation: "createCollection", name, options });
      if (state.fail === `${name}:createCollection`) throw new Error("Synthetic collection failure");
      state.stores[name] = { type: "collection", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }] }; state.afterCreate?.(name); },
  } };
  const client = { options: { srvHost: "magdy.pbupj.mongodb.net", dbName: "petyard" } };
  return { connection, calls, journals, state, persist: async (journal) => journals.push(structuredClone(journal)) };
}

test("setup performs exactly four journaled DDL operations and preserves the baseline cart metadata", async () => {
  const f = fake(), before = structuredClone(f.state.stores.carts);
  const journal = await setupNormalCartStores(f.connection, normalCartSetupApproval, baseline, f.persist);
  assert.deepEqual(f.calls.map(({ operation, name }) => `${operation}:${name}`), [
    "createIndex:carts", "createCollection:assistantcartproposals", "createIndex:assistantcartproposals", "createCollection:assistantcartreceipts",
  ]);
  assert.deepEqual(f.calls[0].key, { user: 1 }); assert.equal(f.calls[0].options.name, "assistant_signed_in_user_unique");
  assert.deepEqual(f.calls[0].options.partialFilterExpression, { user: { $type: "objectId" } });
  assert.deepEqual(f.state.stores.carts.options, before.options);
  for (const index of before.indexes) assert.ok(f.state.stores.carts.indexes.some((actual) => actual.name === index.name &&
    JSON.stringify(actual.key) === JSON.stringify(index.key)));
  assert.deepEqual(journal.completed, journal.plan); assert.equal(journal.pending, null);
  assert.equal(f.journals.filter((entry) => entry.pending !== null).length, 4);
  assert.deepEqual((await verifyNormalCartStores(f.connection, journal)).status, "normal_cart_stores_verified");
});

test("Atlas server preflight refuses old, sharded, nonprimary and unrecognized builds before DDL", async () => {
  for (const change of [
    (f) => { f.state.hello.maxWireVersion = 20; },
    (f) => { f.state.hello.msg = "isdbgrid"; },
    (f) => { delete f.state.hello.setName; },
    (f) => { f.state.hello.isWritablePrimary = false; },
    (f) => { f.state.build = { version: "6.0.15", versionArray: [6, 0, 15, 0] }; },
    (f) => { f.state.build.version = "8.0.0-rc1"; },
    (f) => { f.state.build.version = "8.0"; },
    (f) => { f.state.build.debug = true; },
    (f) => { f.state.build.versionArray[0] = 7; },
    (f) => { f.state.build.versionArray[3] = "unexpected"; },
    (f) => { f.state.build.versionArray[3] = -1; },
    (f) => { f.state.build.versionArray.push(0); },
    (f) => { delete f.state.build.versionArray; },
    (f) => { f.state.buildError = new Error("buildInfo denied"); },
  ]) {
    const f = fake(); change(f);
    await assert.rejects(setupNormalCartStores(f.connection, normalCartSetupApproval, baseline, f.persist));
    assert.equal(f.calls.length, 0); assert.equal(f.journals.length, 0);
  }
  const f = fake(); assert.deepEqual(await inspectNormalCartServer(f.connection), {
    maxWireVersion: 25, serverVersion: "8.0.15", writableReplicaSet: true, compatibilityCheck: "atlas-build-info-v2", featureCompatibilityVersionVerified: false,
  });
});

test("minimum released Atlas build is accepted without querying FCV and fresh verification detects server changes", async () => {
  const f = fake(); f.state.hello.maxWireVersion = 21; f.state.build = { version: "7.0.1", versionArray: [7, 0, 1, 0] };
  const journal = await setupNormalCartStores(f.connection, normalCartSetupApproval, baseline, f.persist);
  assert.equal(journal.server.featureCompatibilityVersionVerified, false);
  f.state.build = { version: "7.0.2", versionArray: [7, 0, 2, 0] };
  await assert.rejects(verifyNormalCartStores(f.connection, journal), /compatibility changed/);
});

test("preflight rejects wrong approval, unexpected baseline metadata, owner types, duplicates, and existing targets", async () => {
  for (const change of [
    (f) => { f.approval = "wrong"; },
    (f) => { f.expected = { ...baseline, carts: { ...baseline.carts, options: { capped: true } } }; },
    (f) => { f.state.types.push({ type: "string", count: 1 }); },
    (f) => { f.state.duplicates = [{ owners: 1, carts: 2, extraCarts: 1 }]; },
    (f) => { f.state.stores.assistantcartreceipts = { type: "collection", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }] }; },
  ]) {
    const f = fake(); change(f);
    await assert.rejects(setupNormalCartStores(f.connection, f.approval ?? normalCartSetupApproval, f.expected ?? baseline, f.persist));
    assert.equal(f.calls.length, 0);
  }
});

test("journal failure prevents DDL and a partial failure preserves pending state without cleanup", async () => {
  const failedJournal = fake(); failedJournal.persist = async () => { throw new Error("journal unavailable"); };
  await assert.rejects(setupNormalCartStores(failedJournal.connection, normalCartSetupApproval, baseline, failedJournal.persist));
  assert.equal(failedJournal.calls.length, 0);

  const partial = fake(); partial.state.fail = "assistantcartproposals:createIndex";
  await assert.rejects(setupNormalCartStores(partial.connection, normalCartSetupApproval, baseline, partial.persist), /Synthetic index failure/);
  assert.deepEqual(partial.journals.at(-1).completed, ["createIndex:carts:assistant_signed_in_user_unique", "createCollection:assistantcartproposals"]);
  assert.equal(partial.journals.at(-1).pending, "createIndex:assistantcartproposals:owner_1_key_1");
  assert.equal(partial.state.stores.assistantcartproposals.type, "collection");
  assert.equal(partial.calls.some(({ operation }) => operation === "drop"), false);
});

test("fresh verification rejects an incomplete or drifted schema journal", async () => {
  const f = fake(), journal = await setupNormalCartStores(f.connection, normalCartSetupApproval, baseline, f.persist);
  await assert.rejects(verifyNormalCartStores(f.connection, { ...journal, pending: journal.plan[0] }));
  f.state.stores.carts.options = { capped: true };
  await assert.rejects(verifyNormalCartStores(f.connection, journal));
});

test("pending-journal failure prevents the first mutation and newly populated stores stop later steps", async () => {
  const f = fake(); let snapshots = 0;
  await assert.rejects(setupNormalCartStores(f.connection, normalCartSetupApproval, baseline, async () => {
    if (++snapshots === 2) throw new Error("pending journal failed");
  }), /pending journal failed/);
  assert.equal(f.calls.length, 0);
  const populated = fake(); populated.state.afterCreate = (name) => { populated.state.counts = { [name]: 1 }; };
  await assert.rejects(setupNormalCartStores(populated.connection, normalCartSetupApproval, baseline, populated.persist), /must stay empty/);
  assert.equal(populated.calls.length, 2);
  assert.equal(populated.journals.at(-1).pending, "createCollection:assistantcartproposals");
});
