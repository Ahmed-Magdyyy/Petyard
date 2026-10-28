import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, sharedMongoConnection, sharedMongoRecords } from "./sharedMongo.js";
import { cartSetupPlan, protectedCartStores } from "./isolatedCart.js";

export const coordinatorOptIn = "owned-cart-coordinator-records-only";
export const coordinatorSetupApproval = "create-one-empty-isolated-cart-proposal-store";
export const coordinatorProposalStore = "assistanttestcartproposals";
export const coordinatorCases = Object.freeze(["success", "user_deactivated", "account_blocked", "chat_changed", "pet_changed", "warning_added", "receipt_failure"]);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oid = (id) => new mongoose.Types.ObjectId(id);
const proposalIndexes = [{ name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true }];
const sorted = (indexes) => indexes.map(({ v, ...entry }) => entry).sort((a, b) => a.name.localeCompare(b.name));
const sameIndexes = (actual, expected) => assert.deepEqual(sorted(actual), sorted([{ name: "_id_", key: { _id: 1 } }, ...expected]));

export function createCoordinatorManifest() {
  return { ...createSharedMongoManifest("cartCoordinator"), product: String(new mongoose.Types.ObjectId()),
    foodCategory: String(new mongoose.Types.ObjectId()), nonFoodCategory: String(new mongoose.Types.ObjectId()) };
}
function validateManifest(manifest) {
  assert.equal(manifest.suite, "cartCoordinator");
  assert.deepEqual(manifest.records.assistanttestcartreceipts, manifest.records.assistanttestcartproposals);
  const ids = [...Object.entries(manifest.records).filter(([name]) => name !== "assistanttestcartreceipts").flatMap(([, values]) => values), manifest.warehouse, manifest.product, manifest.foodCategory, manifest.nonFoodCategory];
  for (const id of ids) assert.match(id, /^[a-f\d]{24}$/);
  assert.equal(new Set(ids).size, ids.length);
}
function coordinatorJournalPath(directory, name) {
  assert.ok(typeof name === "string" && /^cart-coordinator-setup-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.json$/.test(name));
  const path = new URL(name, directory); assert.equal(path.protocol, "file:"); return path;
}
export async function writeCoordinatorJournal(directory, name, value) {
  const path = coordinatorJournalPath(directory, name), temporary = new URL(`${name}.tmp-${randomUUID()}`, directory);
  const raw = `${JSON.stringify(value, null, 2)}\n`; assert.ok(Buffer.byteLength(raw) <= 2_000_000);
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  let directorySynced = false;
  try {
    const parent = await open(new URL("./", path), "r");
    try { await parent.sync(); directorySynced = true; } finally { await parent.close(); }
  } catch (error) { if (!["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
  // Windows may not support directory fsync; file contents are synced, while power-loss metadata durability is not promised.
  return { fileSynced: true, atomicReplacement: true, directorySynced };
}
export async function readCoordinatorJournal(directory, name) {
  const handle = await open(coordinatorJournalPath(directory, name), "r");
  try {
    const metadata = await handle.stat(); assert.ok(metadata.isFile() && metadata.size <= 2_000_000);
    const raw = await handle.readFile("utf8"); assert.ok(Buffer.byteLength(raw) <= 2_000_000); return JSON.parse(raw);
  } finally { await handle.close(); }
}

export async function setupCoordinatorStore(connection, approval, persist) {
  assert.equal(approval, coordinatorSetupApproval); assert.equal(typeof persist, "function");
  const { db, check } = sharedMongoConnection(connection);
  const manifest = createCoordinatorManifest();
  const protectedNames = [...new Set([...Object.keys(manifest.records).filter((name) => name !== coordinatorProposalStore), ...protectedCartStores])];
  const journal = { host: manifest.host, database: manifest.database, status: "preflight", collection: coordinatorProposalStore,
    indexes: structuredClone(proposalIndexes), before: {}, completed: [], pending: null };
  const exists = async (name) => { check(); return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0; };
  assert.equal(await exists(coordinatorProposalStore), false, "Setup refuses an existing proposal test store");
  for (const name of protectedNames) {
    const present = await exists(name);
    if (Object.hasOwn(manifest.records, name)) assert.ok(present, `Required existing fixture store missing: ${name}`);
    journal.before[name] = present ? await db.collection(name).listIndexes().toArray() : null;
  }
  journal.status = "ready"; await persist(structuredClone(journal));
  const mutate = async (operation, action) => {
    journal.pending = operation; await persist(structuredClone(journal)); check();
    await action(); journal.completed.push(operation); journal.pending = null; await persist(structuredClone(journal));
  };
  assert.equal(await exists(coordinatorProposalStore), false);
  await mutate("createCollection", () => db.createCollection(coordinatorProposalStore, { writeConcern: { w: "majority" } }));
  const [{ key, ...options }] = proposalIndexes;
  await mutate("createIndex:owner_1_key_1", () => db.collection(coordinatorProposalStore).createIndex(key, { ...options, writeConcern: { w: "majority" } }));
  check(); assert.equal(await db.collection(coordinatorProposalStore).countDocuments({}, { maxTimeMS: 5000 }), 0);
  sameIndexes(await db.collection(coordinatorProposalStore).listIndexes().toArray(), proposalIndexes);
  await verifyProtected(connection, journal);
  journal.status = "verified_empty_proposal_store_protected_indexes_unchanged"; await persist(structuredClone(journal));
  return journal;
}
async function verifyProtected(connection, journal) {
  const { db, check } = sharedMongoConnection(connection);
  assert.equal(journal.host, connection.getClient().options.srvHost); assert.equal(journal.database, "petyard");
  const expected = [...new Set([...Object.keys(createCoordinatorManifest().records).filter((name) => name !== coordinatorProposalStore), ...protectedCartStores])].sort();
  assert.deepEqual(Object.keys(journal.before).sort(), expected);
  for (const [name, before] of Object.entries(journal.before)) {
    check(); assert.equal((await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0, before !== null);
    if (before !== null) { check(); assert.deepEqual(sorted(await db.collection(name).listIndexes().toArray()), sorted(before)); }
  }
}
export async function verifyCoordinatorCleanup(connection, manifest, journal) {
  validateManifest(manifest); sharedMongoRecords(connection, manifest);
  assert.equal(journal.status, "verified_empty_proposal_store_protected_indexes_unchanged");
  assert.equal(journal.pending, null); assert.equal(journal.collection, coordinatorProposalStore);
  assert.deepEqual(journal.completed, ["createCollection", "createIndex:owner_1_key_1"]); assert.deepEqual(journal.indexes, proposalIndexes);
  await verifyProtected(connection, journal);
  const { db, check } = sharedMongoConnection(connection);
  for (const [name, indexes] of Object.entries({ ...cartSetupPlan(), [coordinatorProposalStore]: proposalIndexes })) {
    check(); sameIndexes(await db.collection(name).listIndexes().toArray(), indexes);
  }
  for (const [name, ids] of Object.entries(manifest.records)) {
    check(); assert.equal(await db.collection(name).findOne({ _id: { $in: ids.map(oid) } }, { projection: { _id: 1 }, maxTimeMS: 5000 }), null, "Registered coordinator ID remains");
  }
  return { status: "coordinator_ids_absent_isolated_and_protected_indexes_unchanged", marker: manifest.marker,
    registeredRecords: Object.values(manifest.records).flat().length, uniqueDocumentIds: new Set(Object.values(manifest.records).flat()).size };
}

export function coordinatorSeed(manifest, index, now = new Date()) {
  validateManifest(manifest); assert.ok(Number.isInteger(index) && index >= 0 && index < coordinatorCases.length);
  const id = (name) => oid(manifest.records[name][index]), owner = id("users"), subjectId = `pet:${id("pets")}`;
  const expiresAt = new Date(now.getTime() + 1800000);
  const catalog = { version: 1, status: "results", subjectId, subjectName: "Fixture cat", requestedWarehouseId: manifest.warehouse,
    effectiveWarehouseId: manifest.warehouse, rerouted: false, generatedAt: now.toISOString(), dataMode: "snapshot", currency: "EGP",
    suitability: "not_verified", notices: [], products: [{ id: manifest.product, slug: "fixture-item", name: "Fixture item", type: "SIMPLE", image: null,
      price: 100, discountedPrice: null, inStock: true, hasVariants: false, priceDisplay: "exact" }] };
  return {
    users: { _id: owner, __v: 0, email: `${manifest.marker}_${index}@example.invalid`, active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed" },
    pets: { _id: id("pets"), __v: 0, petOwner: owner, name: "Fixture cat", type: "cat", chronic_conditions: [], temp_health_issues: [] },
    assistantaccounts: { _id: id("assistantaccounts"), __v: 0, owner, blocked: false, activeRun: null },
    assistantchats: { _id: id("assistantchats"), __v: 0, owner, activeSubject: subjectId, subjects: [], contextVersion: 0, nextSequence: 2, contextAfterSequence: 0 },
    assistantruns: { _id: id("assistantruns"), owner, chat: id("assistantchats"), purpose: "customer", status: "completed", responseMessage: id("assistantmessages"), key: `${manifest.marker}_${index}` },
    assistantmessages: { _id: id("assistantmessages"), owner, chat: id("assistantchats"), run: id("assistantruns"), role: "assistant", sequence: 2,
      subjectId, text: "Synthetic catalog source", catalogJson: JSON.stringify(catalog), expiresAt, createdAt: now },
  };
}
// Fixed, immutable confirmation fixtures; proposal preparation persistence is outside this test's claim.
export function coordinatorProposal(manifest, index, seed, quote, config, profileFingerprint, materialQuote) {
  const args = { sourceMessageId: String(seed.assistantmessages._id), warehouseId: manifest.warehouse, productId: manifest.product,
    variantId: null, quantity: 2, language: "en" };
  const record = { _id: oid(manifest.records[coordinatorProposalStore][index]), owner: seed.users._id, key: `${manifest.marker}_${index}`,
    inputJson: JSON.stringify(args), requestHash: hash(args), binding: hash({ source: String(seed.assistantmessages._id), catalog: seed.assistantmessages.catalogJson,
      chat: String(seed.assistantchats._id), contextVersion: 0, subject: profileFingerprint, warnings: [], config: config.signature }),
    quoteJson: JSON.stringify(quote), version: 1, expiresAt: seed.assistantmessages.expiresAt };
  record.fingerprint = hash({ id: String(record._id), owner: String(record.owner), requestHash: record.requestHash, binding: record.binding,
    version: 1, expiresAt: record.expiresAt.toISOString(), quote: materialQuote(quote) });
  return record;
}
