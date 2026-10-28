import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdir, writeFile } from "node:fs/promises";
import { createCoordinatorManifest, coordinatorCases, coordinatorOptIn, coordinatorSeed, coordinatorProposal, verifyCoordinatorCleanup, readCoordinatorJournal } from "./fixtures/cartCoordinator.js";
import { sharedMongoRecords, validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { installCoordinatorBoundaries } from "./fixtures/cartCoordinatorBoundaries.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("native confirmation coordinator rejects concurrent access and pet/chat/warning changes", {
  skip: !process.env.ASSISTANT_SHARED_CART_COORDINATOR_TEST && "Prepared only; new isolated-proposal setup and execution approval required", timeout: 180000,
}, async (t) => {
  assert.equal(process.env.ASSISTANT_SHARED_CART_COORDINATOR_TEST, coordinatorOptIn);
  const journalName = process.env.ASSISTANT_SHARED_CART_COORDINATOR_SETUP_JOURNAL;
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url);
  const journal = await readCoordinatorJournal(directory, journalName);
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { UserModel } = await import("../../../src/domains/user/user.model.js");
  const { PetModel } = await import("../../../src/domains/pet/pet.model.js");
  const { CartModel } = await import("../../../src/domains/cart/cart.model.js");
  const { AssistantCartProposal } = await import("../../../src/domains/assistant/shared/assistant.cart-proposal.model.js");
  const { AssistantCartReceipt } = await import("../../../src/domains/assistant/shared/assistant.cart-receipt.model.js");
  const { ProductModel } = await import("../../../src/domains/product/product.model.js");
  const { WarehouseModel } = await import("../../../src/domains/warehouse/warehouse.model.js");
  const { CollectionModel } = await import("../../../src/domains/collection/collection.model.js");
  const models = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { NotificationOutboxModel } = await import("../../../src/domains/notification/notificationOutbox.model.js");
  const { subjectFingerprint, subjectFromPet } = await import("../../../src/domains/assistant/customer/assistant.context.js");
  const { previewCartAdditionService, cartAdditionQuoteForComparison } = await import("../../../src/domains/cart/cart.service.js");
  const { confirmCartAdditionProposal, revalidateCartAdditionProposal } = await import("../../../src/domains/assistant/customer/assistant.cart-proposals.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const manifest = createCoordinatorManifest(); await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`cart_coordinator_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(), disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Coordinator test connection failed; details withheld"); }
  await verifyCoordinatorCleanup(mongoose.connection, manifest, journal);
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  const config = testConfig({ productSearchEnabled: true, catalogClassification: { version: "coordinator-fixture-v1", foodCategoryIds: [manifest.foodCategory],
    nonFoodCategoryIds: [manifest.nonFoodCategory], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] } });
  const seeds = coordinatorCases.map((_name, index) => coordinatorSeed(manifest, index));
  for (const [index, seed] of seeds.entries()) {
    for (const [name, row] of Object.entries(seed)) await records.insert(name, row);
    const cart = new CartModel({ _id: manifest.records.assistanttestcarts[index], user: seed.users._id, warehouse: manifest.warehouse,
      __v: 7, checkoutKey: `${manifest.marker}_${index}`, items: [{ product: manifest.product, productType: "SIMPLE", quantity: 3,
        itemPrice: 100, productName: "Fixture item", variantOptionsSnapshot: [] }], totalCartPrice: 300 });
    await cart.validate(); await records.insert("assistanttestcarts", cart.toObject());
  }
  let selected = 0; const fired = new Set();
  const context = installCoordinatorBoundaries(t, mongoose.connection, manifest, {
    users: UserModel, pets: PetModel, assistantaccounts: models.AssistantAccount, assistantchats: models.AssistantChat,
    assistantruns: models.AssistantRun, assistantmessages: models.AssistantMessage, assistantdietarywarnings: models.AssistantDietaryWarning,
    assistanttestcarts: CartModel, assistanttestcartproposals: AssistantCartProposal, assistanttestcartreceipts: AssistantCartReceipt,
  }, [...Object.values(models.assistantModels), NotificationOutboxModel], {
    beforeFence: async (name, id) => {
      const target = selected === 1 ? "users" : selected === 2 ? "assistantaccounts" : selected === 4 ? "pets" : "assistantchats";
      if (selected < 1 || selected > 5 || name !== target || id !== manifest.records[name][selected] || fired.has(selected)) return;
      fired.add(selected); await context.compete(selected);
    },
    beforeReceipt: async (index) => { if (index === 6) throw new Error("Synthetic coordinator receipt failure"); },
  });
  const product = { _id: new mongoose.Types.ObjectId(manifest.product), type: "SIMPLE", isActive: true, name_en: "Fixture item", price: 100,
    images: [], warehouseStocks: [{ warehouse: manifest.warehouse, quantity: 100 }] };
  const query = (value) => ({ select() { return this; }, maxTimeMS() { return this; }, session() { return this; }, lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(ProductModel, "findById", (id) => { assert.equal(String(id), manifest.product);
    return query({ ...product, category: selected === 5 ? manifest.foodCategory : manifest.nonFoodCategory }); });
  t.mock.method(ProductModel, "find", (filter) => { assert.ok(filter._id.$in.every((id) => String(id) === manifest.product)); return query([product]); });
  t.mock.method(WarehouseModel, "findById", (id) => { assert.equal(String(id), manifest.warehouse); return query({ _id: manifest.warehouse, active: true }); });
  t.mock.method(CollectionModel, "findOne", () => query(null));
  const expected = [null, "authentication_required", "ai_restricted", "context_changed", "context_changed", "food_review_required", "Synthetic coordinator receipt failure"];
  for (selected = 0; selected < coordinatorCases.length; selected++) {
    const seed = seeds[selected], session = await mongoose.startSession(); let quote;
    try { quote = await session.withTransaction(() => previewCartAdditionService({ userId: String(seed.users._id), warehouseId: manifest.warehouse,
      productId: manifest.product, productType: "SIMPLE", quantity: 2, lang: "en" }, { session }), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 15000 }); }
    finally { await session.endSession(); }
    const proposal = coordinatorProposal(manifest, selected, seed, quote, config, subjectFingerprint(subjectFromPet(seed.pets)), cartAdditionQuoteForComparison);
    await records.insert("assistanttestcartproposals", proposal);
    const body = { expectedVersion: 1, fingerprint: proposal.fingerprint };
    assert.equal((await revalidateCartAdditionProposal(seed.users._id, String(proposal._id), body, config)).ready, true);
    const confirm = () => confirmCartAdditionProposal(seed.users._id, String(proposal._id), body, config);
    if (selected === 0) { assert.equal((await confirm()).duplicate, false); assert.equal((await confirm()).duplicate, true); }
    else await assert.rejects(confirm(), (error) => error.code === expected[selected] || error.message === expected[selected]);
    const cart = await context.read("assistanttestcarts", selected), receipt = await context.read("assistanttestcartreceipts", selected);
    assert.equal(cart.items[0].quantity, selected === 0 ? 5 : 3); assert.equal(cart.__v, selected === 0 ? 8 : 7);
    assert.equal(cart.totalCartPrice, selected === 0 ? 500 : 300); assert.equal(cart.checkoutKey, `${manifest.marker}_${selected}`);
    assert.equal(Boolean(receipt), selected === 0);
    for (const name of ["users", "assistantaccounts", "assistantchats", "pets"]) assert.equal((await context.read(name, selected)).__v, selected === 0 ? 1 : 0);
    if (selected === 1) assert.equal((await context.read("users", selected)).active, false);
    if (selected === 2) assert.equal((await context.read("assistantaccounts", selected)).blocked, true);
    if (selected === 3) { const chat = await context.read("assistantchats", selected); assert.equal(chat.activeSubject, null); assert.equal(chat.contextVersion, 1); }
    if (selected === 4) assert.deepEqual((await context.read("pets", selected)).chronic_conditions, ["Fixture dietary condition"]);
    if (selected === 5) { assert.equal((await context.read("assistantchats", selected)).contextVersion, 1); assert.equal((await context.read("assistantdietarywarnings", 0)).state, "active"); }
    t.diagnostic(`coordinator_case=${coordinatorCases[selected]}:passed`);
  }
  assert.deepEqual([...fired].sort(), [1, 2, 3, 4, 5]);
});
