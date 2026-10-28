import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCoordinatorManifest, coordinatorSetupApproval, coordinatorProposalStore, coordinatorCases, coordinatorSeed,
  coordinatorProposal, setupCoordinatorStore, verifyCoordinatorCleanup, readCoordinatorJournal, writeCoordinatorJournal } from "./fixtures/cartCoordinator.js";
import { sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { installCoordinatorBoundaries } from "./fixtures/cartCoordinatorBoundaries.js";
import { cartSetupPlan } from "./fixtures/isolatedCart.js";
import { cartProposalFixture, P, W, C, F } from "./fixtures/cartProposals.js";
import { subjectFingerprint, subjectFromPet } from "../../../src/domains/assistant/customer/assistant.context.js";
import { previewCartAdditionService, cartAdditionQuoteForComparison } from "../../../src/domains/cart/cart.service.js";
import { storedCatalogDto } from "../../../src/domains/assistant/products/assistant.product-cards.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { AssistantCartProposal } from "../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { AssistantCartReceipt } from "../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import * as assistant from "../../../src/domains/assistant/shared/assistant.models.js";

const oid = (id) => new mongoose.Types.ObjectId(id);
function fake({ proposal = false } = {}) {
  const manifest = createCoordinatorManifest(), calls = [], journals = [], fail = {};
  const data = Object.fromEntries([...Object.keys(manifest.records), "carts"].map((name) => [name, []]));
  if (!proposal) delete data[coordinatorProposalStore];
  const indexes = Object.fromEntries(Object.keys(data).map((name) => [name, [{ name: "_id_", key: { _id: 1 } }]]));
  for (const name of ["assistantaccounts", "assistantchats"]) indexes[name].push({ name: "owner_1", key: { owner: 1 }, unique: true });
  indexes.assistantruns.push({ name: "owner_key", key: { owner: 1, key: 1 }, unique: true });
  indexes.assistantmessages.push({ name: "chat_sequence", key: { chat: 1, sequence: 1 }, unique: true }, { name: "run_role", key: { run: 1, role: 1 }, unique: true });
  indexes.assistantdietarywarnings.push({ name: "source", key: { owner: 1, subjectId: 1, sourceMessage: 1 }, unique: true }, { name: "list", key: { owner: 1, subjectId: 1, state: 1, _id: -1 } });
  indexes.users.push({ name: "email", key: { email: 1 }, unique: true }, { name: "phone", key: { phone: 1 }, unique: true, partialFilterExpression: { phone: { $type: "string" } } },
    { name: "provider", key: { "authProviders.provider": 1, "authProviders.providerUserId": 1 }, unique: true, sparse: true });
  for (const [name, values] of Object.entries(cartSetupPlan())) indexes[name].push(...structuredClone(values));
  if (proposal) indexes[coordinatorProposalStore].push({ name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true });
  const matches = (row, filter) => filter._id.$in.some((id) => String(id) === String(row._id)) && (!filter.assistantTestRun || row.assistantTestRun === filter.assistantTestRun);
  const client = { options: { srvHost: manifest.host, dbName: "petyard" }, db() { return connection.db; }, startSession() { const value = { client, inTransaction: () => true,
    async withTransaction(callback) { calls.push({ method: "transaction" }); return callback(); }, async endSession() {} }; return value; } };
  const connection = { name: "petyard", readyState: 1, getClient: () => client, db: { databaseName: "petyard",
    listCollections({ name }) { calls.push({ method: "list", name }); return { async toArray() { return data[name] ? [{ name }] : []; } }; },
    admin() { return { async command(value) { calls.push({ method: "command", value }); return { setName: "synthetic" }; } }; },
    async createCollection(name, options) { assert.equal(name, coordinatorProposalStore); assert.equal(data[name], undefined);
      calls.push({ method: "createCollection", name, options }); data[name] = []; indexes[name] = [{ name: "_id_", key: { _id: 1 } }]; },
    collection(name) { return {
      listIndexes() { return { async toArray() { calls.push({ method: "indexes", name }); return structuredClone(indexes[name]); } }; },
      async indexes() { calls.push({ method: "indexes", name }); return structuredClone(indexes[name]); },
      async createIndex(key, options) { calls.push({ method: "createIndex", name, key, options }); if (fail.index) throw new Error("Synthetic index failure");
        const { writeConcern, ...definition } = options; indexes[name].push({ key, ...definition }); },
      async countDocuments(filter) { calls.push({ method: "count", name, filter }); return Object.keys(filter).length ? data[name].filter((row) => matches(row, filter)).length : data[name].length; },
      async findOne(filter, options) { calls.push({ method: "findOne", name, filter, options }); return fail.leftover ? { _id: "leftover" } : null; },
      find(filter, options) { calls.push({ method: "find", name, filter, options }); return { async toArray() { return []; } }; },
      async insertOne(row, options) { calls.push({ method: "insertOne", name, row, options }); data[name].push(row); return { insertedId: row._id }; },
      async updateOne(filter, update, options) { calls.push({ method: "updateOne", name, filter, update, options }); return { matchedCount: 1, modifiedCount: 1 }; },
      async deleteMany(filter, options) { calls.push({ method: "deleteMany", name, filter, options }); if (fail.delete === name) throw new Error("Synthetic delete failure");
        data[name] = data[name].filter((row) => !matches(row, filter)); return { deletedCount: 0 }; },
    }; },
  } };
  return { manifest, calls, journals, fail, data, indexes, client, connection, persist: async (value) => journals.push(structuredClone(value)) };
}

test("coordinator manifest is closed at 64 record slots and exactly paired proposal/receipt IDs", () => {
  const f = fake({ proposal: true });
  assert.equal(Object.keys(f.manifest.records).length, 10); assert.equal(Object.values(f.manifest.records).flat().length, 64);
  assert.equal(new Set(Object.values(f.manifest.records).flat()).size, 57);
  assert.deepEqual(f.manifest.records.assistanttestcartproposals, f.manifest.records.assistanttestcartreceipts);
  assert.doesNotThrow(() => sharedMongoRecords(f.connection, f.manifest));
  for (const edit of [(m) => { m.records.assistanttestcartreceipts[0] = String(new mongoose.Types.ObjectId()); },
    (m) => { m.records.pets[0] = m.records.users[0]; }, (m) => { m.records.users.pop(); }]) {
    const copy = structuredClone(f.manifest); edit(copy); assert.throws(() => sharedMongoRecords(f.connection, copy));
  }
});

test("setup creates only one empty proposal fixture store and one owner/key index with a durable journal", async () => {
  const f = fake(), before = structuredClone(f.indexes);
  const journal = await setupCoordinatorStore(f.connection, coordinatorSetupApproval, f.persist);
  assert.equal(journal.status, "verified_empty_proposal_store_protected_indexes_unchanged"); assert.equal(journal.pending, null);
  assert.deepEqual(journal.completed, ["createCollection", "createIndex:owner_1_key_1"]);
  const mutations = f.calls.filter((call) => ["createCollection", "createIndex"].includes(call.method));
  assert.equal(mutations.length, 2); assert.ok(mutations.every((call) => call.name === coordinatorProposalStore));
  assert.deepEqual(mutations[1].key, { owner: 1, key: 1 }); assert.equal(mutations[1].options.unique, true);
  for (const [name, value] of Object.entries(before)) assert.deepEqual(f.indexes[name], value);
  assert.equal(f.journals[1].pending, "createCollection");
});

test("setup rejects wrong authority/connection, existing target, missing prerequisite and failed journal without writes", async () => {
  for (const change of [(f) => { f.approval = "wrong"; }, (f) => { f.connection.name = "other"; },
    (f) => { f.data[coordinatorProposalStore] = []; }, (f) => { delete f.data.pets; }, (f) => { f.persist = async () => { throw new Error("journal failed"); }; }]) {
    const f = fake(); change(f); await assert.rejects(setupCoordinatorStore(f.connection, f.approval ?? coordinatorSetupApproval, f.persist));
    assert.equal(f.calls.some((call) => ["createCollection", "createIndex", "insertOne"].includes(call.method)), false);
  }
});

test("setup retains a partial index failure and never repairs or removes the created store", async () => {
  const f = fake(); f.fail.index = true;
  await assert.rejects(setupCoordinatorStore(f.connection, coordinatorSetupApproval, f.persist), /Synthetic index failure/);
  assert.deepEqual(f.journals.at(-1).completed, ["createCollection"]); assert.equal(f.journals.at(-1).pending, "createIndex:owner_1_key_1");
  assert.ok(Object.hasOwn(f.data, coordinatorProposalStore)); assert.equal(f.calls.some((call) => call.method === "deleteMany"), false);
});

test("native preparation refuses missing required indexes before fixture writes and cleanup covers all ten stores", async () => {
  const f = fake({ proposal: true }), records = sharedMongoRecords(f.connection, f.manifest); await records.prepare();
  await records.cleanup(); assert.equal(f.calls.filter((call) => call.method === "deleteMany").length, 10);
  for (const call of f.calls.filter((call) => call.method === "deleteMany")) {
    assert.equal(call.filter.assistantTestRun, f.manifest.marker); assert.deepEqual(call.filter._id.$in.map(String), f.manifest.records[call.name]);
  }
  const broken = fake({ proposal: true }); broken.indexes.assistantaccounts[1].unique = false;
  await assert.rejects(sharedMongoRecords(broken.connection, broken.manifest).prepare());
  assert.equal(broken.calls.some((call) => ["insertOne", "deleteMany"].includes(call.method)), false);
});

test("fresh verification checks every registered slot and protected indexes read-only", async () => {
  const f = fake(), journal = await setupCoordinatorStore(f.connection, coordinatorSetupApproval, f.persist); f.calls.length = 0;
  const result = await verifyCoordinatorCleanup(f.connection, f.manifest, journal);
  assert.equal(result.registeredRecords, 64); assert.equal(result.uniqueDocumentIds, 57);
  assert.equal(f.calls.filter((call) => call.method === "findOne").length, 10);
  assert.equal(f.calls.some((call) => ["insertOne", "updateOne", "deleteMany", "createCollection", "createIndex"].includes(call.method)), false);
  f.fail.leftover = true; await assert.rejects(verifyCoordinatorCleanup(f.connection, f.manifest, journal));
  f.fail.leftover = false; f.indexes.carts.push({ name: "changed", key: { user: 1 }, unique: true });
  await assert.rejects(verifyCoordinatorCleanup(f.connection, f.manifest, journal));
});

test("all seven seeds bind owned subjects and exact warehouse source cards without personal data", () => {
  const manifest = createCoordinatorManifest(); const emails = new Set();
  for (let index = 0; index < coordinatorCases.length; index++) {
    const seed = coordinatorSeed(manifest, index), catalog = storedCatalogDto(seed.assistantmessages.catalogJson);
    assert.equal(catalog.status, "results"); assert.equal(catalog.subjectId, `pet:${seed.pets._id}`);
    assert.equal(catalog.effectiveWarehouseId, manifest.warehouse); assert.equal(catalog.products[0].id, manifest.product);
    assert.equal(String(seed.pets.petOwner), String(seed.users._id)); assert.equal(String(seed.assistantruns.responseMessage), String(seed.assistantmessages._id));
    emails.add(seed.users.email); assert.match(seed.users.email, /@example\.invalid$/);
  }
  assert.equal(emails.size, 7);
});

test("immutable fixture proposals pass the real service guards and confirm/replay without replacing proposal logic", async (t) => {
  const s = cartProposalFixture(t, { confirmation: true }), manifest = createCoordinatorManifest();
  manifest.records.users[0] = String(s.owner); manifest.product = P; manifest.warehouse = W; manifest.foodCategory = F; manifest.nonFoodCategory = C;
  const seed = coordinatorSeed(manifest, 0);
  s.user = seed.users; s.account = seed.assistantaccounts; s.chat = seed.assistantchats; s.source = seed.assistantmessages;
  s.run = seed.assistantruns; s.pets = [seed.pets]; s.catalog = JSON.parse(seed.assistantmessages.catalogJson);
  s.cart = new CartModel({ _id: manifest.records.assistanttestcarts[0], user: s.owner, warehouse: W, __v: 7,
    items: [{ product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }], totalCartPrice: 300 }).toObject();
  const quote = await previewCartAdditionService({ userId: String(s.owner), warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2, lang: "en" });
  const record = coordinatorProposal(manifest, 0, seed, quote, s.config, subjectFingerprint(subjectFromPet(seed.pets)), cartAdditionQuoteForComparison);
  s.records.push(record); const proposal = { id: String(record._id), version: 1, fingerprint: record.fingerprint };
  assert.equal((await s.check(proposal)).ready, true); assert.equal((await s.confirm(proposal)).duplicate, false);
  assert.equal((await s.confirm(proposal)).duplicate, true); assert.equal(s.cart.items[0].quantity, 5); assert.equal(s.receipts.length, 1);
});

test("model adapter scopes reads, session-bound fences and receipt writes; foreign operations and DDL fail", async (t) => {
  const f = fake({ proposal: true }), models = { users: UserModel, pets: PetModel, assistantaccounts: assistant.AssistantAccount,
    assistantchats: assistant.AssistantChat, assistantruns: assistant.AssistantRun, assistantmessages: assistant.AssistantMessage,
    assistantdietarywarnings: assistant.AssistantDietaryWarning, assistanttestcarts: CartModel,
    assistanttestcartproposals: AssistantCartProposal, assistanttestcartreceipts: AssistantCartReceipt };
  const guard = installCoordinatorBoundaries(t, f.connection, f.manifest, models, Object.values(assistant.assistantModels));
  const session = { client: f.client, inTransaction: () => true }, userId = oid(f.manifest.records.users[0]);
  await UserModel.collection.findOne({ _id: userId }, { session });
  assert.equal(f.calls.at(-1).filter.$and[1].assistantTestRun, f.manifest.marker);
  await assistant.AssistantAccount.collection.updateOne({ _id: oid(f.manifest.records.assistantaccounts[0]), owner: { $eq: userId, $exists: true } }, { $inc: { __v: 1 } }, { session });
  assert.equal(f.calls.at(-1).name, "assistantaccounts");
  await assert.rejects(assistant.AssistantAccount.collection.updateOne({ _id: oid(f.manifest.records.assistantaccounts[0]) }, { $set: { blocked: false } }, { session }));
  assert.throws(() => UserModel.collection.findOne({ _id: new mongoose.Types.ObjectId() }, { session }));
  assert.throws(() => ProductModel.collection.findOne({})); assert.throws(() => CartModel.collection.deleteMany({}));
  await assert.rejects(AssistantCartReceipt.collection.insertOne({ _id: oid(f.manifest.records.assistanttestcartreceipts[0]), owner: userId,
    cartId: oid(f.manifest.records.assistanttestcarts[1]) }, { session }));
  assert.throws(() => f.connection.db.collection("carts")); assert.throws(() => UserModel.createCollection());
  assert.throws(() => f.client.db("other"));
  await assert.rejects(assistant.AssistantAccount.collection.updateOne({ _id: oid(f.manifest.records.assistantaccounts[0]) }, { $inc: { __v: 1 } }, { session, upsert: true }));
  await guard.compete(1); assert.deepEqual(f.calls.at(-1).update, { $set: { active: false } });
  await guard.compete(2); assert.deepEqual(f.calls.at(-1).update, { $set: { blocked: true } });
  await guard.compete(3); assert.equal(f.calls.at(-1).update.$inc.contextVersion, 1);
  await guard.compete(4); assert.deepEqual(f.calls.at(-1).update.$set.chronic_conditions, ["Fixture dietary condition"]);
  await guard.compete(5); assert.equal(f.calls.filter((call) => call.method === "transaction").length, 1);
  assert.equal(f.calls.find((call) => call.method === "insertOne").name, "assistantdietarywarnings");
  await assert.rejects(guard.compete(0)); await assert.rejects(guard.compete(7));
});

test("coordinator journal loader rejects path escape, corrupt JSON and oversized files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "petyard-coordinator-")), name = "cart-coordinator-setup-12345678-1234-1234-1234-123456789012.json";
  const path = join(directory, name), base = pathToFileURL(directory + "/");
  t.after(async () => { await unlink(path); await rmdir(directory); });
  await writeFile(path, '{"status":"fixture"}'); assert.deepEqual(await readCoordinatorJournal(base, name), { status: "fixture" });
  await assert.rejects(readCoordinatorJournal(base, `../${name}`)); await assert.rejects(readCoordinatorJournal(base, ".env"));
  await writeFile(path, "{"); await assert.rejects(readCoordinatorJournal(base, name), SyntaxError);
  await writeFile(path, Buffer.alloc(2_000_001)); await assert.rejects(readCoordinatorJournal(base, name));
});

test("setup snapshots replace a synced file atomically and report directory sync support", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "petyard-coordinator-journal-")), name = "cart-coordinator-setup-12345678-1234-1234-1234-123456789012.json";
  const path = join(directory, name), base = pathToFileURL(directory + "/");
  t.after(async () => { await unlink(path); await rmdir(directory); });
  await writeFile(path, '{"status":"prior"}');
  const persisted = await writeCoordinatorJournal(base, name, { pending: "createCollection", completed: [] });
  assert.equal(persisted.fileSynced, true); assert.equal(persisted.atomicReplacement, true); assert.equal(typeof persisted.directorySynced, "boolean");
  assert.deepEqual(await readCoordinatorJournal(base, name), { pending: "createCollection", completed: [] });
  await writeCoordinatorJournal(base, name, { pending: null, completed: ["createCollection"] });
  assert.deepEqual(await readCoordinatorJournal(base, name), { pending: null, completed: ["createCollection"] });
  await assert.rejects(writeCoordinatorJournal(base, ".env", {}));
  await assert.rejects(writeCoordinatorJournal(base, name, { value: "x".repeat(2_000_001) }));
  assert.deepEqual(await readCoordinatorJournal(base, name), { pending: null, completed: ["createCollection"] });
});
