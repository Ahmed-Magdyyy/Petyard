import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { AssistantCartReceipt } from "../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { cartSetupApproval, cartSetupPlan, cartStores, protectedCartStores, setupIsolatedCartStores,
  createIsolatedCartManifest, validateIsolatedCartManifest, isolatedCartRecords, verifyIsolatedCartCleanup } from "./fixtures/isolatedCart.js";

const oid = (id) => new mongoose.Types.ObjectId(id);
function fixture({ prepared = false, suite } = {}) {
  const manifest = createIsolatedCartManifest(suite), plan = cartSetupPlan(), calls = [], journal = [], fail = {};
  const data = Object.fromEntries(protectedCartStores.map((name) => [name, { indexes: [{ v: 2, name: "_id_", key: { _id: 1 } }], rows: [] }]));
  if (prepared) for (const [name, indexes] of Object.entries(plan)) data[name] = {
    indexes: [{ v: 2, name: "_id_", key: { _id: 1 } }, ...structuredClone(indexes)], rows: [] };
  const client = { options: { srvHost: manifest.host, dbName: "petyard" } };
  const connection = { name: "petyard", readyState: 1, getClient: () => client, db: { databaseName: "petyard",
    listCollections({ name }) { calls.push({ method: "list", name }); return { async toArray() { return data[name] ? [{ name }] : []; } }; },
    async createCollection(name, options) {
      calls.push({ method: "createCollection", name, options }); assert.ok(Object.hasOwn(plan, name)); assert.equal(data[name], undefined);
      data[name] = { indexes: [{ v: 2, name: "_id_", key: { _id: 1 } }], rows: [] };
    },
    collection(name) { return {
      listIndexes() { return { async toArray() { return structuredClone(data[name].indexes); } }; },
      async indexes() { return structuredClone(data[name].indexes); },
      async createIndex(key, { writeConcern, ...options }) {
        calls.push({ method: "createIndex", name, key, options }); assert.ok(Object.hasOwn(plan, name));
        assert.deepEqual(writeConcern, { w: "majority" }); if (fail.index) throw new Error("Synthetic index failure");
        data[name].indexes.push({ v: 2, key, ...options });
      },
      async countDocuments(filter) { return Object.keys(filter).length ? data[name].rows.length : fail.nonempty ? 1 : 0; },
      async findOne(filter, options) { calls.push({ method: "findOne", name, filter, options }); return fail.leftover ? { _id: "leftover" } : null; },
      async insertOne(document, options) { calls.push({ method: "insertOne", name, document, options }); data[name].rows.push(document); return { insertedId: document._id }; },
      async updateOne(filter, update, options) { calls.push({ method: "updateOne", name, filter, update, options });
        return { matchedCount: fail.updateMissing ? 0 : 1, modifiedCount: fail.updateMissing ? 0 : 1 }; },
      async deleteMany(filter, options) { calls.push({ method: "deleteMany", name, filter, options }); if (fail.delete === name) throw new Error("Synthetic cleanup failure"); return { deletedCount: 0 }; },
    }; },
  } };
  return { manifest, connection, client, calls, journal, data, fail, persist: async (value) => journal.push(value) };
}

test("offline setup creates only two empty isolated stores and one guest-compatible unique index", async (t) => {
  t.mock.method(mongoose, "connect", () => assert.fail("Offline check must not connect"));
  const f = fixture(), before = structuredClone(f.data);
  const result = await setupIsolatedCartStores(f.connection, cartSetupApproval, f.persist);
  assert.equal(result.status, "verified_empty_stores_protected_indexes_unchanged");
  assert.equal(result.completed.length, 3); assert.equal(result.pending, null);
  assert.deepEqual(f.calls.filter((call) => call.method === "createCollection").map((call) => call.name), Object.values(cartStores));
  assert.deepEqual(f.calls.filter((call) => call.method === "createIndex").map(({ name, key, options }) => ({ name, key, options })), [
    { name: cartStores.cart, key: { user: 1 }, options: { name: "user_1", unique: true, partialFilterExpression: { user: { $type: "objectId" } } } }]);
  for (const name of protectedCartStores) assert.deepEqual(f.data[name], before[name]);
  assert.deepEqual(f.journal[1].pending, { method: "createCollection", collection: cartStores.cart });
  assert.equal(CartModel.schema.indexes().some(([key, options]) => key.user && options.unique), false);
});

