import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { createIsolatedCartManifest, cartStores, isolatedCartRecords, verifyIsolatedCartCleanup } from "./fixtures/isolatedCart.js";
import { readCartRecoverySetupJournal } from "./fixtures/cartRecovery.js";
import { ordinaryCartOptIn, installOrdinaryCartBoundaries } from "./fixtures/ordinaryCart.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("ordinary signed-in cart services recover real native duplicate-owner creation", {
  skip: !process.env.ASSISTANT_SHARED_ORDINARY_CART_TEST && "Prepared only; one new native run requires approval", timeout: 90000,
}, async (t) => {
  assert.equal(process.env.ASSISTANT_SHARED_ORDINARY_CART_TEST, ordinaryCartOptIn);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url);
  const journal = await readCartRecoverySetupJournal(directory, process.env.ASSISTANT_SHARED_ORDINARY_CART_SETUP_JOURNAL);
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { CartModel } = await import("../../../src/domains/cart/cart.model.js");
  const { ProductModel } = await import("../../../src/domains/product/product.model.js");
  const { WarehouseModel } = await import("../../../src/domains/warehouse/warehouse.model.js");
  const { CollectionModel } = await import("../../../src/domains/collection/collection.model.js");
  const { getCartService, upsertCartItemService } = await import("../../../src/domains/cart/cart.service.js");
  const manifest = createIsolatedCartManifest(); await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`ordinary_cart_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(), disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Ordinary cart test connection failed; details withheld"); }
  await verifyIsolatedCartCleanup(mongoose.connection, manifest, journal);
  records = isolatedCartRecords(mongoose.connection, manifest); await records.prepare();
  const boundary = installOrdinaryCartBoundaries(t, mongoose.connection, manifest, CartModel);
  const product = { _id: manifest.product, type: "SIMPLE", isActive: true, price: 100, name_en: "Synthetic toy", images: [],
    warehouseStocks: [{ warehouse: manifest.warehouse, quantity: 10 }] };
  const query = (value) => ({ select() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(ProductModel, "findById", (id) => { assert.equal(String(id), manifest.product); return query(product); });
  t.mock.method(ProductModel, "find", (filter) => { assert.ok(filter._id.$in.every((id) => String(id) === manifest.product)); return query([product]); });
  t.mock.method(WarehouseModel, "findById", (id) => { assert.equal(String(id), manifest.warehouse); return query({ _id: manifest.warehouse, active: true }); });
  t.mock.method(CollectionModel, "findOne", () => query(null));
  // The ordinary service normally auto-hides expired promotions; this suite permits no promotion writes.
  t.mock.method(CollectionModel, "updateMany", async () => ({ acknowledged: true, modifiedCount: 0 }));
  let selected = 0;
  const rootId = CartModel.schema.path("_id"), originalDefault = rootId.defaultValue;
  rootId.default(() => new mongoose.Types.ObjectId(manifest.records[cartStores.cart][selected + 3]));
  t.after(() => { rootId.defaultValue = originalDefault; });
  for (selected = 0; selected < 3; selected++) {
    boundary.select(selected);
    const args = { userId: manifest.owners[selected], warehouseId: manifest.warehouse, lang: "en" };
    let result;
    if (selected === 0) result = await upsertCartItemService({ ...args, productId: manifest.product, productType: "SIMPLE", quantity: 2 });
    else if (selected === 1) result = await getCartService(args);
    else await assert.rejects(getCartService(args), { statusCode: 409, message: "Your cart changed. Please try again." });
    const row = await boundary.read(), observed = boundary.stats[selected];
    assert.equal(observed.lookups, 2); assert.equal(observed.inserts, 1); assert.equal(observed.duplicates, 1);
    if (selected < 2) {
      assert.equal(String(result.id), manifest.records[cartStores.cart][selected]); assert.ok(observed.updates >= 1);
      assert.equal(row.items[0].quantity, selected === 0 ? 5 : 3); assert.equal(result.items[0].quantity, row.items[0].quantity);
      assert.equal(row.totalCartPrice, selected === 0 ? 500 : 300); assert.equal(row.checkoutKey, `${manifest.marker}_winner_${selected}`);
      assert.equal(String(row.user), manifest.owners[selected]); assert.equal(String(row.warehouse), manifest.warehouse);
    } else { assert.equal(row, null); assert.equal(observed.updates, 0); }
    t.diagnostic(`ordinary_cart_case=${["add_once", "read_winner", "winner_disappeared"][selected]}:passed`);
  }
});
