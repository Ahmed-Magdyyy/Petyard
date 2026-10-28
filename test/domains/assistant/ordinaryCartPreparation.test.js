import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { getCartService, upsertCartItemService } from "../../../src/domains/cart/cart.service.js";
import { createIsolatedCartManifest, cartStores } from "./fixtures/isolatedCart.js";
import { installOrdinaryCartBoundaries, ordinaryWinner } from "./fixtures/ordinaryCart.js";

const clone = (value) => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize({ value })).value;
function fixture(t) {
  const manifest = createIsolatedCartManifest(), rows = [], calls = [], errors = [];
  const destination = {
    async findOne(filter) {
      calls.push("findOne"); const [input, owned] = filter.$and ?? [filter, filter];
      return clone(rows.find((row) => String(row._id) === String(owned._id) && String(row.user) === String(owned.user) &&
        row.assistantTestRun === owned.assistantTestRun && (!input.user || String(row.user) === String(input.user))) ?? null);
    },
    async insertOne(row) {
      calls.push("insertOne");
      if (rows.some((existing) => String(existing.user) === String(row.user))) {
        const error = Object.assign(new Error("simulated native owner conflict"), { code: 11000, keyPattern: { user: 1 }, keyValue: { user: row.user } });
        errors.push(error); throw error;
      }
      rows.push(clone(row)); return { acknowledged: true, insertedId: row._id };
    },
    async updateOne(filter, update) {
      calls.push("updateOne"); const [input, owned] = filter.$and;
      const row = rows.find((candidate) => String(candidate._id) === String(owned._id) && candidate.assistantTestRun === owned.assistantTestRun);
      assert.ok(row); if (input.__v !== undefined) assert.equal(row.__v, input.__v);
      for (const [operator, fields] of Object.entries(update)) for (const [key, value] of Object.entries(fields)) {
        const parts = key.split("."), leaf = parts.pop(); let target = row;
        for (const part of parts) target = target[part] ??= {};
        if (operator === "$unset") delete target[leaf];
        else target[leaf] = operator === "$inc" ? (target[leaf] ?? 0) + value : clone(value);
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      calls.push("deleteOne"); const index = rows.findIndex((row) => String(row._id) === String(filter._id) && row.assistantTestRun === filter.assistantTestRun);
      assert.ok(index >= 0); rows.splice(index, 1); return { acknowledged: true, deletedCount: 1 };
    },
  };
  const db = { databaseName: "petyard", collection(name) { assert.equal(name, cartStores.cart); return destination; },
    createCollection() { assert.fail("no DDL"); }, admin() { assert.fail("no admin"); } };
  const client = { options: { srvHost: manifest.host, dbName: "petyard" }, db() { assert.fail("unexpected original client.db"); } };
  const connection = { db, name: "petyard", readyState: 1, getClient: () => client };
  const boundary = installOrdinaryCartBoundaries(t, connection, manifest, CartModel);
  const product = { _id: manifest.product, type: "SIMPLE", isActive: true, price: 100, name_en: "Synthetic toy", images: [],
    warehouseStocks: [{ warehouse: manifest.warehouse, quantity: 10 }] };
  const query = (value) => ({ select() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(ProductModel, "findById", () => query(product)); t.mock.method(ProductModel, "find", () => query([product]));
  t.mock.method(WarehouseModel, "findById", () => query({ _id: manifest.warehouse, active: true }));
  t.mock.method(CollectionModel, "findOne", () => query(null)); t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true }));
  let selected;
  const root = CartModel.schema.path("_id"), originalDefault = root.defaultValue;
  root.default(() => new mongoose.Types.ObjectId(manifest.records[cartStores.cart][selected + 3]));
  t.after(() => { root.defaultValue = originalDefault; });
  return { manifest, boundary, rows, calls, errors, db, client, connection,
    select(index) { selected = index; boundary.select(index); },
    args(index) { return { userId: manifest.owners[index], warehouseId: manifest.warehouse, productId: manifest.product, productType: "SIMPLE", quantity: 2, lang: "en" }; } };
}

