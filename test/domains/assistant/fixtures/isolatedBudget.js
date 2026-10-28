import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { AssistantBudget } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { periods } from "../../../../src/domains/assistant/shared/assistant.config.js";
import { authorizedAssistantAtlasHost } from "./mongoTarget.js";
import { sharedMongoConnection } from "./sharedMongo.js";

export const isolatedBudgetCollection = "assistanttestbudgets";
export const financialTestTime = "2040-01-31T20:00:00.000Z";
export const financialNextTime = "2040-02-01T20:00:00.000Z";
const idsFor = (config, owners) => {
  const current = periods(config, new Date(financialTestTime)); const next = periods(config, new Date(financialNextTime));
  return ["control", `global:${current.month}`, ...owners.map((owner) => `user:${owner}:${current.day}`), `global:${next.month}`];
};
export function createIsolatedBudgetManifest(config) {
  const owners = [1, 2].map(() => String(new mongoose.Types.ObjectId()));
  return { marker: `assistant_financial_${randomUUID()}`, host: authorizedAssistantAtlasHost, database: "petyard",
    collection: isolatedBudgetCollection, owners, ids: idsFor(config, owners), when: financialTestTime, timezone: config.timezone };
}

export function isolatedBudgetRecords(connection, manifest, config) {
  const scope = structuredClone(manifest);
  assert.equal(scope.host, authorizedAssistantAtlasHost); assert.equal(scope.database, "petyard");
  assert.equal(scope.collection, isolatedBudgetCollection); assert.equal(scope.when, financialTestTime);
  assert.equal(scope.timezone, "Africa/Cairo"); assert.equal(config.timezone, scope.timezone);
  assert.match(scope.marker, /^assistant_financial_[a-f\d-]{36}$/);
  assert.equal(scope.owners.length, 2); assert.equal(new Set(scope.owners).size, 2);
  for (const owner of scope.owners) assert.match(owner, /^[a-f\d]{24}$/);
  assert.deepEqual(scope.ids, idsFor(config, scope.owners));
  const { db, client, check } = sharedMongoConnection(connection);
  const collection = db.collection(isolatedBudgetCollection); let armed = false;
  const ids = { _id: { $in: scope.ids } }; const owned = { ...ids, assistantTestRun: scope.marker };
  return {
    async prepare() {
      check(); assert.equal(armed, false);
      const existing = await db.listCollections({ name: isolatedBudgetCollection }, { nameOnly: true }).toArray();
      if (!existing.some((entry) => entry.name === isolatedBudgetCollection)) throw new Error("Isolated test ledger is missing; no collection will be created");
      if (await collection.countDocuments(ids, { maxTimeMS: 5000 })) throw new Error("Isolated ledger IDs already exist; refusing to reuse records");
      const current = periods(config, new Date(financialTestTime)); const next = periods(config, new Date(financialNextTime));
      const end = [new Date("9999-01-01"), current.monthReset, current.dayReset, current.dayReset, next.monthReset];
      const seed = scope.ids.map((_id, index) => {
        const record = new AssistantBudget({ _id, periodEnd: end[index], spent: 0, reserved: 0, frozen: false,
          ...(_id === "control" ? { billingTimezone: config.timezone, openingExposure: config.openingExposure } : {}) });
        const error = record.validateSync(); if (error) throw error;
        return { ...record.toObject(), assistantTestRun: scope.marker };
      });
      check(); armed = true; await collection.insertMany(seed, { ordered: true, writeConcern: { w: "majority" } });
    },
    install(t) {
      check(); assert.ok(armed, "Prepare the isolated records before redirecting the budget model");
      for (const method of ["find", "findOne", "insertOne", "insertMany", "deleteOne", "deleteMany", "aggregate", "countDocuments",
        "estimatedDocumentCount", "distinct", "bulkWrite", "updateMany", "replaceOne", "findOneAndDelete", "findOneAndReplace"]) {
        t.mock.method(AssistantBudget.collection, method, () => { throw new Error("Real assistant financial collection access is forbidden in this test"); });
      }
      for (const method of ["createCollection", "createIndexes"]) t.mock.method(AssistantBudget, method, () => { throw new Error("Financial schema changes are forbidden in this test"); });
      for (const method of ["findOneAndUpdate", "updateOne"]) t.mock.method(AssistantBudget.collection, method, async (filter, update, options) => {
        check(); assert.ok(options?.session); assert.equal(options.session.client, client);
        assert.equal(typeof filter._id, "string"); assert.ok(scope.ids.includes(filter._id));
        assert.equal(filter.assistantTestRun, undefined);
        for (const fields of Object.values(update)) {
          assert.ok(fields && typeof fields === "object"); assert.equal(Object.hasOwn(fields, "assistantTestRun"), false);
        }
        return collection[method]({ ...filter, assistantTestRun: scope.marker },
          { ...update, $setOnInsert: { ...update.$setOnInsert, assistantTestRun: scope.marker } }, options);
      });
    },
    async cleanup() {
      check(); if (!armed) return;
      await collection.deleteMany(owned, { writeConcern: { w: "majority" } });
      check(); if (await collection.findOne(ids, { projection: { _id: 1 }, maxTimeMS: 5000 })) throw new Error("Isolated ledger cleanup incomplete; retain the manifest");
    },
  };
}