test("setup refuses wrong approval/target, existing targets and failed journal before any mutation", async () => {
  for (const change of [
    (f) => { f.approval = "wrong"; }, (f) => { f.connection.name = "other"; },
    (f) => { f.client.options.srvHost = "other.invalid"; },
    (f) => { f.data[cartStores.cart] = { indexes: [], rows: [] }; },
    (f) => { f.persist = async () => { throw new Error("Journal unavailable"); }; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(setupIsolatedCartStores(f.connection, f.approval ?? cartSetupApproval, f.persist));
    assert.equal(f.calls.some(({ method }) => method.startsWith("create")), false);
  }
});

test("setup retains pending failed operation without repairing, deleting or continuing", async () => {
  const f = fixture(); f.fail.index = true;
  await assert.rejects(setupIsolatedCartStores(f.connection, cartSetupApproval, f.persist), /Synthetic index failure/);
  assert.deepEqual(f.journal.at(-1).pending, { method: "createIndex", collection: cartStores.cart, name: "user_1" });
  assert.equal(f.journal.at(-1).completed.length, 1); assert.equal(f.data[cartStores.receipt], undefined);
});

test("setup rechecks the target after journaling and refuses unexpected nonempty stores", async () => {
  const f = fixture();
  await assert.rejects(setupIsolatedCartStores(f.connection, cartSetupApproval, async (value) => {
    if (value.pending) f.connection.readyState = 0;
  }));
  assert.equal(f.calls.some(({ method }) => method.startsWith("create")), false);
  const g = fixture(); g.fail.nonempty = true;
  await assert.rejects(setupIsolatedCartStores(g.connection, cartSetupApproval, g.persist));
  assert.equal(g.calls.some(({ method }) => method === "createIndex"), false);
});

test("setup preserves an absent normal proposal/receipt store rather than creating it", async () => {
  const f = fixture(); delete f.data.assistantcartproposals; delete f.data.assistantcartreceipts;
  const result = await setupIsolatedCartStores(f.connection, cartSetupApproval, f.persist);
  assert.equal(result.before.assistantcartproposals, null); assert.equal(result.before.assistantcartreceipts, null);
  assert.equal(f.data.assistantcartproposals, undefined); assert.equal(f.data.assistantcartreceipts, undefined);
});

test("manifests have exact isolated stores and unique preregistered IDs", () => {
  const first = createIsolatedCartManifest(), second = createIsolatedCartManifest();
  assert.deepEqual(validateIsolatedCartManifest(first), first); assert.notEqual(first.marker, second.marker);
  for (const change of [
    (m) => { m.database = "other"; }, (m) => { m.records.carts = []; },
    (m) => { m.owners[0] = m.product; }, (m) => { m.records[cartStores.cart].pop(); },
  ]) { const changed = structuredClone(first); change(changed); assert.throws(() => validateIsolatedCartManifest(changed)); }
});

test("runner preparation requires exact stores/indexes and absent IDs without DDL", async () => {
  for (const change of [
    (f) => { delete f.data[cartStores.cart]; },
    (f) => { f.data[cartStores.cart].indexes[1].unique = false; },
    (f) => { delete f.data[cartStores.cart].indexes[1].partialFilterExpression; },
    (f) => { f.data[cartStores.receipt].indexes.push({ name: "expiry", key: { recordedAt: 1 }, expireAfterSeconds: 0 }); },
    (f) => { f.data[cartStores.cart].rows.push({}); },
  ]) {
    const f = fixture({ prepared: true }); change(f);
    await assert.rejects(isolatedCartRecords(f.connection, f.manifest).prepare());
    assert.equal(f.calls.some(({ method }) => method.startsWith("create") || method === "insertOne"), false);
  }
});

test("seed and cleanup require registered IDs, exact marker and unchanged target", async () => {
  const f = fixture({ prepared: true }), records = isolatedCartRecords(f.connection, f.manifest);
  await assert.rejects(records.insert(cartStores.cart, { _id: oid(f.manifest.records[cartStores.cart][0]) }));
  await records.prepare();
  await assert.rejects(records.insert(cartStores.cart, { _id: new mongoose.Types.ObjectId() }));
  const row = { _id: oid(f.manifest.records[cartStores.cart][0]), user: oid(f.manifest.owners[0]), warehouse: oid(f.manifest.warehouse) };
  await assert.rejects(records.insert(cartStores.cart, { ...row, user: new mongoose.Types.ObjectId() }));
  await assert.rejects(records.insert(cartStores.cart, { ...row, user: undefined, guestId: "foreign-guest" }));
  await assert.rejects(records.insert(cartStores.cart, { ...row, warehouse: new mongoose.Types.ObjectId() }));
  await assert.rejects(records.insert(cartStores.receipt, { _id: oid(f.manifest.records[cartStores.receipt][0]),
    owner: new mongoose.Types.ObjectId(), cartId: row._id }));
  assert.equal(f.calls.some(({ method }) => method === "insertOne"), false);
  await records.insert(cartStores.cart, row);
  assert.equal(f.calls.find(({ method }) => method === "insertOne").document.assistantTestRun, f.manifest.marker);
  await records.cleanup();
  for (const call of f.calls.filter(({ method }) => method === "deleteMany")) {
    assert.equal(call.filter.assistantTestRun, f.manifest.marker);
    assert.deepEqual(call.filter._id.$in.map(String), f.manifest.records[call.name]);
    assert.deepEqual(call.options, { writeConcern: { w: "majority" } });
  }
  f.connection.readyState = 0; await assert.rejects(records.cleanup());
});

test("cleanup attempts both stores and fails if deletion fails or any registered ID remains", async () => {
  for (const failure of ["delete", "leftover"]) {
    const f = fixture({ prepared: true }), records = isolatedCartRecords(f.connection, f.manifest); await records.prepare();
    f.fail[failure] = failure === "delete" ? cartStores.receipt : true;
    await assert.rejects(records.cleanup(), AggregateError);
    assert.equal(f.calls.filter(({ method }) => method === "deleteMany").length, 2);
  }
});

test("native adapters redirect to isolated stores, retain session/preimage and refuse foreign/unsafe operations", async (t) => {
  const f = fixture({ prepared: true }), records = isolatedCartRecords(f.connection, f.manifest); await records.prepare();
  records.install(t, { CartModel, AssistantCartReceipt });
  const session = { client: f.client, inTransaction: () => true }, owner = oid(f.manifest.owners[0]);
  const id = oid(f.manifest.records[cartStores.cart][0]);
  await CartModel.collection.findOne({ user: owner }, { session });
  const read = f.calls.at(-1); assert.equal(read.name, cartStores.cart); assert.equal(read.options.session, session);
  assert.equal(read.filter.$and[1].assistantTestRun, f.manifest.marker);
  const filter = { _id: id, __v: 7, $expr: { $eq: ["$$ROOT", { $literal: { _id: id } }] } };
  await CartModel.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  assert.deepEqual(f.calls.at(-1).filter.$and[0], filter);
  await assert.rejects(CartModel.collection.findOne({ user: new mongoose.Types.ObjectId() }, { session }));
  await assert.rejects(CartModel.collection.findOne({ user: owner }, { session: { ...session, client: {} } }));
  await assert.rejects(CartModel.collection.updateOne(filter, { $set: { assistantTestRun: "other" } }, { session }));
  await assert.rejects(CartModel.collection.insertOne({ _id: new mongoose.Types.ObjectId(), user: owner }, { session }));
  const receipt = { _id: oid(f.manifest.records[cartStores.receipt][0]), owner, cartId: id };
  await AssistantCartReceipt.collection.insertOne(receipt, { session });
  assert.equal(f.calls.at(-1).name, cartStores.receipt); assert.equal(f.calls.at(-1).document.assistantTestRun, f.manifest.marker);
  await assert.rejects(AssistantCartReceipt.collection.insertOne({ ...receipt, owner: new mongoose.Types.ObjectId() }, { session }));
  assert.throws(() => ProductModel.collection.findOne({}));
  assert.throws(() => CartModel.collection.deleteMany({}));
  assert.throws(() => CartModel.createCollection());
});

test("fresh cleanup verification is read-only and detects leftovers and protected index changes", async () => {
  const f = fixture();
  const journal = await setupIsolatedCartStores(f.connection, cartSetupApproval, f.persist);
  f.calls.length = 0;
  const result = await verifyIsolatedCartCleanup(f.connection, f.manifest, journal);
  assert.equal(result.registeredIds, 9); assert.equal(result.status, "registered_ids_absent_isolated_and_protected_indexes_unchanged");
  assert.equal(f.calls.some(({ method }) => ["insertOne", "updateOne", "deleteMany", "createIndex", "createCollection"].includes(method)), false);
  await assert.rejects(verifyIsolatedCartCleanup(f.connection, f.manifest, { ...journal, completed: [] }));
  for (const call of f.calls.filter(({ method }) => method === "findOne")) {
    assert.equal(call.filter.assistantTestRun, undefined, "Verification must detect unowned registered IDs too");
    assert.deepEqual(call.filter._id.$in.map(String), f.manifest.records[call.name]);
  }
  f.fail.leftover = true; await assert.rejects(verifyIsolatedCartCleanup(f.connection, f.manifest, journal));
  f.fail.leftover = false; f.data.carts.indexes.push({ name: "unexpected", key: { user: 1 }, unique: true });
  await assert.rejects(verifyIsolatedCartCleanup(f.connection, f.manifest, journal));
});

test("recovery profile registers exactly three cart and four receipt IDs without altering the older profile", () => {
  const old = createIsolatedCartManifest(), recovery = createIsolatedCartManifest("recovery");
  assert.equal(old.suite, undefined); assert.equal(old.records[cartStores.cart].length, 6); assert.equal(old.records[cartStores.receipt].length, 3);
  assert.equal(recovery.suite, "recovery"); assert.equal(recovery.records[cartStores.cart].length, 3); assert.equal(recovery.records[cartStores.receipt].length, 4);
  assert.deepEqual(validateIsolatedCartManifest(recovery), recovery);
  for (const change of [(m) => { m.suite = "unbounded"; }, (m) => { delete m.suite; },
    (m) => { m.records[cartStores.receipt].push(String(new mongoose.Types.ObjectId())); }]) {
    const copy = structuredClone(recovery); change(copy); assert.throws(() => validateIsolatedCartManifest(copy));
  }
  assert.throws(() => createIsolatedCartManifest("unbounded"));
});

test("recovery competitors permit only fixed synthetic context/clear updates to registered marked cart IDs", async () => {
  const f = fixture({ prepared: true, suite: "recovery" }), records = isolatedCartRecords(f.connection, f.manifest);
  const id = oid(f.manifest.records[cartStores.cart][0]);
  await assert.rejects(records.compete(id, "clear_items")); await records.prepare();
  await assert.rejects(records.compete(new mongoose.Types.ObjectId(), "clear_items"));
  await assert.rejects(records.compete(id, "other"));
  assert.equal(f.calls.some((call) => call.method === "updateOne"), false);
  await records.compete(id, "checkout_context");
  await records.compete(id, "clear_items");
  const updates = f.calls.filter((call) => call.method === "updateOne");
  assert.equal(updates.length, 2);
  for (const call of updates) {
    assert.equal(call.name, cartStores.cart); assert.deepEqual(call.filter, { _id: id, assistantTestRun: f.manifest.marker });
    assert.deepEqual(call.options, { writeConcern: { w: "majority" }, maxTimeMS: 5000 }); assert.equal(call.update.$inc, undefined);
    assert.equal(call.update.$set.__v, undefined);
  }
  assert.deepEqual(updates[0].update.$set, { checkoutKey: `${f.manifest.marker}_changed`, deliveryAddress: { name: f.manifest.marker } });
  assert.deepEqual(updates[1].update.$set, { items: [], totalCartPrice: 0 });
  f.fail.updateMissing = true; await assert.rejects(records.compete(id, "clear_items"));
  f.connection.readyState = 0; const count = f.calls.length;
  await assert.rejects(records.compete(id, "clear_items")); assert.equal(f.calls.length, count);
});

test("older persistence scope cannot perform recovery competitor updates and recovery cleanup stays bounded", async () => {
  const old = fixture({ prepared: true }), older = isolatedCartRecords(old.connection, old.manifest); await older.prepare();
  await assert.rejects(older.compete(oid(old.manifest.records[cartStores.cart][0]), "clear_items"));
  assert.equal(old.calls.some((call) => call.method === "updateOne"), false);
  const f = fixture({ prepared: true, suite: "recovery" }), records = isolatedCartRecords(f.connection, f.manifest); await records.prepare();
  await records.cleanup();
  const deletes = f.calls.filter((call) => call.method === "deleteMany"); assert.equal(deletes.length, 2);
  for (const call of deletes) {
    assert.equal(call.filter.assistantTestRun, f.manifest.marker);
    assert.deepEqual(call.filter._id.$in.map(String), f.manifest.records[call.name]);
  }
});

test("fresh recovery verification checks all seven IDs and exact existing indexes without mutation", async () => {
  const f = fixture({ suite: "recovery" });
  const journal = await setupIsolatedCartStores(f.connection, cartSetupApproval, f.persist); f.calls.length = 0;
  const result = await verifyIsolatedCartCleanup(f.connection, f.manifest, journal);
  assert.equal(result.registeredIds, 7); assert.equal(f.calls.some((call) => ["insertOne", "updateOne", "deleteMany", "createCollection", "createIndex"].includes(call.method)), false);
  f.fail.leftover = true; await assert.rejects(verifyIsolatedCartCleanup(f.connection, f.manifest, journal));
});
