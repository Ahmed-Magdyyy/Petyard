import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { authorizedAssistantAtlasHost } from "./mongoTarget.js";
import { sharedMongoConnection } from "./sharedMongo.js";

export const cartSetupApproval = "create-two-empty-isolated-cart-test-stores";
export const cartStores = Object.freeze({ cart: "assistanttestcarts", receipt: "assistanttestcartreceipts" });
export const protectedCartStores = Object.freeze(["carts", "assistantcartproposals", "assistantcartreceipts"]);
export function cartSetupPlan() {
  return { [cartStores.cart]: [{ name: "user_1", key: { user: 1 }, unique: true,
    partialFilterExpression: { user: { $type: "objectId" } } }], [cartStores.receipt]: [] };
}
const sorted = (value) => [...value].sort((a, b) => a.name.localeCompare(b.name));
function verifyIndexes(actual, expected) {
  assert.deepEqual(sorted(actual.map(({ v, ...index }) => index)), sorted([{ name: "_id_", key: { _id: 1 } }, ...expected]));
}

// Setup is separate from the runner; partial failures retain their journal and are never repaired automatically.
export async function setupIsolatedCartStores(connection, approval, persist) {
  assert.equal(approval, cartSetupApproval); assert.equal(typeof persist, "function");
  const { db, check } = sharedMongoConnection(connection), plan = cartSetupPlan();
  const journal = { status: "preflight", host: authorizedAssistantAtlasHost, database: "petyard", plan,
    before: {}, completed: [], pending: null };
  const exists = async (name) => { check(); return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0; };
  for (const name of Object.keys(plan)) assert.equal(await exists(name), false, `Setup refuses existing target: ${name}`);
  for (const name of protectedCartStores) {
    journal.before[name] = await exists(name) ? await db.collection(name).listIndexes().toArray() : null;
  }
  journal.status = "ready"; await persist(structuredClone(journal));
  const mutate = async (operation, action) => {
    journal.pending = operation; await persist(structuredClone(journal)); check();
    await action(); journal.completed.push(operation); journal.pending = null; await persist(structuredClone(journal));
  };
  for (const [name, indexes] of Object.entries(plan)) {
    assert.equal(await exists(name), false, `Setup target appeared: ${name}`);
    await mutate({ method: "createCollection", collection: name }, () => db.createCollection(name, { writeConcern: { w: "majority" } }));
    check(); assert.equal(await db.collection(name).countDocuments({}, { maxTimeMS: 5000 }), 0);
    for (const { key, ...options } of indexes) await mutate({ method: "createIndex", collection: name, name: options.name },
      () => db.collection(name).createIndex(key, { ...options, writeConcern: { w: "majority" } }));
  }
  for (const [name, before] of Object.entries(journal.before)) {
    assert.equal(await exists(name), before !== null, `Protected store existence changed: ${name}`);
    if (before !== null) { check(); assert.deepEqual(sorted(await db.collection(name).listIndexes().toArray()), sorted(before)); }
  }
  for (const [name, indexes] of Object.entries(plan)) {
    check(); assert.equal(await db.collection(name).countDocuments({}, { maxTimeMS: 5000 }), 0);
    check(); verifyIndexes(await db.collection(name).listIndexes().toArray(), indexes);
  }
  journal.status = "verified_empty_stores_protected_indexes_unchanged"; await persist(structuredClone(journal));
  return journal;
}

export function createIsolatedCartManifest(suite = "persistence") {
  assert.ok(["persistence", "recovery"].includes(suite));
  const ids = (count) => Array.from({ length: count }, () => String(new mongoose.Types.ObjectId()));
  return { marker: `assistant_cart_${randomUUID()}`, host: authorizedAssistantAtlasHost, database: "petyard",
    ...(suite === "recovery" ? { suite } : {}),
    owners: ids(3), warehouse: ids(1)[0], product: ids(1)[0],
    records: { [cartStores.cart]: ids(suite === "recovery" ? 3 : 6), [cartStores.receipt]: ids(suite === "recovery" ? 4 : 3) } };
}
export function validateIsolatedCartManifest(manifest) {
  const value = structuredClone(manifest);
  assert.equal(value.host, authorizedAssistantAtlasHost); assert.equal(value.database, "petyard");
  assert.match(value.marker, /^assistant_cart_[a-f\d-]{36}$/);
  assert.ok(value.suite === undefined || value.suite === "recovery");
  assert.deepEqual(Object.keys(value.records).sort(), Object.values(cartStores).sort());
  assert.equal(value.owners.length, 3); assert.equal(value.records[cartStores.cart].length, value.suite === "recovery" ? 3 : 6);
  assert.equal(value.records[cartStores.receipt].length, value.suite === "recovery" ? 4 : 3);
  const all = [...value.owners, value.warehouse, value.product, ...Object.values(value.records).flat()];
  for (const id of all) { assert.equal(typeof id, "string"); assert.match(id, /^[a-f\d]{24}$/); }
  assert.equal(new Set(all).size, all.length); return value;
}

