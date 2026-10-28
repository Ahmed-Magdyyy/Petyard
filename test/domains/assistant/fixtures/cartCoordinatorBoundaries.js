import assert from "node:assert/strict";
import mongoose from "mongoose";
import { sharedMongoConnection } from "./sharedMongo.js";
import { coordinatorCases } from "./cartCoordinator.js";

const oid = (value) => new mongoose.Types.ObjectId(value);
const methods = [...new Set(["indexes", "find", "findOne", "insertOne", "updateOne",
  ...Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Collection.prototype))
    .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function").map(([name]) => name)])];

// Native model I/O stays in registered fixture rows; only initializer DDL is replaced with no-ops.
export function installCoordinatorBoundaries(t, connection, manifest, models, initializerModels, hooks = {}) {
  const { db, client, check } = sharedMongoConnection(connection);
  const rows = structuredClone(manifest.records), marker = manifest.marker;
  const collections = Object.fromEntries(Object.keys(rows).map((name) => [name, db.collection(name)]));
  const target = new Map(Object.entries(models).map(([name, Model]) => [Model, name]));
  const refuse = () => { check(); throw new Error("Unregistered coordinator model I/O or DDL refused"); };
  const registered = (name, value) => assert.ok(rows[name].includes(String(value)), "Unregistered coordinator ID");
  const session = (options) => { check(); assert.equal(options?.session?.client, client); assert.equal(options.session.inTransaction(), true); };
  const scope = (name, filter) => ({ $and: [filter, { _id: { $in: rows[name].map(oid) }, assistantTestRun: marker }] });
  const validateFilter = (name, filter) => {
    assert.ok(filter && typeof filter === "object" && !Array.isArray(filter));
    for (const [key, value] of Object.entries(filter)) {
      if (key === "$and" || key === "$or") { assert.ok(Array.isArray(value)); for (const part of value) validateFilter(name, part); }
      else if (key === "_id") {
        const values = value && value.constructor === Object ? (assert.deepEqual(Object.keys(value), ["$in"]), value.$in) : [value];
        assert.ok(Array.isArray(values)); for (const id of values) registered(name, id);
      } else if (["owner", "petOwner", "user"].includes(key)) registered("users", value?.constructor === Object && Object.hasOwn(value, "$eq") ? value.$eq : value);
    }
  };
  const originalCollection = db.collection;
  t.mock.method(db, "collection", function (name, ...args) { check(); assert.ok(Object.hasOwn(rows, name)); return originalCollection.call(this, name, ...args); });
  for (const [method, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Db.prototype))) {
    if (method !== "constructor" && !["collection", "admin"].includes(method) && typeof descriptor.value === "function" && typeof db[method] === "function") t.mock.method(db, method, refuse);
  }
  if (typeof client.db === "function") t.mock.method(client, "db", (name, ...args) => {
    check(); assert.ok(name === undefined || name === "petyard"); assert.equal(args.length, 0); return db;
  });
  const admin = db.admin(); const command = admin.command.bind(admin);
  t.mock.method(db, "admin", () => admin);
  t.mock.method(admin, "command", (value, options) => { check(); assert.deepEqual(value, { hello: 1 }); return command(value, options); });
  for (const [method, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Admin.prototype))) {
    if (method !== "constructor" && method !== "command" && typeof descriptor.value === "function" && typeof admin[method] === "function") t.mock.method(admin, method, refuse);
  }
  for (const Model of Object.values(mongoose.models)) {
    for (const method of ["createCollection", "createIndexes", "syncIndexes", "ensureIndexes"]) if (typeof Model[method] === "function") {
      t.mock.method(Model, method, initializerModels.includes(Model) && ["createCollection", "createIndexes"].includes(method) ? async () => { check(); } : refuse);
    }
    const name = target.get(Model), destination = collections[name];
    for (const method of methods) {
      if (typeof Model.collection[method] !== "function") continue;
      if (!name || !["indexes", "find", "findOne", "updateOne", "insertOne"].includes(method)) { t.mock.method(Model.collection, method, refuse); continue; }
      if (method === "indexes") {
        t.mock.method(Model.collection, method, () => { check(); assert.ok(name.startsWith("assistanttestcart")); return destination.indexes(); }); continue;
      }
      if (["find", "findOne"].includes(method)) {
        t.mock.method(Model.collection, method, (filter, options = {}) => {
          check(); validateFilter(name, filter); if (options.session) session(options);
          return destination[method](scope(name, filter), { ...options, maxTimeMS: 5000 });
        }); continue;
      }
      if (method === "insertOne") {
        t.mock.method(Model.collection, method, async (row, options) => {
          session(options); assert.equal(name, "assistanttestcartreceipts"); registered(name, row._id);
          const index = rows[name].indexOf(String(row._id));
          assert.equal(String(row.owner), rows.users[index]); assert.equal(String(row.cartId), rows.assistanttestcarts[index]);
          await hooks.beforeReceipt?.(index);
          return destination.insertOne({ ...row, assistantTestRun: marker }, options);
        }); continue;
      }
      t.mock.method(Model.collection, method, async (filter, update, options) => {
        session(options); assert.notEqual(options.upsert, true); validateFilter(name, filter); registered(name, filter._id);
        if (["users", "assistantaccounts", "assistantchats", "pets"].includes(name)) {
          assert.deepEqual(update, { $inc: { __v: 1 } }); await hooks.beforeFence?.(name, String(filter._id));
        } else {
          assert.equal(name, "assistanttestcarts");
          assert.ok(filter.$expr, "Native cart write must retain its raw preimage predicate");
          for (const [operator, fields] of Object.entries(update)) {
            assert.ok(["$set", "$inc", "$unset"].includes(operator));
            assert.ok(Object.keys(fields).every((key) => ["items", "totalCartPrice", "warehouse", "checkoutKey", "status", "lastActivityAt", "updatedAt", "abandonedAt", "__v"].includes(key)));
          }
        }
        return destination.updateOne(scope(name, filter), update, options);
      });
    }
  }
  const owned = (name, index) => ({ _id: oid(rows[name][index]), assistantTestRun: marker });
  return {
    async read(name, index) { check(); return collections[name].findOne(owned(name, index), { maxTimeMS: 5000 }); },
    async compete(index) {
      check(); assert.ok(Number.isInteger(index) && index > 0 && index < 6);
      const change = coordinatorCases[index];
      const [name, update] = change === "user_deactivated" ? ["users", { $set: { active: false } }]
        : change === "account_blocked" ? ["assistantaccounts", { $set: { blocked: true } }]
        : change === "chat_changed" ? ["assistantchats", { $set: { activeSubject: null }, $inc: { contextVersion: 1 } }]
        : change === "pet_changed" ? ["pets", { $set: { chronic_conditions: ["Fixture dietary condition"] } }]
        : ["assistantchats", { $inc: { contextVersion: 1 } }];
      const apply = async (options = {}) => {
        check();
        if (change === "warning_added") {
          const warning = new models.assistantdietarywarnings({ _id: oid(rows.assistantdietarywarnings[0]), owner: oid(rows.users[index]),
            subjectId: `pet:${rows.pets[index]}`, sourceMessage: oid(rows.assistantmessages[index]), state: "active", version: 1,
            source: "chat", reportedAt: new Date(), text: "Fixture existing chicken allergy" });
          assert.equal(warning.validateSync(), undefined);
          await collections.assistantdietarywarnings.insertOne({ ...warning.toObject(), assistantTestRun: marker }, options);
        }
        const result = await collections[name].updateOne(owned(name, index), update, options);
        assert.equal(result.matchedCount, 1); assert.equal(result.modifiedCount, 1);
      };
      if (change !== "warning_added") return apply({ writeConcern: { w: "majority" }, maxTimeMS: 5000 });
      const native = client.startSession();
      try { await native.withTransaction(() => apply({ session: native }), { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" }, timeoutMS: 15000 }); }
      finally { await native.endSession(); }
    },
  };
}
