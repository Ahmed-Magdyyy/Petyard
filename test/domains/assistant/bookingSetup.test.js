import assert from "node:assert/strict";
import test from "node:test";
import { setupBookingStores, verifyBookingStores, bookingSetupApproval, bookingSetupPlan } from "./fixtures/bookingSetup.js";

function fixture() {
  const base = indexes => ({ type: "collection", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }, ...indexes] });
  const s = { stores: {
    servicereservations: base([{ name: "user_start_unique", key: { user: 1, startsAt: 1 }, unique: true, partialFilterExpression: { status: "BOOKED" } }]),
    serviceslotinventories: base([{ name: "capacity_unique", key: { location: 1, roomType: 1, startsAt: 1 }, unique: true }]),
    notificationoutboxes: base([{ name: "dedupe", key: { dedupeKey: 1 }, unique: true }]),
    assistantbookingproposals: null, assistantbookingreceipts: null }, writes: [], journals: [], counts: {},
    hello: { isWritablePrimary: true, setName: "test-only", maxWireVersion: 25 },
    build: { version: "8.0.34", versionArray: [8, 0, 34, 0] } };
  s.before = structuredClone(s.stores);
  const db = { databaseName: "petyard", admin: () => ({ async command(command) { return command.hello ? s.hello : s.build; } }),
    listCollections: ({ name }) => ({ toArray: async () => s.stores[name] ? [{ name, ...structuredClone(s.stores[name]) }] : [] }),
    collection: name => ({ listIndexes: () => ({ toArray: async () => structuredClone(s.stores[name].indexes) }),
      countDocuments: async () => s.counts[name] ?? 0,
      async createIndex(key, options) {
        assert.ok(["assistantbookingproposals", "assistantbookingreceipts"].includes(name));
        assert.deepEqual(options.writeConcern, { w: "majority", wtimeoutMS: 10000 }); assert.equal(options.maxTimeMS, 30000);
        s.writes.push(["index", name, key, options]); if (s.failAt === s.writes.length) throw Error("injected DDL failure");
        const { writeConcern, maxTimeMS, ...definition } = options; s.stores[name].indexes.push({ key, ...definition }); s.afterDDL?.();
      } }),
    async createCollection(name, options) {
      assert.ok(["assistantbookingproposals", "assistantbookingreceipts"].includes(name)); assert.equal(s.stores[name], null);
      assert.deepEqual(options, { writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 30000 });
      s.writes.push(["collection", name]); if (s.failAt === s.writes.length) throw Error("injected DDL failure");
      s.stores[name] = base([]); s.afterDDL?.();
    } };
  const client = { options: { srvHost: "magdy.pbupj.mongodb.net", dbName: "petyard" } };
  s.connection = { db, readyState: 1, name: "petyard", getClient: () => client };
  s.persist = async journal => { s.beforePersist?.(journal); s.journals.push(structuredClone(journal)); };
  s.setup = () => setupBookingStores(s.connection, bookingSetupApproval, s.before, s.persist);
  return s;
}
test("approved setup performs exactly five additive schema steps, preserves ordinary metadata and verifies through a new connection", async () => {
  const s = fixture(), journal = await s.setup();
  assert.deepEqual(journal.completed, [...bookingSetupPlan]); assert.equal(journal.pending, null); assert.equal(s.writes.length, 5);
  for (const name of ["servicereservations", "serviceslotinventories", "notificationoutboxes"]) assert.deepEqual(s.stores[name], s.before[name]);
  const result = await verifyBookingStores({ ...s.connection }, journal);
  assert.equal(result.status, "empty_booking_stores_freshly_verified"); assert.equal(result.dataWrites, 0); assert.equal(result.activated, false);
  assert.equal(s.stores.assistantbookingproposals.indexes.length, 3); assert.equal(s.stores.assistantbookingreceipts.indexes.length, 2);
  assert.equal(s.journals.filter(row => row.pending).length, 5);
});
test("missing approval, invalid baseline, existing assistant stores and wrong target stop before any mutation", async () => {
  for (const mode of ["approval", "missing", "extra", "existing", "ordinary", "target"]) {
    const s = fixture(); let approved = bookingSetupApproval;
    if (mode === "approval") approved = "not-approved";
    if (mode === "missing") delete s.before.servicereservations;
    if (mode === "extra") s.before.carts = {};
    if (mode === "existing") s.before.assistantbookingreceipts = { type: "collection", options: {}, indexes: [] };
    if (mode === "ordinary") s.before.serviceslotinventories.indexes[1].unique = false;
    if (mode === "target") s.connection.name = "other";
    await assert.rejects(setupBookingStores(s.connection, approved, s.before, s.persist)); assert.equal(s.writes.length, 0, mode);
  }
});
test("actual metadata mismatch and unsupported server stop before writing or journaling readiness", async () => {
  for (const mode of ["metadata", "wire", "version", "router", "primary"]) {
    const s = fixture();
    if (mode === "metadata") s.stores.servicereservations.options.validator = { unexpected: true };
    if (mode === "wire") s.hello.maxWireVersion = 20;
    if (mode === "version") s.build.versionArray = [8, 0, 34];
    if (mode === "router") s.hello.msg = "isdbgrid";
    if (mode === "primary") s.hello.isWritablePrimary = false;
    await assert.rejects(s.setup()); assert.equal(s.writes.length, 0); assert.equal(s.journals.length, 0);
  }
});
test("each injected DDL failure retains a pending operation and stops without repair, retry or cleanup", async () => {
  for (const step of [1, 2, 3, 4, 5]) {
    const s = fixture(); s.failAt = step; await assert.rejects(s.setup(), /injected DDL failure/);
    assert.equal(s.writes.length, step); const last = s.journals.at(-1);
    assert.equal(last.pending, bookingSetupPlan[step - 1]); assert.equal(last.completed.length, step - 1);
    assert.equal(last.status, "ready"); assert.equal(s.writes.some(([operation]) => operation === "drop"), false);
  }
});
test("journal persistence failures before mutation stop that operation", async () => {
  for (const phase of ["ready", "pending"]) {
    const s = fixture(); s.beforePersist = journal => { if (phase === "ready" || journal.pending) throw Error("journal failure"); };
    await assert.rejects(s.setup(), /journal failure/); assert.equal(s.writes.length, 0);
  }
});
test("a new document, unexpected index or changed target after DDL prevents the next operation", async () => {
  for (const mode of ["document", "index", "target"]) {
    const s = fixture(); s.afterDDL = () => {
      if (mode === "document") s.counts.assistantbookingproposals = 1;
      if (mode === "index") s.stores.servicereservations.indexes.push({ name: "unexpected", key: { x: 1 } });
      if (mode === "target") s.connection.name = "other";
    };
    await assert.rejects(s.setup()); assert.equal(s.writes.length, 1); assert.equal(s.journals.at(-1).pending, bookingSetupPlan[0]);
  }
});
test("fresh verification rejects altered journal, server, contents and ordinary metadata without mutations", async () => {
  for (const mode of ["status", "plan", "pending", "completed", "expected", "before", "server", "document", "ordinary"]) {
    const s = fixture(), journal = await s.setup(); const beforeWrites = s.writes.length;
    if (mode === "status") journal.status = "ready";
    if (mode === "plan") journal.plan.reverse();
    if (mode === "pending") journal.pending = bookingSetupPlan[0];
    if (mode === "completed") journal.completed.pop();
    if (mode === "expected") journal.expected.assistantbookingreceipts.indexes.pop();
    if (mode === "before") journal.before.assistantbookingreceipts = {};
    if (mode === "server") s.build = { version: "8.0.35", versionArray: [8, 0, 35, 0] };
    if (mode === "document") s.counts.assistantbookingreceipts = 1;
    if (mode === "ordinary") s.stores.servicereservations.indexes.pop();
    await assert.rejects(verifyBookingStores({ ...s.connection }, journal)); assert.equal(s.writes.length, beforeWrites);
  }
});