export function isolatedCartRecords(connection, manifest) {
  const scope = validateIsolatedCartManifest(manifest), { db, client, check } = sharedMongoConnection(connection);
  const collections = Object.fromEntries(Object.values(cartStores).map((name) => [name, db.collection(name)]));
  const ids = (name) => ({ _id: { $in: scope.records[name].map((id) => new mongoose.Types.ObjectId(id)) } });
  const owned = (name) => ({ ...ids(name), assistantTestRun: scope.marker });
  let armed = false;
  const ready = () => { check(); assert.ok(armed, "Prepare isolated cart records first"); };
  const registered = (name, value) => assert.ok(value instanceof mongoose.Types.ObjectId && scope.records[name].includes(String(value)), "Unregistered cart test ID");
  const validateRow = (name, row) => {
    registered(name, row._id); assert.equal(row.assistantTestRun, undefined);
    if (name === cartStores.cart) {
      if (row.user != null) { assert.ok(scope.owners.includes(String(row.user)), "Unregistered cart owner"); assert.equal(row.guestId, undefined); }
      else assert.ok([0, 1].some((index) => row.guestId === `${scope.marker}_guest_${index}`), "Unregistered guest cart");
      assert.equal(String(row.warehouse), scope.warehouse);
      assert.ok((row.items ?? []).every((item) => String(item.product) === scope.product), "Unregistered cart product");
    } else {
      assert.ok(scope.owners.includes(String(row.owner)), "Unregistered receipt owner"); registered(cartStores.cart, row.cartId);
    }
  };
  return {
    async prepare() {
      check(); assert.equal(armed, false);
      for (const [name, indexes] of Object.entries(cartSetupPlan())) {
        check(); assert.equal((await db.listCollections({ name }, { nameOnly: true }).toArray()).length, 1, "Cart test stores must already exist");
        check(); verifyIndexes(await collections[name].listIndexes().toArray(), indexes);
        check(); assert.equal(await collections[name].countDocuments(ids(name), { maxTimeMS: 5000 }), 0, "Registered test ID already exists");
      }
      check(); armed = true;
    },
    async insert(name, row) {
      ready(); validateRow(name, row);
      await collections[name].insertOne({ ...row, assistantTestRun: scope.marker }, { writeConcern: { w: "majority" } });
    },
    async read(name, id) {
      ready(); registered(name, id); return collections[name].findOne({ _id: id, assistantTestRun: scope.marker }, { maxTimeMS: 5000 });
    },
    async compete(id, kind) {
      ready(); assert.equal(scope.suite, "recovery"); registered(cartStores.cart, id);
      assert.ok(["checkout_context", "clear_items"].includes(kind));
      // Deliberately bypass __v, like existing scalar/query writers; fixture IDs and marker remain mandatory.
      const change = kind === "checkout_context" ? { checkoutKey: `${scope.marker}_changed`, deliveryAddress: { name: scope.marker } }
        : { items: [], totalCartPrice: 0 };
      const result = await collections[cartStores.cart].updateOne({ _id: id, assistantTestRun: scope.marker },
        { $set: change }, { writeConcern: { w: "majority" }, maxTimeMS: 5000 });
      assert.equal(result.matchedCount, 1); assert.equal(result.modifiedCount, 1);
    },
    install(t, { CartModel, AssistantCartReceipt }, hooks = {}) {
      ready();
      const methods = [...new Set(["indexes", ...Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Collection.prototype))
        .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function").map(([name]) => name)])];
      const targets = new Map([[CartModel, cartStores.cart], [AssistantCartReceipt, cartStores.receipt]]);
      const session = (options) => {
        ready(); assert.equal(options?.session?.client, client, "Cart operation requires this connected client's session");
        assert.equal(options.session.inTransaction(), true);
      };
      const refuse = () => { ready(); throw new Error("Unrelated model I/O or cart test DDL is forbidden"); };
      for (const Model of Object.values(mongoose.models)) {
        for (const method of ["createCollection", "createIndexes", "syncIndexes", "ensureIndexes"]) t.mock.method(Model, method, refuse);
        const name = targets.get(Model), destination = collections[name];
        for (const method of methods) {
          if (typeof Model.collection[method] !== "function") continue;
          if (!name || !["indexes", "findOne", "insertOne", "updateOne"].includes(method) || (name === cartStores.receipt && method === "updateOne")) {
            t.mock.method(Model.collection, method, refuse); continue;
          }
          if (method === "indexes") { t.mock.method(Model.collection, method, () => { ready(); return destination.indexes(); }); continue; }
          t.mock.method(Model.collection, method, async (filter, update, options) => {
            const opt = method === "updateOne" ? options : update; session(opt);
            if (method === "insertOne") {
              validateRow(name, filter);
              return destination.insertOne({ ...filter, assistantTestRun: scope.marker }, opt);
            }
            if (name === cartStores.cart) {
              if (filter.user !== undefined) assert.ok(scope.owners.includes(String(filter.user)), "Foreign cart owner refused");
              else registered(name, filter._id);
            }
            else { registered(name, filter._id); assert.ok(scope.owners.includes(String(filter.owner)), "Foreign receipt owner refused"); }
            const scoped = { $and: [filter, owned(name)] };
            if (method === "findOne") return destination.findOne(scoped, { ...opt, maxTimeMS: 5000 });
            registered(name, filter._id);
            assert.ok(Object.keys(update).every((key) => ["$set", "$unset", "$inc"].includes(key)));
            const writable = new Set(["items", "totalCartPrice", "warehouse", "checkoutKey", "status", "lastActivityAt", "updatedAt", "abandonedAt", "__v"]);
            for (const fields of Object.values(update)) assert.ok(Object.keys(fields).every((key) => writable.has(key) || key.startsWith("items.")));
            await hooks.beforeCartWrite?.(opt.session);
            return destination.updateOne(scoped, update, opt);
          });
        }
      }
    },
    async cleanup() {
      check(); if (!armed) return;
      const failures = [];
      for (const name of Object.values(cartStores).reverse()) {
        try {
          check(); await collections[name].deleteMany(owned(name), { writeConcern: { w: "majority" } });
          check(); assert.equal(await collections[name].findOne(ids(name), { projection: { _id: 1 }, maxTimeMS: 5000 }), null);
        } catch { failures.push(new Error(`Isolated cart cleanup failed for ${name}; retain the manifest`)); }
      }
      if (failures.length) throw new AggregateError(failures, "Isolated cart cleanup incomplete");
    },
  };
}

// Call on a fresh read-only connection after the runner disconnects; no deletion or schema repair.
export async function verifyIsolatedCartCleanup(connection, manifest, setupJournal) {
  const scope = validateIsolatedCartManifest(manifest), { db, check } = sharedMongoConnection(connection);
  assert.equal(setupJournal.host, scope.host); assert.equal(setupJournal.database, scope.database);
  assert.equal(setupJournal.status, "verified_empty_stores_protected_indexes_unchanged");
  assert.equal(setupJournal.pending, null); assert.deepEqual(setupJournal.plan, cartSetupPlan());
  assert.deepEqual(setupJournal.completed, [
    { method: "createCollection", collection: cartStores.cart },
    { method: "createIndex", collection: cartStores.cart, name: "user_1" },
    { method: "createCollection", collection: cartStores.receipt },
  ]);
  assert.deepEqual(Object.keys(setupJournal.before).sort(), [...protectedCartStores].sort());
  for (const [name, expected] of Object.entries(cartSetupPlan())) {
    check(); verifyIndexes(await db.collection(name).listIndexes().toArray(), expected);
    check(); assert.equal(await db.collection(name).findOne({ _id: { $in: scope.records[name].map((id) => new mongoose.Types.ObjectId(id)) } },
      { projection: { _id: 1 }, maxTimeMS: 5000 }), null, "Registered cart test IDs remain");
  }
  for (const [name, before] of Object.entries(setupJournal.before)) {
    check(); assert.equal((await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0, before !== null);
    if (before !== null) { check(); assert.deepEqual(sorted(await db.collection(name).listIndexes().toArray()), sorted(before)); }
  }
  return { status: "registered_ids_absent_isolated_and_protected_indexes_unchanged", marker: scope.marker,
    host: scope.host, database: scope.database, registeredIds: Object.values(scope.records).flat().length };
}
