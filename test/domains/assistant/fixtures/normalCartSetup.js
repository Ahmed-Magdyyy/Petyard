import assert from "node:assert/strict";
import { sharedMongoConnection } from "./sharedMongo.js";
import { readCartReadiness } from "./cartReadiness.js";

export const normalCartSetupApproval = "create-reviewed-normal-assistant-cart-stores";
const baseline = {
  carts: { type: "collection", options: {}, indexes: [
    { key: { _id: 1 }, name: "_id_" }, { key: { checkoutKey: 1 }, name: "checkoutKey_1" },
    { key: { guestId: 1 }, name: "guestId_1" }, { key: { lastActivityAt: 1 }, name: "lastActivityAt_1" },
    { key: { status: 1 }, name: "status_1" }, { key: { status: 1, lastActivityAt: 1 }, name: "status_1_lastActivityAt_1" },
    { key: { user: 1 }, name: "user_1" }, { key: { warehouse: 1 }, name: "warehouse_1" },
  ] }, assistantcartproposals: null, assistantcartreceipts: null,
};
const signedInIndex = { name: "assistant_signed_in_user_unique", key: { user: 1 }, unique: true,
  partialFilterExpression: { user: { $type: "objectId" } } };
const proposalIndex = { name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true };
const withIndex = (metadata, store, index) => ({ ...structuredClone(metadata), [store]: {
  ...structuredClone(metadata[store]), indexes: [...metadata[store].indexes, structuredClone(index)].sort((a, b) => a.name.localeCompare(b.name)),
} });
const withStore = (metadata, store) => ({ ...structuredClone(metadata), [store]: {
  type: "collection", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }],
} });
const metadataOf = (readiness) => readiness.stores;

export async function inspectNormalCartServer(connection) {
  const { db, check } = sharedMongoConnection(connection);
  check(); const hello = await db.admin().command({ hello: 1, maxTimeMS: 5000 });
  assert.ok(hello.isWritablePrimary === true && typeof hello.setName === "string" && hello.setName.length > 0 && hello.msg !== "isdbgrid",
    "Only a writable replica-set test target is supported");
  assert.ok(Number.isSafeInteger(hello.maxWireVersion) && hello.maxWireVersion >= 21, "MongoDB 7.0 or later protocol required");
  check(); const build = await db.admin().command({ buildInfo: 1, maxTimeMS: 5000 });
  assert.ok(typeof build.version === "string" && /^\d+\.\d+\.\d+$/.test(build.version), "A released server build is required");
  const version = build.version.split(".").map(Number);
  assert.ok(version.every(Number.isSafeInteger) && version[0] >= 7 && build.debug !== true, "Released MongoDB 7.0 or later required");
  assert.ok(Array.isArray(build.versionArray) && build.versionArray.length === 4 && build.versionArray.every(Number.isSafeInteger),
    "A four-integer released version array is required");
  assert.deepEqual(build.versionArray, [...version, 0], "Server build version fields disagree or indicate a nonrelease build");
  // Atlas tiers can block FCV reads. These older index features use a conservative released-server floor; FCV/upgrade stability is not attested.
  return { maxWireVersion: hello.maxWireVersion, serverVersion: build.version, writableReplicaSet: true, compatibilityCheck: "atlas-build-info-v2",
    featureCompatibilityVersionVerified: false };
}

async function assertReady(connection, expected, expectedBaseline) {
  const readiness = await readCartReadiness(connection);
  assert.deepEqual(metadataOf(readiness), expected, "Store metadata differs from the reviewed setup step");
  assert.deepEqual(expectedBaseline, baseline, "Expected metadata must be the reviewed inventory baseline");
  assert.ok(readiness.ownerTypes.every(({ type }) => ["missing", "null", "objectId"].includes(type)), "Unexpected user BSON type blocks setup");
  assert.deepEqual(readiness.duplicateOwners, { owners: 0, carts: 0, extraCarts: 0 }, "Duplicate signed-in carts block setup");
  const { db, check } = sharedMongoConnection(connection);
  for (const name of ["assistantcartproposals", "assistantcartreceipts"]) if (expected[name]) {
    check(); assert.equal(await db.collection(name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }), 0,
      "New application fixture stores must stay empty during setup verification");
  }
  return readiness;
}

