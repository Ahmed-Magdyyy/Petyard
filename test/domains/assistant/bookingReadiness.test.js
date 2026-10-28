import assert from "node:assert/strict";
import test from "node:test";
import { bookingReadinessStores, bookingReadinessFromStores, readBookingReadiness } from "./fixtures/bookingReadiness.js";

const id = () => ({ name: "_id_", key: { _id: 1 } });
const store = indexes => ({ type: "collection", options: {}, indexes: [id(), ...indexes] });
function metadata() {
  return { servicereservations: store([{ name: "user_1_startsAt_1", key: { user: 1, startsAt: 1 }, unique: true, partialFilterExpression: { status: "BOOKED" } }]),
    serviceslotinventories: store([{ name: "location_1_roomType_1_startsAt_1", key: { location: 1, roomType: 1, startsAt: 1 }, unique: true }]),
    notificationoutboxes: store([{ name: "dedupeKey_1", key: { dedupeKey: 1 }, unique: true }]),
    assistantbookingproposals: null, assistantbookingreceipts: null };
}
function readyStores() {
  return { ...metadata(), assistantbookingproposals: store([
    { name: "owner_1_key_1", key: { owner: 1, key: 1 }, unique: true },
    { name: "detailsCleanupAttemptedAt_1_detailsExpireAt_1__id_1", key: { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 } },
  ]), assistantbookingreceipts: store([
    { name: "notificationPending_1_notificationAttemptedAt_1_recordedAt_1__id_1", key: { notificationPending: 1, notificationAttemptedAt: 1, recordedAt: 1, _id: 1 } },
  ]) };
}
function fixture(stores = metadata()) {
  const s = { stores, counts: { assistantbookingproposals: 0, assistantbookingreceipts: 0 }, calls: [], reads: 0 };
  const db = { databaseName: "petyard", listCollections({ name }, options) {
    assert.ok(bookingReadinessStores.includes(name)); assert.deepEqual(options, { nameOnly: false, maxTimeMS: 5000 });
    s.calls.push(["metadata", name]); s.reads++; s.onRead?.(s.reads);
    return { toArray: async () => stores[name] ? [{ name, type: stores[name].type, options: structuredClone(stores[name].options) }] : [] };
  }, collection(name) {
    assert.ok(bookingReadinessStores.includes(name) && stores[name]);
    return { listIndexes(options) {
      assert.deepEqual(options, { maxTimeMS: 5000 }); s.calls.push(["indexes", name]);
      return { toArray: async () => structuredClone(stores[name].indexes) };
    }, async countDocuments(filter, options) {
      assert.ok(name.startsWith("assistantbooking")); assert.deepEqual(filter, {});
      assert.deepEqual(options, { maxTimeMS: 5000, readConcern: { level: "majority" } }); s.calls.push(["count", name]); return s.counts[name];
    } };
  } };
  const client = { options: { srvHost: "magdy.pbupj.mongodb.net", dbName: "petyard" } };
  s.connection = { db, name: "petyard", readyState: 1, getClient: () => client }; return s;
}
test("read-only metadata inventory reports missing assistant stores without touching ordinary documents", async () => {
  const s = fixture(), result = await readBookingReadiness(s.connection);
  assert.equal(result.additiveAssistantSetupCandidate, true); assert.equal(result.assistantStoresBothAbsent, true);
  assert.deepEqual(result.readiness, { confirmation: false, retention: false, notifications: false });
  assert.deepEqual(result.assistantDocumentCounts, { assistantbookingproposals: null, assistantbookingreceipts: null });
  assert.equal(s.calls.length, 16); assert.equal(result.dataWrites, 0); assert.equal(result.schemaWrites, 0);
  assert.ok(s.calls.every(([method]) => ["metadata", "indexes"].includes(method)));
});
test("existing compatible stores report readiness, count only assistant rows and preserve extra ordinary indexes", async () => {
  const s = fixture(readyStores()); s.counts.assistantbookingproposals = 3; s.counts.assistantbookingreceipts = 2;
  s.stores.servicereservations.indexes.push({ name: "ordinary_status", key: { status: 1 } });
  const result = await readBookingReadiness(s.connection);
  assert.deepEqual(result.readiness, { confirmation: true, retention: true, notifications: true });
  assert.deepEqual(result.assistantDocumentCounts, s.counts); assert.equal(result.additiveAssistantSetupCandidate, false);
  assert.deepEqual(result.missingRequirements, []); assert.equal(result.stores.servicereservations.indexes.length, 3);
});
test("missing ordinary constraints prevent proposing assistant-only setup and are never repaired", async () => {
  for (const name of ["servicereservations", "serviceslotinventories", "notificationoutboxes"]) {
    const s = fixture(); s.stores[name] = null; const result = await readBookingReadiness(s.connection);
    assert.equal(result.additiveAssistantSetupCandidate, false); assert.ok(result.missingRequirements.length >= 5);
  }
});
test("reservation partial predicate, order and uniqueness must match the runtime writer", () => {
  for (const changes of [{ unique: false }, { sparse: true }, { collation: { locale: "en", strength: 2 } },
    { key: { startsAt: 1, user: 1 } }, { partialFilterExpression: { status: "IN_PROGRESS" } }, { partialFilterExpression: undefined }]) {
    const stores = readyStores(); Object.assign(stores.servicereservations.indexes[1], changes);
    assert.equal(bookingReadinessFromStores(stores).requirements.reservationUnique, false);
  }
});
test("TTL on any observed store blocks its relevant readiness without deleting or altering it", () => {
  for (const name of bookingReadinessStores) {
    const stores = readyStores(); stores[name].indexes.push({ name: "unexpected_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 5 });
    const result = bookingReadinessFromStores(stores); assert.ok(result.missingRequirements.length > 0);
  }
});
test("scan indexes cannot be hidden/partial/sparse/case-folding while hidden unique constraints still enforce uniqueness", () => {
  for (const name of ["assistantbookingproposals", "assistantbookingreceipts"]) for (const changes of [
    { hidden: true }, { sparse: true }, { partialFilterExpression: { active: true } }, { collation: { locale: "en" } },
  ]) {
    const stores = readyStores(); Object.assign(stores[name].indexes.at(-1), changes);
    assert.equal(bookingReadinessFromStores(stores).requirements[name === "assistantbookingproposals" ? "proposalCleanupScan" : "receiptNotificationScan"], false);
  }
  const stores = readyStores(); stores.serviceslotinventories.indexes[1].hidden = true;
  assert.equal(bookingReadinessFromStores(stores).requirements.inventoryUnique, true);
});
test("wrong or changed target and changing metadata stop the read-only pass", async () => {
  const wrong = fixture(); wrong.connection.name = "other"; await assert.rejects(readBookingReadiness(wrong.connection)); assert.equal(wrong.calls.length, 0);
  const changed = fixture(); changed.onRead = count => { if (count === 1) changed.connection.name = "other"; };
  await assert.rejects(readBookingReadiness(changed.connection)); assert.equal(changed.calls.length, 1);
  const metadataChange = fixture(); metadataChange.onRead = count => { if (count === 6) metadataChange.stores.servicereservations.indexes.push({ name: "changed", key: { x: 1 } }); };
  await assert.rejects(readBookingReadiness(metadataChange.connection), /metadata changed/);
});
test("views, capped and time-series stores cannot claim ordinary collection readiness", async () => {
  for (const incompatible of [{ type: "view" }, { options: { capped: true } }, { options: { timeseries: { timeField: "time" } } }]) {
    const s = fixture(readyStores()); Object.assign(s.stores.assistantbookingreceipts, incompatible);
    const result = await readBookingReadiness(s.connection); assert.equal(result.requirements.receiptIdentity, false);
    assert.equal(result.assistantDocumentCounts.assistantbookingreceipts, "not_counted_incompatible_store");
  }
});
test("malformed or excessive metadata and invalid count output fail without exposing document contents", async () => {
  const many = fixture(); many.stores.servicereservations.indexes = Array.from({ length: 65 }, (_, n) => ({ name: String(n), key: { x: 1 } }));
  await assert.rejects(readBookingReadiness(many.connection), /Invalid or excessive/);
  const invalid = fixture(readyStores()); invalid.counts.assistantbookingproposals = { owner: "PRIVATE" };
  await assert.rejects(readBookingReadiness(invalid.connection), /Invalid count/);
  const malformed = fixture(); malformed.stores.servicereservations.indexes[0].key = null;
  await assert.rejects(readBookingReadiness(malformed.connection), /Invalid or excessive/);
});
