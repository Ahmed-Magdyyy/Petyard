import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { createIsolatedCartManifest, isolatedCartRecords, cartStores } from "./fixtures/isolatedCart.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("native cart/receipt transactions in isolated test stores", {
  skip: !process.env.ASSISTANT_SHARED_CART_TEST && "Prepared only; explicit isolated-store setup approval and opt-in required",
  timeout: 90000,
}, async (t) => {
  assert.equal(process.env.ASSISTANT_SHARED_CART_TEST, "isolated-cart-stores-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { CartModel } = await import("../../../src/domains/cart/cart.model.js");
  const { AssistantCartReceipt } = await import("../../../src/domains/assistant/shared/assistant.cart-receipt.model.js");
  const { ProductModel } = await import("../../../src/domains/product/product.model.js");
  const { WarehouseModel } = await import("../../../src/domains/warehouse/warehouse.model.js");
  const { CollectionModel } = await import("../../../src/domains/collection/collection.model.js");
  const { previewCartAdditionService } = await import("../../../src/domains/cart/cart.service.js");
  const { stageCartAdditionWithReceipt, recoverCartAdditionReceipt } = await import("../../../src/domains/assistant/customer/assistant.cart-receipts.js");
  const manifest = createIsolatedCartManifest();
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`isolated_cart_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Isolated cart test connection failed; connection details withheld"); }
  records = isolatedCartRecords(mongoose.connection, manifest); await records.prepare();
  const oid = (id) => new mongoose.Types.ObjectId(id);
  const carts = manifest.records[cartStores.cart], receipts = manifest.records[cartStores.receipt];
  for (const index of [0, 1]) {
    const doc = new CartModel({ _id: carts[index], user: manifest.owners[index], warehouse: manifest.warehouse,
      checkoutKey: `keep-${index}`, __v: 7, deliveryAddress: { name: "Keep address", area: "Keep area" },
      items: [{ product: manifest.product, productType: "SIMPLE", quantity: 3, itemPrice: 100,
        productName: "Synthetic toy", variantOptionsSnapshot: [] }], totalCartPrice: 300 });
    await doc.validate(); await records.insert(cartStores.cart, doc.toObject());
  }
  let beforeCartWrite;
  records.install(t, { CartModel, AssistantCartReceipt }, { beforeCartWrite: (session) => beforeCartWrite?.(session) });
  // This milestone proves persistence. Catalog inputs are synthetic; no real catalog record is read or changed.
  const product = { _id: oid(manifest.product), type: "SIMPLE", isActive: true, name_en: "Synthetic toy", price: 100,
    images: [], warehouseStocks: [{ warehouse: oid(manifest.warehouse), quantity: 100 }] };
  function query(value) {
    let session;
    return { select() { return this; }, lean() { return this; }, session(value) { session = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        assert.equal(session?.client, mongoose.connection.getClient()); assert.equal(session.inTransaction(), true); return value;
      }).then(resolve, reject); } };
  }
  t.mock.method(WarehouseModel, "findById", (id) => { assert.equal(String(id), manifest.warehouse); return query({ _id: oid(id), active: true }); });
  t.mock.method(ProductModel, "findById", (id) => { assert.equal(String(id), manifest.product); return query(product); });
  t.mock.method(ProductModel, "find", (filter) => {
    assert.ok(filter._id.$in.every((id) => String(id) === manifest.product)); return query([product]);
  });
  t.mock.method(CollectionModel, "findOne", () => query(null));
  const transact = async (callback) => {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => callback(session), { readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000 }); }
    finally { await session.endSession(); }
  };
  const input = (owner) => ({ userId: owner, warehouseId: manifest.warehouse, productId: manifest.product,
    productType: "SIMPLE", quantity: 2, lang: "en" });
  const operation = (owner, id, expectedQuote) => ({ owner, proposalId: id, proposalFingerprint: "a".repeat(64), expectedQuote,
    addition: { warehouseId: manifest.warehouse, productId: manifest.product, productType: "SIMPLE", quantity: 2, language: "en" } });
  const quote = await transact((session) => previewCartAdditionService(input(manifest.owners[0]), { session }));
  const first = operation(manifest.owners[0], receipts[0], quote), before = await records.read(cartStores.cart, oid(carts[0]));
  const aborted = new Error("Synthetic rollback after cart and receipt writes");
  await assert.rejects(transact(async (session) => {
    const result = await stageCartAdditionWithReceipt(first, { session }); assert.equal(result.duplicate, false); throw aborted;
  }), (error) => error === aborted);
  assert.deepEqual(await records.read(cartStores.cart, oid(carts[0])), before);
  assert.equal(await records.read(cartStores.receipt, oid(receipts[0])), null);

  // Both sessions reach their first cart write before either proceeds; retries bypass the barrier.
  function raceBarrier() {
    const seen = new Set(); let release, waiting;
    return async (session) => {
      waiting ??= new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native cart contention barrier timed out")), 5000);
        release = () => { clearTimeout(timer); resolve(); };
      });
      if (seen.has(session)) return; seen.add(session); if (seen.size === 2) release();
      await waiting;
    };
  }
  beforeCartWrite = raceBarrier();
  const repeated = await Promise.allSettled([0, 1].map(() => transact((session) => stageCartAdditionWithReceipt(first, { session }))));
  beforeCartWrite = null;
  assert.ok(repeated.every((result) => result.status === "fulfilled"), "Both duplicate confirmations must finish successfully");
  const duplicates = repeated.map((result) => result.value);
  assert.deepEqual(duplicates.map((result) => result.duplicate).sort(), [false, true]);
  assert.deepEqual(duplicates[0].receipt, duplicates[1].receipt);
  const saved = await records.read(cartStores.cart, oid(carts[0]));
  assert.equal(saved.items[0].quantity, 5); assert.equal(saved.totalCartPrice, 500); assert.equal(saved.__v, 8);
  assert.equal(saved.checkoutKey, before.checkoutKey); assert.deepEqual(saved.deliveryAddress, before.deliveryAddress);
  assert.deepEqual((await transact((session) => recoverCartAdditionReceipt(first, { session }))).receipt, duplicates[0].receipt);

  const secondQuote = await transact((session) => previewCartAdditionService(input(manifest.owners[1]), { session }));
  const stale = await transact((session) => CartModel.findOne({ _id: oid(carts[1]), user: oid(manifest.owners[1]) }).session(session));
  beforeCartWrite = raceBarrier();
  const competing = await Promise.allSettled(receipts.slice(1).map((id) => transact((session) =>
    stageCartAdditionWithReceipt(operation(manifest.owners[1], id, secondQuote), { session }))));
  beforeCartWrite = null;
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.find((result) => result.status === "rejected").reason.statusCode, 409);
  assert.equal((await records.read(cartStores.cart, oid(carts[1]))).items[0].quantity, 5);
  const savedReceipts = await Promise.all(receipts.slice(1).map((id) => records.read(cartStores.receipt, oid(id))));
  assert.equal(savedReceipts.filter(Boolean).length, 1);
  stale.items[0].quantity = 99;
  await assert.rejects(transact((session) => stale.save({ session })), (error) => error instanceof mongoose.Error.VersionError);
  assert.equal((await records.read(cartStores.cart, oid(carts[1]))).items[0].quantity, 5);

  const creations = await Promise.allSettled(carts.slice(2, 4).map((_id) => transact((session) => CartModel.create([
    { _id, user: manifest.owners[2], warehouse: manifest.warehouse }], { session }))));
  assert.equal(creations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(creations.find((result) => result.status === "rejected").reason.code, 11000);
  for (const [index, _id] of carts.slice(4).entries()) await transact((session) => CartModel.create([
    { _id, guestId: `${manifest.marker}_guest_${index}`, warehouse: manifest.warehouse }], { session }));
  for (const _id of carts.slice(4)) assert.equal((await records.read(cartStores.cart, oid(_id))).user, undefined);
});