export async function setupNormalCartStores(connection, approval, expectedMetadata, persist) {
  assert.equal(approval, normalCartSetupApproval, "Normal cart schema setup requires explicit owner approval");
  assert.equal(typeof persist, "function");
  const { db, check } = sharedMongoConnection(connection);
  assert.deepEqual(expectedMetadata, baseline, "Only the reviewed normal cart inventory is supported");
  const server = await inspectNormalCartServer(connection);
  let expected = structuredClone(baseline);
  const journal = { host: connection.getClient().options.srvHost, database: "petyard", plan: [
    "createIndex:carts:assistant_signed_in_user_unique", "createCollection:assistantcartproposals",
    "createIndex:assistantcartproposals:owner_1_key_1", "createCollection:assistantcartreceipts",
  ], before: structuredClone(baseline), expectedBaseline: structuredClone(baseline), server, completed: [], pending: null, status: "ready" };
  await assertReady(connection, expected, expectedMetadata);
  await persist(structuredClone(journal));
  const mutate = async (operation, action, next) => {
    await assertReady(connection, expected, expectedMetadata);
    journal.pending = operation;
    await persist(structuredClone(journal));
    check(); await action(); expected = next(expected);
    await assertReady(connection, expected, expectedMetadata);
    journal.completed.push(operation); journal.pending = null;
    await persist(structuredClone(journal));
  };
  await mutate(journal.plan[0], () => db.collection("carts").createIndex(signedInIndex.key, {
    name: signedInIndex.name, unique: true, partialFilterExpression: signedInIndex.partialFilterExpression,
    writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 120000,
  }), (current) => withIndex(current, "carts", signedInIndex));
  await mutate(journal.plan[1], () => db.createCollection("assistantcartproposals", { writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 120000 }),
    (current) => withStore(current, "assistantcartproposals"));
  await mutate(journal.plan[2], () => db.collection("assistantcartproposals").createIndex(proposalIndex.key, {
    name: proposalIndex.name, unique: true, writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 120000,
  }), (current) => withIndex(current, "assistantcartproposals", proposalIndex));
  await mutate(journal.plan[3], () => db.createCollection("assistantcartreceipts", { writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 120000 }),
    (current) => withStore(current, "assistantcartreceipts"));
  journal.status = "verified_normal_cart_and_assistant_stores";
  await assertReady(connection, expected, expectedMetadata);
  assert.deepEqual(expected.carts.options, baseline.carts.options);
  journal.expected = structuredClone(expected);
  await persist(structuredClone(journal));
  return journal;
}

export async function verifyNormalCartStores(connection, journal) {
  const { check } = sharedMongoConnection(connection);
  assert.equal(journal?.status, "verified_normal_cart_and_assistant_stores");
  assert.equal(journal.host, connection.getClient().options.srvHost);
  assert.equal(journal.database, "petyard");
  assert.deepEqual(journal.plan, ["createIndex:carts:assistant_signed_in_user_unique", "createCollection:assistantcartproposals",
    "createIndex:assistantcartproposals:owner_1_key_1", "createCollection:assistantcartreceipts"]);
  assert.deepEqual(journal.completed, journal.plan); assert.equal(journal.pending, null);
  assert.deepEqual(journal.before, baseline); assert.deepEqual(journal.expectedBaseline, baseline);
  assert.deepEqual(await inspectNormalCartServer(connection), journal.server, "Server compatibility changed; inspect manually");
  const expected = withStore(withIndex(withStore(withIndex(baseline, "carts", signedInIndex), "assistantcartproposals"),
    "assistantcartproposals", proposalIndex), "assistantcartreceipts");
  assert.deepEqual(journal.expected, expected);
  check();
  await assertReady(connection, expected, baseline);
  return { status: "normal_cart_stores_verified", stores: structuredClone(expected) };
}
