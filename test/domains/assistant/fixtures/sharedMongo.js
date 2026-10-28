import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { authorizedAssistantAtlasHost } from "./mongoTarget.js";

export const sharedMongoConfirmation = "test-cluster-petyard-owned-records-only";
const suites = {
  analytics: { users: 1, products: 2, orders: 2 },
  persistence: { users: 2, assistantaccounts: 1, assistantchats: 1, assistantadminchats: 2,
    assistantruns: 4, assistantmessages: 1, assistantadminmessages: 2 },
  catalogPublication: { users: 2, assistantaccounts: 1, assistantchats: 1, assistantruns: 1,
    assistantmessages: 2, assistantdietarywarnings: 1 },
  catalogRead: { categories: 3, subcategories: 2, brands: 1, warehouses: 4, products: 10, collections: 3 },
  catalogPipeline: { users: 2, assistantaccounts: 1, assistantchats: 1, assistantruns: 1,
    assistantmessages: 2, assistantdietarywarnings: 1, assistantevents: 4, categories: 1, warehouses: 1, products: 1,
    subcategories: 0, brands: 0, collections: 0, pets: 0, assistantmemories: 0 },
  cartCoordinator: { users: 7, pets: 7, assistantaccounts: 7, assistantchats: 7, assistantruns: 7,
    assistantmessages: 7, assistantdietarywarnings: 1, assistanttestcarts: 7, assistanttestcartproposals: 7, assistanttestcartreceipts: 7 },
};
const persistenceIndexes = {
  assistantaccounts: [{ owner: 1 }], assistantchats: [{ owner: 1 }], assistantadminchats: [{ owner: 1 }],
  assistantruns: [{ owner: 1, key: 1 }], assistantmessages: [{ chat: 1, sequence: 1 }, { run: 1, role: 1 }],
  assistantadminmessages: [{ chat: 1, sequence: 1 }, { run: 1, role: 1 }],
};

export function validateSharedMongoTarget(value, confirmation) {
  let uri;
  try { uri = new URL(value); } catch { throw new Error("Invalid shared assistant test target"); }
  const keys = [...uri.searchParams.keys()];
  if (confirmation !== sharedMongoConfirmation || uri.protocol !== "mongodb+srv:" ||
      uri.hostname !== authorizedAssistantAtlasHost || uri.pathname !== "/petyard" || uri.port || uri.hash ||
      !uri.username || !uri.password || new Set(keys).size !== keys.length ||
      keys.some((key) => !["retryWrites", "w", "appName", "authSource"].includes(key)) ||
      (uri.searchParams.has("retryWrites") && uri.searchParams.get("retryWrites") !== "true") ||
      (uri.searchParams.has("w") && uri.searchParams.get("w") !== "majority") ||
      (uri.searchParams.has("authSource") && uri.searchParams.get("authSource") !== "admin")) {
    throw new Error("Shared assistant test target is not authorized");
  }
  return uri;
}

export function createSharedMongoManifest(suite = "analytics") {
  if (!Object.hasOwn(suites, suite)) throw new Error("Unknown shared assistant test suite");
  const ids = (count) => Array.from({ length: count }, () => String(new mongoose.Types.ObjectId()));
  const records = Object.fromEntries(Object.entries(suites[suite]).map(([name, count]) => [name, ids(count)]));
  if (suite === "cartCoordinator") records.assistanttestcartreceipts = [...records.assistanttestcartproposals];
  return { marker: `assistant_shared_${randomUUID()}`, host: authorizedAssistantAtlasHost, database: "petyard",
    suite, warehouse: ids(1)[0], records };
}

export function sharedMongoConnection(connection) {
  const db = connection.db; const client = connection.getClient();
  const check = () => {
    if (connection.readyState !== 1 || connection.name !== "petyard" || connection.db !== db ||
        db?.databaseName !== "petyard" || connection.getClient() !== client ||
        client?.options?.srvHost !== authorizedAssistantAtlasHost || client.options.dbName !== "petyard") {
      throw new Error("Shared assistant test connection changed or is not authorized");
    }
  };
  check(); return { db, client, check };
}

