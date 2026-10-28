import assert from "node:assert/strict";
import mongoose from "mongoose";
import { sharedMongoConnection } from "./sharedMongo.js";
import { cartStores, validateIsolatedCartManifest } from "./isolatedCart.js";
import { ordinaryCartFilter } from "../../../../src/domains/cart/cart.bundle-compatibility.js";

export const ordinaryCartOptIn = "isolated-ordinary-cart-creation-only";
const oid = (value) => new mongoose.Types.ObjectId(value);
export function ordinaryWinner(CartModel, manifest, index) {
  validateIsolatedCartManifest(manifest); assert.equal(manifest.suite, undefined);
  assert.ok(Number.isInteger(index) && index >= 0 && index < 3);
  const doc = new CartModel({ _id: manifest.records[cartStores.cart][index], user: manifest.owners[index], warehouse: manifest.warehouse,
    checkoutKey: `${manifest.marker}_winner_${index}`, __v: 7,
    items: [{ product: manifest.product, productType: "SIMPLE", quantity: 3, itemPrice: 100,
      productName: "Synthetic toy", variantOptionsSnapshot: [] }], totalCartPrice: 300 });
  assert.equal(doc.validateSync(), undefined); return doc.toObject();
}

// Ordinary saves have no transaction session. All actual model I/O is redirected to registered isolated cart rows.
export function installOrdinaryCartBoundaries(t, connection, manifest, CartModel) {
  const scope = validateIsolatedCartManifest(manifest); assert.equal(scope.suite, undefined);
  const { db, client, check } = sharedMongoConnection(connection), destination = db.collection(cartStores.cart);
  const ids = scope.records[cartStores.cart], stats = Array.from({ length: 3 }, () => ({ lookups: 0, inserts: 0, duplicates: 0, updates: 0 }));
  let selected = -1;
  const current = () => { check(); assert.ok(selected >= 0 && selected < 3); return stats[selected]; };
  const owned = (id) => ({ _id: oid(id), user: oid(scope.owners[selected]), assistantTestRun: scope.marker });
  const refuse = () => { check(); throw new Error("Ordinary fixture refuses unrelated model I/O or DDL"); };
  const validateOptions = (options) => { assert.equal(options?.session, undefined); assert.notEqual(options?.upsert, true); };
  const scoped = (filter) => ({ $and: [filter, owned(ids[selected])] });
  const methods = [...new Set(["findOne", "insertOne", "updateOne", ...Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Collection.prototype))
    .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function").map(([name]) => name)])];
  const originalCollection = db.collection;
  t.mock.method(db, "collection", function (name, ...args) { check(); assert.ok(Object.values(cartStores).includes(name)); return originalCollection.call(this, name, ...args); });
  for (const [method, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(mongoose.mongo.Db.prototype))) {
    if (method !== "constructor" && method !== "collection" && typeof descriptor.value === "function" && typeof db[method] === "function") t.mock.method(db, method, refuse);
  }
  if (typeof client.db === "function") t.mock.method(client, "db", (name, ...args) => {
    check(); assert.ok(name === undefined || name === "petyard"); assert.equal(args.length, 0); return db;
  });
  for (const Model of Object.values(mongoose.models)) {
    for (const method of ["createCollection", "createIndexes", "syncIndexes", "ensureIndexes"]) if (typeof Model[method] === "function") t.mock.method(Model, method, refuse);
    for (const method of methods) {
      if (typeof Model.collection[method] !== "function") continue;
      if (Model !== CartModel || !["findOne", "insertOne", "updateOne"].includes(method)) { t.mock.method(Model.collection, method, refuse); continue; }
      if (method === "findOne") {
        t.mock.method(Model.collection, method, (filter, options) => {
          current().lookups++; validateOptions(options); assert.deepEqual(Object.keys(filter), ["user"]);
          assert.equal(String(filter.user), scope.owners[selected]);
          return destination.findOne(scoped(filter), { ...options, maxTimeMS: 5000 });
        }); continue;
      }
      if (method === "insertOne") {
        t.mock.method(Model.collection, method, async (row, options) => {
          const observed = current(); validateOptions(options); assert.equal(observed.inserts++, 0, "Only one losing create attempt per case");
          assert.equal(String(row._id), ids[selected + 3]); assert.equal(String(row.user), scope.owners[selected]);
          assert.equal(row.guestId, undefined); assert.equal(String(row.warehouse), scope.warehouse); assert.deepEqual(row.items, []);
          const winner = ordinaryWinner(CartModel, scope, selected);
          await destination.insertOne({ ...winner, assistantTestRun: scope.marker }, { writeConcern: { w: "majority" } });
          try { return await destination.insertOne({ ...row, assistantTestRun: scope.marker }, { ...options, writeConcern: { w: "majority" } }); }
          catch (error) {
            assert.equal(error.code, 11000); assert.deepEqual(error.keyPattern, { user: 1 }); assert.equal(String(error.keyValue.user), scope.owners[selected]);
            observed.duplicates++;
            if (selected === 2) {
              const removed = await destination.deleteOne(owned(ids[selected]), { writeConcern: { w: "majority" }, maxTimeMS: 5000 });
              assert.equal(removed.deletedCount, 1);
            }
            throw error;
          }
        }); continue;
      }
      t.mock.method(Model.collection, method, (filter, update, options) => {
        current().updates++; validateOptions(options); assert.equal(String(filter._id), ids[selected]);
        assert.ok(Object.keys(filter).every((key) => ["_id", "__v", "$and"].includes(key)));
        assert.ok(Array.isArray(filter.$and) && filter.$and.length > 0);
        for (const predicate of filter.$and) assert.deepEqual(predicate, ordinaryCartFilter({}).$and[0]);
        assert.ok(Object.keys(update).every((key) => ["$set", "$inc", "$unset"].includes(key)));
        const writable = ["items", "totalCartPrice", "warehouse", "checkoutKey", "status", "lastActivityAt", "updatedAt", "abandonedAt", "__v"];
        for (const fields of Object.values(update)) assert.ok(Object.keys(fields).every((key) => writable.includes(key) || key.startsWith("items.")));
        return destination.updateOne(scoped(filter), update, { ...options, writeConcern: { w: "majority" }, maxTimeMS: 5000 });
      });
    }
  }
  return { select(index) { assert.ok(Number.isInteger(index) && index >= 0 && index < 3); selected = index; }, stats,
    read() { current(); return destination.findOne(owned(ids[selected]), { maxTimeMS: 5000 }); } };
}