test("ordinary native adapter preserves real service add/read/409 behavior with simulated I/O", async (t) => {
  const f = fixture(t);
  f.select(0); const added = await upsertCartItemService(f.args(0));
  assert.equal(added.items[0].quantity, 5); assert.equal(added.totalCartPrice, 500);
  assert.equal(String(added.id), f.manifest.records[cartStores.cart][0]);
  f.select(1); const read = await getCartService(f.args(1));
  assert.equal(read.items[0].quantity, 3); assert.equal(read.totalCartPrice, 300);
  f.select(2); await assert.rejects(getCartService(f.args(2)), { statusCode: 409 });
  assert.equal(await f.boundary.read(), null);
  assert.equal(f.rows.length, 2); assert.equal(f.errors.length, 3);
  for (const state of f.boundary.stats) { assert.equal(state.lookups, 2); assert.equal(state.inserts, 1); assert.equal(state.duplicates, 1); }
  for (const row of f.rows) assert.equal(row.assistantTestRun, f.manifest.marker);
  assert.equal(f.rows.some((row) => f.manifest.records[cartStores.cart].slice(3).includes(String(row._id))), false);
});
test("ordinary adapter refuses foreign identity, sessions, upserts, broad writes and unrelated I/O", async (t) => {
  const f = fixture(t); f.select(0); const id = new mongoose.Types.ObjectId(f.manifest.records[cartStores.cart][0]);
  assert.throws(() => CartModel.collection.findOne({ user: new mongoose.Types.ObjectId() }), /assert|equal|Expected/i);
  assert.throws(() => CartModel.collection.findOne({}), /assert|equal|Expected/i);
  assert.throws(() => CartModel.collection.updateOne({ _id: id }, { $set: { user: id } }, {}));
  assert.throws(() => CartModel.collection.updateOne({ _id: id, $and: [{ bundles: { $exists: true } }] }, { $set: { totalCartPrice: 1 } }, {}));
  assert.throws(() => CartModel.collection.updateOne({ _id: id }, { $set: { totalCartPrice: 1 } }, { upsert: true }));
  assert.throws(() => CartModel.collection.updateOne({ _id: id }, { $set: { totalCartPrice: 1 } }, { session: {} }));
  assert.throws(() => CartModel.collection.updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { totalCartPrice: 1 } }, {}));
  assert.throws(() => ProductModel.collection.findOne({})); assert.throws(() => CartModel.createIndexes());
  assert.throws(() => f.db.collection("carts")); assert.throws(() => f.db.createCollection("anything"));
  assert.throws(() => f.client.db("other")); assert.equal(f.calls.length, 0);
  f.connection.readyState = 0; assert.throws(() => f.boundary.read());
});
test("ordinary adapter rejects a foreign creation before raw insertion", async (t) => {
  const f = fixture(t); f.select(0);
  await assert.rejects(CartModel.collection.insertOne({ _id: new mongoose.Types.ObjectId(), user: f.manifest.owners[0], warehouse: f.manifest.warehouse, items: [] }, {}));
  assert.equal(f.calls.length, 0);
});
test("winner fixtures use only preregistered owner/cart/catalog IDs and the closed persistence profile", () => {
  const manifest = createIsolatedCartManifest();
  for (let index = 0; index < 3; index++) {
    const row = ordinaryWinner(CartModel, manifest, index);
    assert.equal(String(row._id), manifest.records[cartStores.cart][index]); assert.equal(String(row.user), manifest.owners[index]);
    assert.equal(row.items[0].quantity, 3); assert.equal(row.__v, 7);
  }
  assert.throws(() => ordinaryWinner(CartModel, createIsolatedCartManifest("recovery"), 0));
  assert.throws(() => ordinaryWinner(CartModel, manifest, 3));
});
