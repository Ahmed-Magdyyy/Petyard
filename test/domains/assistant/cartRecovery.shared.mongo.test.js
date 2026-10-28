import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { createIsolatedCartManifest, isolatedCartRecords, cartStores, verifyIsolatedCartCleanup } from "./fixtures/isolatedCart.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { readCartRecoverySetupJournal, loseFirstCommitReply, requireCartRecoveryOptIn } from "./fixtures/cartRecovery.js";

test("native isolated cart creation, query races and commit-reply recovery", {
  skip: !process.env.ASSISTANT_SHARED_CART_RECOVERY_TEST && "Prepared only; new bounded execution approval required",
  timeout: 90000,
}, async (t) => {
  requireCartRecoveryOptIn(process.env.ASSISTANT_SHARED_CART_RECOVERY_TEST);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url);
  const setupJournal = await readCartRecoverySetupJournal(directory, process.env.ASSISTANT_SHARED_CART_RECOVERY_SETUP_JOURNAL);
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { CartModel } = await import("../../../src/domains/cart/cart.model.js");
  const { AssistantCartReceipt } = await import("../../../src/domains/assistant/shared/assistant.cart-receipt.model.js");
  const { ProductModel } = await import("../../../src/domains/product/product.model.js");
  const { WarehouseModel } = await import("../../../src/domains/warehouse/warehouse.model.js");
  const { CollectionModel } = await import("../../../src/domains/collection/collection.model.js");
  const { previewCartAdditionService } = await import("../../../src/domains/cart/cart.service.js");
  const { stageCartAdditionWithReceipt, recoverCartAdditionReceipt } = await import("../../../src/domains/assistant/customer/assistant.cart-receipts.js");
  const manifest = createIsolatedCartManifest("recovery");
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`isolated_cart_recovery_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Isolated cart recovery connection failed; connection details withheld"); }
  await verifyIsolatedCartCleanup(mongoose.connection, manifest, setupJournal);
  records = isolatedCartRecords(mongoose.connection, manifest); await records.prepare();
  const oid = (value) => new mongoose.Types.ObjectId(value), carts = manifest.records[cartStores.cart], receipts = manifest.records[cartStores.receipt];
  for (const index of [0, 1]) {
    const doc = new CartModel({ _id: carts[index], user: manifest.owners[index], warehouse: manifest.warehouse,
      checkoutKey: `keep-${index}`, __v: 7, deliveryAddress: { name: "Synthetic original address" },
      items: [{ product: manifest.product, productType: "SIMPLE", quantity: 3, itemPrice: 100,
        productName: "Synthetic toy", variantOptionsSnapshot: [] }], totalCartPrice: 300 });
    await doc.validate(); await records.insert(cartStores.cart, doc.toObject());
  }
  // Fix only the new cart's generated root ID so it is registered before any possible insertion.
  const rootId = CartModel.schema.path("_id"), originalDefault = rootId.defaultValue;
  rootId.default(() => oid(carts[2])); t.after(() => { rootId.defaultValue = originalDefault; });
  let beforeCartWrite;
  records.install(t, { CartModel, AssistantCartReceipt }, { beforeCartWrite: (session) => beforeCartWrite?.(session) });
  const product = { _id: oid(manifest.product), type: "SIMPLE", isActive: true, name_en: "Synthetic toy", price: 100,
    images: [], warehouseStocks: [{ warehouse: oid(manifest.warehouse), quantity: 100 }] };
  const query = (value) => {
    let session;
    return { select() { return this; }, lean() { return this; }, session(value) { session = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        assert.equal(session?.client, mongoose.connection.getClient()); assert.equal(session.inTransaction(), true); return value;
      }).then(resolve, reject); } };
  };
  t.mock.method(WarehouseModel, "findById", (id) => { assert.equal(String(id), manifest.warehouse); return query({ _id: oid(id), active: true }); });
  t.mock.method(ProductModel, "findById", (id) => { assert.equal(String(id), manifest.product); return query(product); });
  t.mock.method(ProductModel, "find", (filter) => {
    assert.ok(filter._id.$in.every((id) => String(id) === manifest.product)); return query([product]);
  });
  t.mock.method(CollectionModel, "findOne", () => query(null));
  const transact = async (callback, commitFault = null) => {
    const session = await mongoose.startSession();
    try {
      if (commitFault) commitFault.observed = loseFirstCommitReply(session, mongoose.mongo);
      return await session.withTransaction(() => callback(session), { readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000, timeoutMS: 15000 });
    } finally { await session.endSession(); }
  };
  const input = (index) => ({ userId: manifest.owners[index], warehouseId: manifest.warehouse, productId: manifest.product,
    productType: "SIMPLE", quantity: 2, lang: "en" });
  const operation = (index, receiptIndex, expectedQuote) => ({ owner: manifest.owners[index], proposalId: receipts[receiptIndex],
    proposalFingerprint: "a".repeat(64), expectedQuote, addition: { warehouseId: manifest.warehouse, productId: manifest.product,
      productType: "SIMPLE", quantity: 2, language: "en" } });

  const creation = operation(2, 0, await transact((session) => previewCartAdditionService(input(2), { session })));
  assert.equal(creation.expectedQuote.cartId, null);
  const created = await transact((session) => stageCartAdditionWithReceipt(creation, { session }));
  assert.equal(created.receipt.cartId, carts[2]); assert.equal(created.duplicate, false);
  assert.equal((await records.read(cartStores.cart, oid(carts[2]))).items[0].quantity, 2);
  assert.equal((await transact((session) => recoverCartAdditionReceipt(creation, { session }))).duplicate, true);

  const scalar = operation(0, 1, await transact((session) => previewCartAdditionService(input(0), { session })));
  let scalarCallbacks = 0;
  beforeCartWrite = async () => { beforeCartWrite = null; await records.compete(oid(carts[0]), "checkout_context"); };
  const scalarResult = await transact((session) => { scalarCallbacks++; return stageCartAdditionWithReceipt(scalar, { session }); });
  assert.ok(scalarCallbacks >= 2, "A real write conflict must retry the transaction after the scalar edit");
  const scalarCart = await records.read(cartStores.cart, oid(carts[0]));
  assert.equal(scalarResult.duplicate, false); assert.equal(scalarCart.items[0].quantity, 5); assert.equal(scalarCart.__v, 8);
  assert.equal(scalarCart.checkoutKey, `${manifest.marker}_changed`); assert.equal(scalarCart.deliveryAddress.name, manifest.marker);

  const cleared = operation(0, 2, await transact((session) => previewCartAdditionService(input(0), { session })));
  beforeCartWrite = async () => { beforeCartWrite = null; await records.compete(oid(carts[0]), "clear_items"); };
  await assert.rejects(transact((session) => stageCartAdditionWithReceipt(cleared, { session })), (error) => error.statusCode === 409);
  const empty = await records.read(cartStores.cart, oid(carts[0]));
  assert.deepEqual(empty.items, []); assert.equal(empty.totalCartPrice, 0); assert.equal(empty.__v, 8);
  assert.equal(await records.read(cartStores.receipt, oid(receipts[2])), null);

  const uncertain = operation(1, 3, await transact((session) => previewCartAdditionService(input(1), { session })));
  const fault = {}; let callbacks = 0, committed;
  const lostApplicationReply = async () => {
    committed = await transact((session) => { callbacks++; return stageCartAdditionWithReceipt(uncertain, { session }); }, fault);
    throw new Error("Synthetic lost application response");
  };
  await assert.rejects(lostApplicationReply(), /Synthetic lost application response/);
  assert.equal(callbacks, 1, "An unknown commit reply retries commit, not the cart addition");
  assert.equal(fault.observed.injectedReplies, 1); assert.equal(fault.observed.commitCalls, 2);
  // The caller saw an error after commit and must recover the retained result.
  const recovered = await transact((session) => stageCartAdditionWithReceipt(uncertain, { session }));
  assert.equal(recovered.duplicate, true); assert.deepEqual(recovered.receipt, committed.receipt);
  const finalCart = await records.read(cartStores.cart, oid(carts[1]));
  assert.equal(finalCart.items[0].quantity, 5); assert.equal(finalCart.totalCartPrice, 500); assert.equal(finalCart.__v, 8);
});
