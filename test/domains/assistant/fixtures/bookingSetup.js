import assert from "node:assert/strict";
import { sharedMongoConnection } from "./sharedMongo.js";
import { inspectNormalCartServer } from "./normalCartSetup.js";
import { bookingReadinessStores, bookingReadinessFromStores, readBookingReadiness } from "./bookingReadiness.js";

export const bookingSetupApproval = "create-reviewed-empty-assistant-booking-stores";
export const bookingSetupPlan = Object.freeze([
  "createCollection:assistantbookingproposals", "createIndex:assistantbookingproposals:owner_1_key_1",
  "createIndex:assistantbookingproposals:detailsCleanupAttemptedAt_1_detailsExpireAt_1__id_1",
  "createCollection:assistantbookingreceipts", "createIndex:assistantbookingreceipts:notificationPending_1_notificationAttemptedAt_1_recordedAt_1__id_1",
]);
const indexes = {
  owner: { name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true },
  cleanup: { name: "detailsCleanupAttemptedAt_1_detailsExpireAt_1__id_1", key: { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 } },
  notification: { name: "notificationPending_1_notificationAttemptedAt_1_recordedAt_1__id_1", key: { notificationPending: 1, notificationAttemptedAt: 1, recordedAt: 1, _id: 1 } },
};
const writeOptions = { writeConcern: { w: "majority", wtimeoutMS: 10000 }, maxTimeMS: 30000 };
function baseline(value) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), [...bookingReadinessStores].sort(), "Exact reviewed namespace baseline required");
  assert.equal(bookingReadinessFromStores(value).additiveAssistantSetupCandidate, true, "Both assistant stores must be absent and ordinary constraints compatible");
  return structuredClone(value);
}
function nextState(current, name, index = null) {
  const next = structuredClone(current);
  if (!index) next[name] = { type: "collection", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }] };
  else next[name].indexes.push(structuredClone(index));
  next[name].indexes.sort((a, b) => a.name.localeCompare(b.name)); return next;
}
function finalState(before) {
  let state = nextState(before, "assistantbookingproposals");
  state = nextState(state, "assistantbookingproposals", indexes.owner);
  state = nextState(state, "assistantbookingproposals", indexes.cleanup);
  state = nextState(state, "assistantbookingreceipts");
  return nextState(state, "assistantbookingreceipts", indexes.notification);
}
async function assertState(connection, expected) {
  const snapshot = await readBookingReadiness(connection);
  assert.deepEqual(snapshot.stores, expected, "Booking metadata differs from the reviewed setup step");
  for (const name of ["assistantbookingproposals", "assistantbookingreceipts"]) if (expected[name]) {
    assert.equal(snapshot.assistantDocumentCounts[name], 0, "Assistant stores must remain empty during setup");
  }
  return snapshot;
}
export async function setupBookingStores(connection, approval, reviewedBaseline, persist) {
  assert.equal(approval, bookingSetupApproval, "Explicit one-run owner approval is required"); assert.equal(typeof persist, "function");
  const before = baseline(reviewedBaseline), { db, check } = sharedMongoConnection(connection);
  const server = await inspectNormalCartServer(connection); let expected = structuredClone(before);
  await assertState(connection, expected);
  const journal = { host: "magdy.pbupj.mongodb.net", database: "petyard", before, server, plan: [...bookingSetupPlan],
    completed: [], pending: null, status: "ready" };
  await persist(structuredClone(journal));
  const mutate = async (operation, action, next) => {
    await assertState(connection, expected); journal.pending = operation; await persist(structuredClone(journal));
    check(); await action(); check(); expected = next(expected); await assertState(connection, expected);
    journal.completed.push(operation); journal.pending = null; await persist(structuredClone(journal));
  };
  const create = (name, step) => mutate(bookingSetupPlan[step], () => db.createCollection(name, writeOptions), current => nextState(current, name));
  const index = (name, definition, step) => mutate(bookingSetupPlan[step], () => {
    const { key, ...options } = definition; return db.collection(name).createIndex(key, { ...options, ...writeOptions });
  }, current => nextState(current, name, definition));
  await create("assistantbookingproposals", 0); await index("assistantbookingproposals", indexes.owner, 1);
  await index("assistantbookingproposals", indexes.cleanup, 2); await create("assistantbookingreceipts", 3);
  await index("assistantbookingreceipts", indexes.notification, 4);
  assert.deepEqual(expected, finalState(before)); journal.expected = expected; journal.status = "setup_verified_fresh_connection_pending";
  await persist(structuredClone(journal)); return journal;
}
export async function verifyBookingStores(connection, journal) {
  sharedMongoConnection(connection); assert.equal(journal?.status, "setup_verified_fresh_connection_pending");
  assert.equal(journal.host, "magdy.pbupj.mongodb.net"); assert.equal(journal.database, "petyard");
  const before = baseline(journal.before); assert.deepEqual(journal.plan, [...bookingSetupPlan]);
  assert.deepEqual(journal.completed, [...bookingSetupPlan]); assert.equal(journal.pending, null);
  const expected = finalState(before); assert.deepEqual(journal.expected, expected);
  assert.deepEqual(await inspectNormalCartServer(connection), journal.server, "Server changed since setup");
  const snapshot = await assertState(connection, expected);
  assert.deepEqual(snapshot.readiness, { confirmation: true, retention: true, notifications: true });
  return { status: "empty_booking_stores_freshly_verified", server: journal.server, stores: expected, dataWrites: 0, schemaSteps: 5, activated: false };
}
