import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, validateSharedMongoTarget, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection, financialTestTime } from "./fixtures/isolatedBudget.js";
import { testConfig, knownUsage, structuredReply } from "./fixtures/foundationPolicy.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { costMicroUsd, reservationMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";

const unknownUsageMode = Boolean(process.env.ASSISTANT_SHARED_UNKNOWN_USAGE_TEST);
const reconciliationMode = !unknownUsageMode && Boolean(process.env.ASSISTANT_SHARED_RECONCILIATION_TEST);
const selectedCustomer = reconciliationMode || Boolean(process.env.ASSISTANT_SHARED_CUSTOMER_SETTLEMENT_TEST);
const optIn = unknownUsageMode ? process.env.ASSISTANT_SHARED_UNKNOWN_USAGE_TEST
  : reconciliationMode ? process.env.ASSISTANT_SHARED_RECONCILIATION_TEST
    : selectedCustomer ? process.env.ASSISTANT_SHARED_CUSTOMER_SETTLEMENT_TEST : process.env.ASSISTANT_SHARED_SETTLEMENT_TEST;
for (const ordering of unknownUsageMode ? ["customer", "admin"] : reconciliationMode ? ["manual_first", "worker_first", "concurrent"] : [null])
test(unknownUsageMode ? `missing provider usage preserves reservation without redispatch: ${ordering}`
  : ordering ? `uncertain-run reconciliation and late completion: ${ordering}`
    : `real ${selectedCustomer ? "customer" : "admin"} settlement commits one charge for concurrent completions and rejects stale/replayed attempts`, {
  skip: !optIn && "Requires isolated-ledger/owned-record settlement opt-in",
}, async (t) => {
  assert.equal(optIn, "isolated-ledger-owned-records-only");
  const customerMode = unknownUsageMode ? ordering === "customer" : selectedCustomer;
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { AssistantRun, AssistantAccount, AssistantEvent, AssistantAdminMessage, AssistantMessage, AssistantChat } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { transaction, reserveCost } = await import("../../../src/domains/assistant/shared/assistant.store.js");
  const finishWork = customerMode ? (await import("../../../src/domains/assistant/customer/assistant.worker.service.js")).finishRun
    : (await import("../../../src/domains/assistant/admin/assistant.admin-worker.js")).finishBusinessPlan;
  const { businessConfigSnapshot } = await import("../../../src/domains/assistant/admin/assistant.admin-policy.js");
  const { persistenceSeed } = await import("./fixtures/persistenceSeed.js");
  const installBoundaries = customerMode ? (await import("./fixtures/sharedCustomerBoundaries.js")).mockSharedCustomerBoundaries
    : (await import("./fixtures/sharedBusinessBoundaries.js")).mockSharedBusinessBoundaries;
  const amount = reservationMicroUsd(testConfig());
  const config = testConfig(unknownUsageMode ? { monthlyBudgetMicroUsd: amount, dailyBudgetMicroUsd: amount } : {});
  const budgetManifest = createIsolatedBudgetManifest(config);
  const manifest = createSharedMongoManifest("persistence"); manifest.records.users = [...budgetManifest.owners];
  const { ids, seed } = persistenceSeed(manifest, config);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  for (const scope of [manifest, budgetManifest]) {
    await writeFile(new URL(`${scope.marker}.json`, directory), `${JSON.stringify(scope, null, 2)}\n`, { flag: "wx" });
    t.diagnostic(`settlement_manifest=${scope.marker}.json`);
  }
  let records; let budgetRecords;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: async () => {
    const errors = [];
    for (const owned of [records, budgetRecords]) { try { await owned?.cleanup(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Settlement test cleanup incomplete; retain both manifests");
  }, disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Isolated settlement connection failed; connection details withheld"); }
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  budgetRecords = isolatedBudgetRecords(mongoose.connection, budgetManifest, config); await budgetRecords.prepare();
  const chatCollection = customerMode ? "assistantchats" : "assistantadminchats";
  for (const entry of seed.filter((entry) => ["users", "assistantaccounts"].includes(entry.collection) ||
    (entry.collection === chatCollection && String(entry.document._id) === manifest.records[chatCollection][0]))) {
    if (entry.collection === "assistantaccounts") entry.document.activeRun = ids.assistantruns[0];
    if (reconciliationMode && entry.collection === "users" && String(entry.document._id) === manifest.records.users[1]) entry.document.role = "superAdmin";
    await records.insert(entry.collection, entry.document);
  }
  const phase = customerMode ? "resolve" : "plan";
  const initial = new AssistantRun({ _id: ids.assistantruns[0], owner: ids.users[0], chat: ids[chatCollection][0],
    purpose: customerMode ? "customer" : "admin_business", phase, status: "queued", key: `${manifest.marker}/settlement`, hash: "synthetic-settlement-only",
    contextVersion: 0, input: "Synthetic settlement", userSequence: 1, config: customerMode ? config : businessConfigSnapshot(config),
    createdAt: new Date(), deadline: new Date(Date.now() + 120000) });
  assert.equal(initial.validateSync(), undefined); await records.insert("assistantruns", initial.toObject());
  installBoundaries(t, manifest);
  // Complete the cached initializer with schema operations stubbed before installing financial DDL refusals.
  await transaction(async () => {}); budgetRecords.install(t);
  const prepared = await transaction(async (session) => {
    const run = await AssistantRun.findOne({ _id: ids.assistantruns[0], owner: ids.users[0] }).session(session);
    run.reservation = await reserveCost(run.owner, config, session, new Date(financialTestTime));
    run.accounting = "reserved"; run.status = reconciliationMode ? "uncertain" : "dispatching"; run.attempt = "synthetic-settlement-attempt";
    run.attempts.push({ id: run.attempt, number: 1, phase, contextVersion: 0, reservation: run.reservation,
      accounting: "reserved", dispatchedAt: new Date() });
    await run.save({ session }); return { run: run.toObject(), ...(customerMode ? { allowedSubjects: ["user"], subjectFingerprints: {} } : {}) };
  });
  const ledger = mongoose.connection.db.collection(isolatedBudgetCollection);
  const result = { structured: customerMode ? structuredReply() : { outcome: "clarify", language: "ar", clarification: "period", reports: [] },
    usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], providerRequestId: "synthetic-settlement-request", latencyMs: 1 };
  const finish = (work = prepared) => finishWork(work, result, null, { currentConfig: config });
  if (unknownUsageMode) {
    const { verifyUnknownUsageScenario } = await import("./fixtures/unknownUsageScenario.js");
    await verifyUnknownUsageScenario({ customerMode, config, prepared, finishWork, result, ids, ledger, budgetManifest }); return;
  }
  if (reconciliationMode) {
    const { verifyReconciliationScenario } = await import("./fixtures/reconciliationScenario.js");
    await verifyReconciliationScenario(t, { ordering, config, prepared, finish, ids, ledger, budgetManifest }); return;
  }
  const assertReserved = async () => {
    const run = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(run.accounting, "reserved"); assert.equal(run.status, "dispatching"); assert.equal(run.phase, phase);
    assert.equal(run.attempts[0].accounting, "reserved"); assert.equal(run.adminPlan, undefined);
    for (const id of prepared.run.reservation.budgetIds) {
      const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
      assert.equal(row.reserved, reservationMicroUsd(config)); assert.equal(row.spent, 0);
    }
    if (customerMode) {
      assert.equal(await AssistantMessage.countDocuments({ _id: ids.assistantmessages[0] }), 0);
      assert.equal((await AssistantChat.findById(ids.assistantchats[0]).lean()).nextSequence, 0);
      const account = await AssistantAccount.findById(ids.assistantaccounts[0]).lean();
      assert.equal(account.reviewEvidenceVersion, 0); assert.equal(String(account.activeRun), String(ids.assistantruns[0]));
    }
  };
  await assertReserved();
  assert.equal(await finish({ run: { ...prepared.run, attempt: "stale-attempt" } }), null);
  assert.equal(await finish({ run: { ...prepared.run, ...(customerMode ? { purpose: "admin_business" } : { owner: ids.users[1] }) } }), null);
  await assertReserved();
  // Fail before commit, after publication writes in customer mode or run save in admin mode.
  const interrupted = new Error("Synthetic interruption before settlement commit");
  const eventFailure = t.mock.method(AssistantEvent, "create", async () => { throw interrupted; });
  try { await assert.rejects(finish(), (error) => error === interrupted); } finally { eventFailure.mock.restore(); }
  await assertReserved();
  const completions = await Promise.all([1, 2, 3, 4].map(() => finish()));
  assert.equal(completions.filter(Boolean).length, 1); assert.equal(completions.filter((value) => value === null).length, 3);
  const committed = await AssistantRun.findById(ids.assistantruns[0]).lean();
  const charge = costMicroUsd(knownUsage, config);
  assert.equal(committed.accounting, "settled"); assert.equal(committed.phase, customerMode ? "resolve" : "reports");
  assert.equal(committed.status, customerMode ? "completed" : "queued");
  assert.equal(committed.chargedMicroUsd, charge); assert.equal(committed.attempts.length, 1);
  assert.equal(committed.attempts[0].accounting, "settled"); assert.equal(committed.attempts[0].chargedMicroUsd, charge);
  assert.equal(committed.attempts[0].providerRequestId, result.providerRequestId); assert.ok(committed.attempts[0].settledAt);
  if (customerMode) {
    assert.equal(String(committed.responseMessage), String(ids.assistantmessages[0]));
    const message = await AssistantMessage.findById(ids.assistantmessages[0]).lean();
    assert.equal(message.text, result.structured.reply); assert.equal(message.sequence, 1); assert.equal(message.role, "assistant");
    assert.equal(String(message.owner), String(ids.users[0])); assert.equal(String(message.run), String(ids.assistantruns[0]));
  } else { assert.equal(committed.adminPlan.outcome, "clarify"); assert.equal(committed.responseMessage, null); }
  const account = await AssistantAccount.findById(ids.assistantaccounts[0]).lean();
  assert.equal(account.activeRun === null ? null : String(account.activeRun), customerMode ? null : String(ids.assistantruns[0]));
  if (customerMode) assert.equal(account.reviewEvidenceVersion, 1);
  const retained = JSON.stringify(committed);
  assert.equal(await finish(), null); assert.equal(await finish({ run: committed }), null);
  assert.equal(JSON.stringify(await AssistantRun.findById(ids.assistantruns[0]).lean()), retained);
  if (customerMode) {
    assert.equal(await AssistantMessage.countDocuments({ run: ids.assistantruns[0], owner: ids.users[0] }), 1);
    assert.equal((await AssistantChat.findById(ids.assistantchats[0]).lean()).nextSequence, 1);
    const replayAccount = await AssistantAccount.findById(ids.assistantaccounts[0]).lean();
    assert.equal(replayAccount.reviewEvidenceVersion, 1); assert.equal(replayAccount.activeRun, null);
  }
  for (const id of prepared.run.reservation.budgetIds) {
    const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
    assert.equal(row.reserved, 0); assert.equal(row.spent, charge);
  }
  for (const id of budgetManifest.ids.filter((value) => !prepared.run.reservation.budgetIds.includes(value))) {
    const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
    assert.equal(row.reserved, 0); assert.equal(row.spent, 0); assert.equal(row.frozen, false);
  }
  assert.equal(await AssistantAdminMessage.countDocuments({ _id: { $in: ids.assistantadminmessages } }), 0);
});
