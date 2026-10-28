import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "../assistant/fixtures/sharedMongo.js";
import { bundleNativeOptIn, validateBundleNativePlan, claimBundleNativeDatabase, installBundleNativeGuard,
  inspectBundleNativeDatabase, cleanupBundleNativeDatabase } from "./fixtures/bundleNativeTarget.js";

test("isolated native bundle warehouse/catalog acceptance", { skip: process.env.BUNDLE_NATIVE_TEST !== bundleNativeOptIn &&
  "Prepared only; explicit isolated setup/run/cleanup approval required", timeout: 180000 }, async t => {
  const plan = validateBundleNativePlan(JSON.parse(await fs.readFile(process.env.BUNDLE_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.BUNDLE_NATIVE_URI, sharedMongoConfirmation);
  assert.equal(process.env.REDIS_URL, undefined);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const refuse = () => { throw Error("External HTTP is outside bundle native acceptance"); };
  t.mock.method(globalThis, "fetch", refuse); t.mock.method(http, "request", refuse); t.mock.method(https, "request", refuse);
  let claimed = false;
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
      retryWrites: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    await claimBundleNativeDatabase(mongoose.connection, plan); claimed = true;
    const guard = installBundleNativeGuard(t, mongoose.connection, plan);
    const { bundleManagementService: management } = await import("../../../src/domains/bundle/bundle.service.js");
    const { bundleCatalogService: catalog } = await import("../../../src/domains/bundle/bundle.customer-service.js");
    const { ManualBundle } = await import("../../../src/domains/bundle/bundle.model.js");
    const repository = await import("../../../src/domains/bundle/bundle.repository.js");
    const db = mongoose.connection.db, oid = () => new mongoose.Types.ObjectId();
    const warehouses = [oid(), oid(), oid(), oid()], x = oid(), y = oid(), z = oid(), selectedVariant = oid(), otherVariant = oid();
    const actor = { _id: String(oid()), role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" };
    const customer = { ...actor, role: "user" };
    const stock = (indices, quantities) => indices.map((index, n) => ({ warehouse: warehouses[index - 1], quantity: quantities[n], revision: 0 }));
    const xStock = () => stock([1, 2, 4], [10, 9, 20]), yStock = () => stock([2, 3, 4], [12, 30, 6]);
    const create = (name, components, price = 230) => management.create(actor, { name_en: name, name_ar: "باكدج تجريبي", components, price });
    const components = [{ productId: String(x), productType: "SIMPLE", quantity: 2 }, { productId: String(y), productType: "SIMPLE", quantity: 3 }];
    const query = number => ({ warehouseId: String(warehouses[number - 1]), language: "en" });
    const availability = async bundle => {
      const values = [];
      for (const number of [1, 2, 3, 4]) {
        const result = await catalog.list(customer, query(number));
        values.push(result.bundles.find(row => row.id === bundle.id)?.stock ?? 0);
      }
      return values;
    };
    const passed = async name => {
      const snapshot = await inspectBundleNativeDatabase(mongoose.connection, plan);
      t.diagnostic(`bundle_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`);
    };
    const insert = (name, row) => db.collection(name).insertOne(row);
    let main, variantBundle, race, zero;

    await t.test("readiness requires explicit existing collection and exact catalog index", async () => {
      assert.equal(ManualBundle.collection.name, "manualbundles");
      for (const option of ["autoCreate", "autoIndex", "bufferCommands"]) assert.equal(ManualBundle.schema.options[option], false);
      await assert.rejects(repository.requireManualBundleStore(), { code: "BUNDLE_STORE_UNAVAILABLE" });
      for (const name of ["warehouses", "products", "manualbundles"]) await db.createCollection(name);
      await repository.requireManualBundleStore();
      await assert.rejects(repository.requireBundleCatalogStore(), { code: "BUNDLE_STORE_UNAVAILABLE" });
      await db.collection("manualbundles").createIndex({ origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" });
      await repository.requireBundleCatalogStore();
      for (const [index, warehouse] of warehouses.entries()) await insert("warehouses", { _id: warehouse, name: `Fictional warehouse ${index + 1}`,
        active: true, fulfillment: { status: "OPERATIONAL" } });
      await insert("products", { _id: x, type: "SIMPLE", name_en: "Fictional X", isActive: true, price: 100, warehouseStocks: xStock() });
      await insert("products", { _id: y, type: "SIMPLE", name_en: "Fictional Y", isActive: true, price: 50, warehouseStocks: yStock() });
      await insert("products", { _id: z, type: "VARIANT", name_en: "Fictional Z", isActive: true, variants: [
        { _id: selectedVariant, price: 50, warehouseStocks: stock([2], [4]), options: [{ name: "Weight", value: "1kg" }] },
        { _id: otherVariant, price: 1, warehouseStocks: stock([1, 3, 4], [100, 100, 100]) }] });
      main = (await create("X and Y", components)).bundle;
      assert.equal(main.warehouseId, undefined);
      main = (await management.publish(actor, main.id, { expectedRevision: main.revision })).bundle;
      await passed("explicit_store_admission");
    });
    await t.test("real global queries show the exact X/Y intersection in warehouses 2 and 4 only", async () => {
      assert.deepEqual(await availability(main), [0, 4, 0, 2]);
      for (const number of [1, 3]) await assert.rejects(catalog.get(customer, main.id, query(number)), { statusCode: 404 });
      for (const number of [2, 4]) {
        const card = (await catalog.get(customer, main.id, query(number))).bundle;
        assert.equal(card.id, main.id); assert.equal(card.warehouseId, String(warehouses[number - 1]));
        assert.equal(card.price, 350); assert.equal(card.discountedPrice, 230); assert.equal(card.type, "BUNDLE");
        assert.equal(card.createdBy, undefined);
      }
      const raw = await db.collection("manualbundles").findOne({ _id: new mongoose.Types.ObjectId(main.id) });
      assert.equal(raw.warehouse, undefined); assert.equal(raw.fixtureRun, plan.run);
      await passed("four_warehouse_intersection");
    });
    await t.test("depletion, restock and duplicate rows remain isolated without cross-warehouse top-up", async () => {
      await db.collection("products").updateOne({ _id: x }, { $set: { "warehouseStocks.1.quantity": 0 } });
      assert.deepEqual(await availability(main), [0, 0, 0, 2]);
      await db.collection("products").updateOne({ _id: y }, { $set: { warehouseStocks: [...yStock(), { warehouse: warehouses[0], quantity: 6, revision: 0 }] } });
      assert.deepEqual(await availability(main), [2, 0, 0, 2]);
      await db.collection("products").updateOne({ _id: y }, { $set: { "warehouseStocks.2.quantity": 2 } });
      assert.deepEqual(await availability(main), [2, 0, 0, 0]);
      await db.collection("products").updateOne({ _id: x }, { $set: { warehouseStocks: [...xStock(), { warehouse: warehouses[1], quantity: 9, revision: 0 }] } });
      assert.deepEqual(await availability(main), [2, 0, 0, 0]);
      await db.collection("products").updateOne({ _id: x }, { $set: { warehouseStocks: xStock() } });
      await db.collection("products").updateOne({ _id: y }, { $set: { warehouseStocks: yStock() } });
      assert.deepEqual(await availability(main), [0, 4, 0, 2]); await passed("independent_stock_changes");
    });
    await t.test("another variant never supplies stock for the selected bundle variant", async () => {
      variantBundle = (await create("Exact variant", [{ productId: String(x), productType: "SIMPLE", quantity: 2 },
        { productId: String(z), productType: "VARIANT", variantId: String(selectedVariant), quantity: 1 }], 150)).bundle;
      variantBundle = (await management.publish(actor, variantBundle.id, { expectedRevision: 1 })).bundle;
      assert.deepEqual(await availability(variantBundle), [0, 4, 0, 0]);
      await db.collection("products").updateOne({ _id: z }, { $set: { "variants.0.warehouseStocks.0.quantity": 0 } });
      assert.deepEqual(await availability(variantBundle), [0, 0, 0, 0]);
      await db.collection("products").updateOne({ _id: z }, { $set: { "variants.0.warehouseStocks.0.quantity": 4 } });
      await passed("exact_variant_stock");
    });
    await t.test("global pause hides every warehouse and paused edits require explicit republish", async () => {
      main = (await management.pause(actor, main.id, { expectedRevision: main.revision })).bundle;
      assert.deepEqual(await availability(main), [0, 0, 0, 0]);
      await assert.rejects(management.remove(actor, main.id, { expectedRevision: main.revision }), { code: "BUNDLE_DELETE_DENIED" });
      main = (await management.replace(actor, main.id, { name_en: "Edited X/Y", components, price: 220, expectedRevision: main.revision })).bundle;
      assert.equal(main.status, "paused"); assert.deepEqual(await availability(main), [0, 0, 0, 0]);
      main = (await management.publish(actor, main.id, { expectedRevision: main.revision })).bundle;
      assert.deepEqual(await availability(main), [0, 4, 0, 2]); await passed("global_pause_republish");
    });
    await t.test("warehouse maintenance and inactive product admission affect only legitimate availability", async () => {
      await db.collection("warehouses").updateOne({ _id: warehouses[1] }, { $set: { "fulfillment.status": "MAINTENANCE", "fulfillment.fallbackWarehouse": warehouses[3] } });
      await assert.rejects(catalog.list(customer, query(2)), { code: "BUNDLE_WAREHOUSE_UNAVAILABLE" });
      assert.equal((await catalog.get(customer, main.id, query(4))).bundle.stock, 2);
      await db.collection("warehouses").updateOne({ _id: warehouses[1] }, { $set: { "fulfillment.status": "OPERATIONAL" } });
      await db.collection("products").updateOne({ _id: x }, { $set: { isActive: false } });
      assert.deepEqual(await availability(main), [0, 0, 0, 0]);
      await db.collection("products").updateOne({ _id: x }, { $set: { isActive: true } });
      await passed("operational_warehouse_admission");
    });
    await t.test("current regular prices, positive fixed price and safe comparison prevent stale discounts", async () => {
      await db.collection("products").updateOne({ _id: x }, { $set: { price: 20 } });
      assert.deepEqual(await availability(main), [0, 0, 0, 0]);
      assert.equal((await management.get(actor, main.id)).bundle.price, 220);
      await db.collection("products").updateOne({ _id: x }, { $set: { price: 100 } });
      zero = (await create("Unpublished zero", components, 0)).bundle;
      await assert.rejects(management.publish(actor, zero.id, { expectedRevision: 1 }), { code: "BUNDLE_PUBLICATION_PRICE_REQUIRED" });
      assert.equal((await management.get(actor, zero.id)).bundle.status, "draft"); await passed("live_price_and_zero_guard");
    });
    await t.test("real Mongo compare-and-set allows one concurrent edit and one publication", async () => {
      race = (await create("Race draft", components, 230)).bundle;
      const edits = await Promise.allSettled([210, 215].map(price => management.replace(actor, race.id, { name_en: "Race draft", components, price, expectedRevision: 1 })));
      assert.equal(edits.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(edits.find(result => result.status === "rejected").reason.code, "BUNDLE_REVISION_CONFLICT");
      race = (await management.get(actor, race.id)).bundle; assert.equal(race.revision, 2);
      const publications = await Promise.allSettled([1, 2].map(() => management.publish(actor, race.id, { expectedRevision: 2 })));
      assert.equal(publications.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(publications.find(result => result.status === "rejected").reason.code, "BUNDLE_REVISION_CONFLICT");
      race = (await management.get(actor, race.id)).bundle; assert.equal(race.revision, 3); assert.equal(race.status, "published");
      await passed("real_revision_contention");
    });
    await t.test("native draft deletion and provenance guards preserve published and AI records", async () => {
      await management.remove(actor, zero.id, { expectedRevision: 1 });
      await assert.rejects(management.get(actor, zero.id), { statusCode: 404 });
      await assert.rejects(management.remove(actor, race.id, { expectedRevision: race.revision }), { code: "BUNDLE_DELETE_DENIED" });
      await db.collection("manualbundles").updateOne({ _id: new mongoose.Types.ObjectId(race.id) }, { $set: { origin: "ai" } });
      await assert.rejects(management.get(actor, race.id), { code: "BUNDLE_MANUAL_REQUIRED" });
      assert.equal((await catalog.list(customer, query(2))).bundles.some(row => row.id === race.id), false);
      await db.collection("manualbundles").updateOne({ _id: new mongoose.Types.ObjectId(race.id) }, { $set: { origin: "manual" } });
      await passed("native_delete_and_provenance");
    });
    await t.test("independent connection confirms fixture state and catalog reads never reserve or alter inventory", async () => {
      const snapshot = await db.collection("products").find({}).sort({ _id: 1 }).toArray();
      await availability(main); await availability(variantBundle);
      assert.deepEqual(await db.collection("products").find({}).sort({ _id: 1 }).toArray(), snapshot);
      const fresh = new mongoose.mongo.MongoClient(uri.href, { retryWrites: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
      try {
        await fresh.connect(); const freshDb = fresh.db(plan.database);
        assert.deepEqual(await freshDb.collection("products").find({}).sort({ _id: 1 }).toArray(), snapshot);
        assert.equal(await freshDb.collection("warehouses").countDocuments({ fixtureRun: plan.run }), 4);
        const record = await freshDb.collection("manualbundles").findOne({ _id: new mongoose.Types.ObjectId(main.id) });
        assert.equal(record.status, "published"); assert.equal(record.pricePiastres, 22000); assert.equal(record.warehouse, undefined);
        assert.equal(await freshDb.collection("manualbundles").countDocuments({ fixtureRun: { $ne: plan.run } }), 0);
      } finally { await fresh.close(); }
      await passed("fresh_native_readback");
    });
    t.diagnostic(`bundle_native_insert_attempts=${guard.insertAttempts()}`);
  } finally {
    try {
      if (claimed && mongoose.connection.readyState === 1) {
        const cleanup = await cleanupBundleNativeDatabase(mongoose.connection, plan);
        t.diagnostic(`bundle_native_cleanup=${JSON.stringify(cleanup)}`);
      }
    } finally { await mongoose.disconnect(); }
  }
});
