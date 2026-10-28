import assert from "node:assert/strict";
import { sharedMongoConnection } from "./sharedMongo.js";

export const bookingReadinessStores = Object.freeze(["servicereservations", "serviceslotinventories", "notificationoutboxes",
  "assistantbookingproposals", "assistantbookingreceipts"]);
const proposalName = "assistantbookingproposals", receiptName = "assistantbookingreceipts";
const simple = index => !index.collation || index.collation.locale === "simple";
const full = index => !index.partialFilterExpression && !index.sparse && simple(index) && index.expireAfterSeconds === undefined;
const key = (index, expected) => JSON.stringify(index.key) === JSON.stringify(expected);
const usable = store => store?.type === "collection" && !store.options.capped && !store.options.timeseries &&
  store.indexes.every(index => index.expireAfterSeconds === undefined);
const unique = (store, expected, partial) => usable(store) && store.indexes.some(index => index.unique === true && !index.sparse && simple(index) &&
  key(index, expected) && (partial === undefined ? !index.partialFilterExpression : JSON.stringify(index.partialFilterExpression) === JSON.stringify(partial)));
const scan = (store, expected) => usable(store) && store.indexes.some(index => full(index) && !index.hidden && key(index, expected));
const idIndex = store => usable(store) && store.indexes.some(index => index.name === "_id_" && full(index) && key(index, { _id: 1 }));

export function bookingReadinessFromStores(stores) {
  const reservation = stores.servicereservations, inventory = stores.serviceslotinventories, outbox = stores.notificationoutboxes;
  const proposal = stores[proposalName], receipt = stores[receiptName];
  const requirements = {
    reservationUnique: Boolean(unique(reservation, { user: 1, startsAt: 1 }, { status: "BOOKED" })),
    inventoryUnique: Boolean(unique(inventory, { location: 1, roomType: 1, startsAt: 1 })),
    outboxUnique: Boolean(unique(outbox, { dedupeKey: 1 })),
    proposalUnique: Boolean(unique(proposal, { owner: 1, key: 1 })),
    proposalCleanupScan: Boolean(scan(proposal, { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 })),
    receiptIdentity: Boolean(idIndex(receipt)),
    receiptNotificationScan: Boolean(scan(receipt, { notificationPending: 1, notificationAttemptedAt: 1, recordedAt: 1, _id: 1 })),
  };
  const retention = requirements.proposalUnique && requirements.proposalCleanupScan && requirements.receiptIdentity;
  return { requirements, readiness: {
    confirmation: retention && requirements.reservationUnique && requirements.inventoryUnique,
    retention, notifications: requirements.receiptIdentity && requirements.receiptNotificationScan && requirements.outboxUnique,
  }, missingRequirements: Object.keys(requirements).filter(name => !requirements[name]),
  assistantStoresBothAbsent: proposal === null && receipt === null,
  // A proposed additive setup may touch only absent assistant stores; ordinary-index repair is a separate decision.
  additiveAssistantSetupCandidate: proposal === null && receipt === null && requirements.reservationUnique && requirements.inventoryUnique && requirements.outboxUnique };
}

// Read metadata and assistant-store counts only. No application models or document contents are loaded.
export async function readBookingReadiness(connection) {
  const { db, check } = sharedMongoConnection(connection);
  const read = async operation => { check(); const value = await operation(); check(); return value; };
  const snapshot = async () => {
    const stores = {};
    for (const name of bookingReadinessStores) {
      const rows = await read(() => db.listCollections({ name }, { nameOnly: false, maxTimeMS: 5000 }).toArray());
      assert.ok(rows.length <= 1 && rows.every(row => row.name === name), "Unexpected collection metadata");
      const collection = rows[0];
      if (!collection) { stores[name] = null; continue; }
      const indexes = await read(() => db.collection(name).listIndexes({ maxTimeMS: 5000 }).toArray());
      assert.ok(indexes.length <= 64 && indexes.every(index => typeof index.name === "string" && index.key?.constructor === Object), "Invalid or excessive index metadata");
      stores[name] = { type: collection.type, options: collection.options ?? {},
        indexes: indexes.map(({ v, ...index }) => index).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    return stores;
  };
  const stores = await snapshot(), assistantDocumentCounts = {};
  for (const name of [proposalName, receiptName]) {
    if (stores[name] === null) { assistantDocumentCounts[name] = null; continue; }
    if (!usable(stores[name])) { assistantDocumentCounts[name] = "not_counted_incompatible_store"; continue; }
    const count = await read(() => db.collection(name).countDocuments({}, { maxTimeMS: 5000, readConcern: { level: "majority" } }));
    assert.ok(Number.isSafeInteger(count) && count >= 0, "Invalid count response"); assistantDocumentCounts[name] = count;
  }
  assert.deepEqual(await snapshot(), stores, "Booking store metadata changed during inventory");
  return { host: "magdy.pbupj.mongodb.net", database: "petyard", readOnly: true, metadataStable: true,
    stores, assistantDocumentCounts, ...bookingReadinessFromStores(stores), countsArePointInTime: true,
    dataWrites: 0, schemaWrites: 0, providerCalls: 0, activated: false };
}