// The manifest is saved before insertion, so an interrupted run has exact recovery targets.
export function sharedMongoRecords(connection, manifest) {
  const owned = structuredClone(manifest);
  const suite = owned.suite ?? "analytics";
  if (!Object.hasOwn(suites, suite)) throw new Error("Invalid shared assistant test suite");
  const collections = Object.keys(suites[suite]);
  if (owned.host !== authorizedAssistantAtlasHost || owned.database !== "petyard" ||
      !/^assistant_shared_[a-f\d-]{36}$/.test(owned.marker) || !/^[a-f\d]{24}$/.test(owned.warehouse) ||
      !owned.records || Object.keys(owned.records).length !== collections.length ||
      collections.some((name) => !Array.isArray(owned.records[name]) || owned.records[name].length !== suites[suite][name] ||
        owned.records[name].some((id) => typeof id !== "string" || !/^[a-f\d]{24}$/.test(id)))) {
    throw new Error("Invalid shared assistant test manifest");
  }
  if (suite === "cartCoordinator" && owned.records.assistanttestcartreceipts.some((id, index) => id !== owned.records.assistanttestcartproposals[index])) {
    throw new Error("Coordinator receipt IDs must match their exact proposal IDs");
  }
  const allIds = Object.entries(owned.records).filter(([name]) => suite !== "cartCoordinator" || name !== "assistanttestcartreceipts").flatMap(([, ids]) => ids);
  if (new Set([...allIds, owned.warehouse]).size !== allIds.length + 1) throw new Error("Duplicate test identifiers");
  const { db, check: checkTarget } = sharedMongoConnection(connection); let armed = false;
  const filter = (name) => ({ _id: { $in: owned.records[name].map((id) => new mongoose.Types.ObjectId(id)) },
    assistantTestRun: owned.marker });
  const idsOnly = (name) => ({ _id: filter(name)._id });
  checkTarget();
  return {
    async prepare() {
      if (armed) throw new Error("Shared test records already prepared");
      checkTarget();
      for (const name of collections) {
        checkTarget();
        const existing = await db.listCollections({ name }, { nameOnly: true }).toArray();
        if (!existing.some((entry) => entry.name === name)) {
          throw new Error("Required test collections must already exist; no collections will be created");
        }
      }
      if (["persistence", "catalogPublication", "catalogPipeline", "cartCoordinator"].includes(suite)) {
        const requiredIndexes = suite === "persistence" ? persistenceIndexes : Object.fromEntries(
          Object.entries(persistenceIndexes).filter(([name]) => collections.includes(name)));
        if (["catalogPublication", "catalogPipeline", "cartCoordinator"].includes(suite)) requiredIndexes.assistantdietarywarnings = [{ owner: 1, subjectId: 1, sourceMessage: 1 }];
        for (const [name, required] of Object.entries(requiredIndexes)) {
          checkTarget();
          const indexes = await db.collection(name).listIndexes().toArray();
          if (required.some((key) => !indexes.some((index) => index.unique === true && !index.sparse &&
              !index.partialFilterExpression && JSON.stringify(index.key) === JSON.stringify(key)))) {
            throw new Error(`Required unique indexes missing on ${name}; no indexes will be created`);
          }
        }
        if (["catalogPublication", "catalogPipeline", "cartCoordinator"].includes(suite)) {
          checkTarget();
          const indexes = await db.collection("assistantdietarywarnings").listIndexes().toArray();
          if (indexes.length !== 3 || !indexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ _id: 1 }))) {
            throw new Error("Unexpected warning indexes; only _id and the two reviewed model indexes are allowed");
          }
          if (!indexes.some((index) => index.unique !== true && !index.sparse && !index.partialFilterExpression && index.expireAfterSeconds === undefined &&
              JSON.stringify(index.key) === JSON.stringify({ owner: 1, subjectId: 1, state: 1, _id: -1 }))) {
            throw new Error("Required warning-list index missing; no indexes will be created");
          }
          if (indexes.some((index) => index.expireAfterSeconds !== undefined)) throw new Error("Warning TTL indexes are forbidden in this suite");
        }
      }
      if (["catalogRead", "catalogPipeline"].includes(suite)) {
        const required = { categories: { slug: 1 }, subcategories: { category: 1, slug: 1 }, brands: { slug: 1 },
          warehouses: { code: 1 }, products: { slug: 1 }, collections: { slug: 1 } };
        for (const [name, key] of Object.entries(required)) {
          checkTarget(); const indexes = await db.collection(name).listIndexes().toArray();
          if (!indexes.some((index) => index.unique === true && !index.sparse && !index.partialFilterExpression &&
            JSON.stringify(index.key) === JSON.stringify(key))) throw new Error(`Required unique indexes missing on ${name}; no indexes will be created`);
        }
      }
      if (["catalogPipeline", "cartCoordinator"].includes(suite)) {
        checkTarget();
        const indexes = await db.collection("users").listIndexes().toArray();
        const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
        const email = (index) => same(index.key, { email: 1 }) && !index.sparse &&
          (index.partialFilterExpression === undefined || same(index.partialFilterExpression, { email: { $type: "string" } }));
        const phone = (index) => same(index.key, { phone: 1 }) && !index.sparse &&
          same(index.partialFilterExpression, { phone: { $type: "string" } });
        const provider = (index) => same(index.key, { "authProviders.provider": 1, "authProviders.providerUserId": 1 }) &&
          ((index.sparse === true && index.partialFilterExpression === undefined) || (!index.sparse &&
            same(index.partialFilterExpression, { "authProviders.providerUserId": { $type: "string" } })));
        // Both reviewed deployments exclude omitted phone/provider fields; fixture emails are always unique strings.
        if ([email, phone, provider].some((accepts) => !indexes.some((index) => index.unique === true && accepts(index)))) {
          throw new Error("Compatible synthetic user unique indexes are required; no indexes will be created");
        }
        if (indexes.some((index) => index.unique === true && !same(index.key, { _id: 1 }) && ![email, phone, provider].some((accepts) => accepts(index)))) {
          throw new Error("Unreviewed user unique index; no fixture writes or index changes are allowed");
        }
      }
      for (const name of collections) {
        checkTarget();
        if (await db.collection(name).countDocuments(idsOnly(name), { maxTimeMS: 5000 })) throw new Error("Test identifier already exists");
      }
      checkTarget(); armed = true;
    },
    async insert(name, document) {
      checkTarget();
      if (!armed || !collections.includes(name) || !(document?._id instanceof mongoose.Types.ObjectId) ||
          !owned.records[name].includes(String(document._id))) {
        throw new Error("Refusing unregistered shared test write");
      }
      await db.collection(name).insertOne({ ...document, assistantTestRun: owned.marker }, { writeConcern: { w: "majority" } });
    },
    async cleanup() {
      checkTarget();
      if (!armed) return;
      const failures = [];
      for (const name of [...collections].reverse()) {
        if (!owned.records[name].length) continue;
        try {
          checkTarget();
          await db.collection(name).deleteMany(filter(name), { writeConcern: { w: "majority" } });
          checkTarget();
          if (await db.collection(name).findOne(idsOnly(name), { projection: { _id: 1 }, maxTimeMS: 5000 })) throw new Error("Registered identifiers remain");
        } catch { failures.push(new Error(`Shared test cleanup failed for ${name}; retain the manifest for exact recovery`)); }
      }
      if (failures.length) throw new AggregateError(failures, "Shared assistant test cleanup incomplete");
    },
  };
}
