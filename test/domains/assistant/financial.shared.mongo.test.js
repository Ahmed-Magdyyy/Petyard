import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection, financialTestTime } from "./fixtures/isolatedBudget.js";
import { testConfig, knownUsage } from "./fixtures/foundationPolicy.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { reservationMicroUsd, costMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";

test("real reserve/settle functions enforce a shared cap in an isolated test-only ledger", {
  skip: !process.env.ASSISTANT_SHARED_FINANCIAL_TEST && "Prepared only; isolated ledger setup and opt-in required",
}, async (t) => {
  assert.equal(process.env.ASSISTANT_SHARED_FINANCIAL_TEST, "isolated-ledger-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  // Disable implicit DDL before importing the store's notification model or connecting.
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { reserveCost, settleCost } = await import("../../../src/domains/assistant/shared/assistant.store.js");
  const amount = reservationMicroUsd(testConfig());
  const config = testConfig({ monthlyBudgetMicroUsd: amount, dailyBudgetMicroUsd: amount });
  const manifest = createIsolatedBudgetManifest(config);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`isolated_financial_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Isolated financial test connection failed; connection details withheld"); }
  records = isolatedBudgetRecords(mongoose.connection, manifest, config); await records.prepare(); records.install(t);
  const ledger = mongoose.connection.db.collection(isolatedBudgetCollection);
  const transact = async (callback) => {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => callback(session), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
    }); } finally { await session.endSession(); }
  };
  const when = new Date(financialTestTime);
  const aborted = new Error("Synthetic financial rollback");
  await assert.rejects(transact(async (session) => {
    const reservation = await reserveCost(new mongoose.Types.ObjectId(manifest.owners[0]), config, session, when);
    assert.equal(reservation.amount, amount); throw aborted;
  }), (error) => error === aborted);
  for (const id of manifest.ids) {
    const row = await ledger.findOne({ _id: id, assistantTestRun: manifest.marker });
    assert.equal(row.spent, 0); assert.equal(row.reserved, 0);
  }
  const outcomes = await Promise.allSettled(manifest.owners.map((owner) => transact(async (session) => ({ owner,
    reservation: await reserveCost(new mongoose.Types.ObjectId(owner), config, session, when),
  }))));
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((value) => value.status === "rejected")?.reason.code, "monthly_budget_limit");
  const winner = outcomes.find((value) => value.status === "fulfilled").value;
  assert.equal((await ledger.findOne({ _id: manifest.ids[1] })).reserved, amount);
  const loser = manifest.owners.find((owner) => owner !== winner.owner);
  assert.equal((await ledger.findOne({ _id: manifest.ids.find((id) => id.startsWith(`user:${loser}:`)) })).reserved, 0);
  await transact(async (session) => {
    const run = { accounting: "reserved", reservation: winner.reservation, config };
    assert.equal(await settleCost(run, knownUsage, session), true);
    assert.equal(run.accounting, "settled"); assert.equal(run.chargedMicroUsd, costMicroUsd(knownUsage, config));
  });
  for (const id of winner.reservation.budgetIds) {
    const row = await ledger.findOne({ _id: id });
    assert.equal(row.reserved, 0); assert.equal(row.spent, costMicroUsd(knownUsage, config));
  }
  const nextMonth = await ledger.findOne({ _id: manifest.ids.at(-1) });
  assert.equal(nextMonth.spent, 0); assert.equal(nextMonth.reserved, 0);
  assert.equal((await ledger.findOne({ _id: "control" })).frozen, false);
});
