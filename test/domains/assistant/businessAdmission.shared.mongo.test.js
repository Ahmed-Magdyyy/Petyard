import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, validateSharedMongoTarget, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

const recoveryMode = Boolean(process.env.ASSISTANT_SHARED_BUSINESS_RECOVERY_TEST);
const revokeMode = !recoveryMode && Boolean(process.env.ASSISTANT_SHARED_BUSINESS_REVOKE_TEST);
const reportMode = recoveryMode || revokeMode || Boolean(process.env.ASSISTANT_SHARED_BUSINESS_REPORTS_TEST);
const optIn = recoveryMode ? process.env.ASSISTANT_SHARED_BUSINESS_RECOVERY_TEST : revokeMode ? process.env.ASSISTANT_SHARED_BUSINESS_REVOKE_TEST
  : reportMode ? process.env.ASSISTANT_SHARED_BUSINESS_REPORTS_TEST : process.env.ASSISTANT_SHARED_BUSINESS_TEST;
test(`shared DB real business admission and ${recoveryMode ? "interrupted report recovery" : revokeMode ? "mid-report permission revocation" : reportMode ? "three sales report cards" : "clarification reply"} with initialization/audit boundaries stubbed`, {
  skip: !optIn && "Requires explicit business-service test opt-in",
}, async (t) => {
  assert.equal(optIn, "owned-records-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { persistenceSeed } = await import("./fixtures/persistenceSeed.js");
  const { analyticsSeed } = await import("./fixtures/analyticsSeed.js");
  const { mockSharedBusinessBoundaries, scopeSharedBusinessRecovery } = await import("./fixtures/sharedBusinessBoundaries.js");
  const { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { submitBusinessMessage, getBusinessRun, getBusinessHistory } = await import("../../../src/domains/assistant/admin/assistant.admin-service.js");
  const { processBusinessReports, recoverBusinessReports } = await import("../../../src/domains/assistant/admin/assistant.admin-reports.js");
  const { executeAdminAnalyticsTool } = await import("../../../src/domains/assistant/admin/assistant.admin-analytics.js");
  const { ADMIN_PLAN_VERSION } = await import("../../../src/domains/assistant/admin/assistant.admin-plan.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const config = testConfig({ rateMax: 100, ...(recoveryMode ? { queueTimeoutMs: 120000 } : {}) }); const manifest = createSharedMongoManifest("persistence");
  const analyticsManifest = reportMode ? createSharedMongoManifest() : null;
  const analytics = analyticsManifest ? analyticsSeed(analyticsManifest) : null;
  const { ids, seed } = persistenceSeed(manifest, config);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  if (analyticsManifest) {
    await writeFile(new URL(`${analyticsManifest.marker}.json`, directory), `${JSON.stringify(analyticsManifest, null, 2)}\n`, { flag: "wx" });
    t.diagnostic(`business_analytics_manifest=${analyticsManifest.marker}.json`);
  }
  t.diagnostic(`business_service_manifest=${manifest.marker}.json`);
  let records; let analyticsRecords;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: async () => {
    const failures = [];
    for (const owned of [records, analyticsRecords]) {
      try { await owned?.cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Business test record cleanup incomplete");
  },
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  try { await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false, bufferCommands: false }); }
  catch { throw new Error("Business service test connection failed; connection details withheld"); }
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  if (analyticsManifest) { analyticsRecords = sharedMongoRecords(mongoose.connection, analyticsManifest); await analyticsRecords.prepare(); }
  for (const entry of seed.filter((entry) => !["assistantruns", "assistantmessages", "assistantadminmessages"].includes(entry.collection))) {
    await records.insert(entry.collection, entry.document);
  }
  for (const entry of analytics?.seed ?? []) await analyticsRecords.insert(entry.collection, entry.document);
  mockSharedBusinessBoundaries(t, manifest);
  const owner = ids.users[0]; const key = "synthetic-business-concurrent"; const body = { text: "قارن المبيعات" };
  const submissions = await Promise.all(Array.from({ length: 6 }, () => submitBusinessMessage(owner, body, key, config)));
  assert.equal(new Set(submissions.map((value) => value.run.id)).size, 1);
  assert.equal(submissions.filter((value) => !value.duplicate).length, 1);
  assert.equal(await AssistantRun.countDocuments({ _id: { $in: ids.assistantruns }, owner }), 1);
  assert.equal(await AssistantAdminMessage.countDocuments({ _id: { $in: ids.assistantadminmessages }, owner }), 1);
  assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).dayMessages, 1);
  await assert.rejects(submitBusinessMessage(owner, { text: "Different input" }, key, config), { code: "idempotency_conflict" });
  await assert.rejects(submitBusinessMessage(owner, body, "synthetic-second-active", config), { code: "active_request" });
  await assert.rejects(getBusinessRun(ids.users[1], submissions[0].run.id, config), { code: "run_not_found" });

  const warehouse = analytics ? String(analytics.warehouse) : null;
  const reports = reportMode ? [
    { tool: "compare_order_months", arguments: { month: "2026-09", compareTo: "2026-08", warehouse } },
    { tool: "lowest_selling_products", arguments: { month: "2026-09", metric: "units", limit: 2, warehouse } },
    { tool: "highest_selling_products", arguments: { month: "2026-09", metric: "item_value", limit: 1, warehouse } },
  ] : [];
  // Pretend the paid planner settled: this suite never prepares, dispatches or settles provider work.
  const transitioned = await AssistantRun.updateOne({ _id: ids.assistantruns[0], owner, status: "queued", phase: "plan" }, { $set: {
    phase: "reports", accounting: "settled", deadline: new Date(Date.now() + config.queueTimeoutMs),
    adminWarehouseIds: warehouse ? [warehouse] : [],
    adminPlan: { version: ADMIN_PLAN_VERSION, outcome: reportMode ? "reports" : "clarify", language: "ar", clarification: reportMode ? "none" : "period", reports },
    attempts: [{ id: "synthetic-no-paid-planner", number: 1, phase: "plan", accounting: "settled", chargedMicroUsd: 0 }],
  } });
  assert.equal(transitioned.modifiedCount, 1);
  const resumedTools = [];
  if (recoveryMode) {
    const interruption = new Error("Synthetic worker interruption"); const executed = [];
    await assert.rejects(processBusinessReports(ids.assistantruns[0], { getConfig: () => config,
      async executeReport(actor, invocation, options) {
        if (executed.length === 1) throw interruption;
        const result = await executeAdminAnalyticsTool(actor, invocation, options); executed.push(invocation.tool); return result;
      },
    }), (error) => error === interruption);
    assert.deepEqual(executed, ["compare_order_months"]);
    const interrupted = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(interrupted.status, "dispatching"); assert.equal(interrupted.adminReports.length, 1);
    assert.equal(interrupted.adminReports[0].status, "success"); assert.ok(interrupted.reportLease);
    assert.equal(interrupted.responseMessage, null);
    const firstCard = JSON.stringify(interrupted.adminReports[0]);
    assert.equal(String((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).activeRun), String(ids.assistantruns[0]));
    const hidden = await getBusinessRun(owner, submissions[0].run.id, config);
    assert.equal(hidden.message, null); assert.deepEqual(hidden.reports, []);
    const now = new Date();
    const expired = await mongoose.connection.db.collection("assistantruns").updateOne({ _id: ids.assistantruns[0], owner,
      assistantTestRun: manifest.marker, status: "dispatching", reportLease: interrupted.reportLease },
    { $set: { reportLeaseUntil: new Date(now.getTime() - 1) } });
    assert.equal(expired.modifiedCount, 1);
    const scoped = scopeSharedBusinessRecovery(t, manifest);
    try { assert.equal(await recoverBusinessReports(config, now), 1); } finally { scoped.mock.restore(); }
    const recovered = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(recovered.status, "queued"); assert.equal(recovered.reportLease, null); assert.equal(recovered.reportLeaseUntil, null);
    assert.equal(JSON.stringify(recovered.adminReports[0]), firstCard); assert.equal(recovered.attempts.length, 1);
    assert.equal(String((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).activeRun), String(ids.assistantruns[0]));
  }
  let reportCalls = 0;
  const revokeDuringReport = async (actor, invocation, options) => {
    const result = await executeAdminAnalyticsTool(actor, invocation, options); reportCalls += 1;
    if (reportCalls === 2) {
      const partial = await AssistantRun.findById(ids.assistantruns[0]).lean();
      assert.equal(partial.adminReports.length, 1); assert.equal(partial.adminReports[0].status, "success");
      const changed = await mongoose.connection.db.collection("users").updateOne({ _id: owner,
        assistantTestRun: manifest.marker, role: "admin", enabledControls: "analytics" }, { $set: { enabledControls: ["products"] } });
      assert.equal(changed.modifiedCount, 1);
    }
    return result;
  };
  const results = await Promise.all([1, 2].map(() => processBusinessReports(ids.assistantruns[0], {
    getConfig: () => config, ...(recoveryMode ? { async executeReport(actor, invocation, options) {
      resumedTools.push(invocation.tool); return executeAdminAnalyticsTool(actor, invocation, options);
    } } : revokeMode ? { executeReport: revokeDuringReport }
      : reportMode ? {} : { executeReport() { throw new Error("Clarification must not execute analytics"); } }),
  })));
  if (revokeMode) {
    assert.equal(reportCalls, 2, "Permission revocation must stop the third report");
    assert.equal(results.filter((value) => value.status === "failed").length, 1);
    assert.equal(results.filter((value) => value.skipped === true).length, 1);
    for (const read of [() => getBusinessRun(owner, submissions[0].run.id, config), () => getBusinessHistory(owner, {}, config),
      () => submitBusinessMessage(owner, body, key, config)]) {
      await assert.rejects(read(), { code: "access_denied" });
    }
    const failed = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(failed.status, "failed"); assert.equal(failed.publicCode, "access_denied");
    assert.equal(failed.adminReports.length, 1); assert.equal(failed.responseMessage, null);
    assert.equal(failed.reportLease, null); assert.equal(failed.reportLeaseUntil, null);
    assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).activeRun, null);
    assert.equal((await AssistantAdminChat.findById(ids.assistantadminchats[0]).lean()).nextSequence, 1);
    assert.equal(await AssistantAdminMessage.countDocuments({ _id: { $in: ids.assistantadminmessages }, owner }), 1);
    const restored = await mongoose.connection.db.collection("users").updateOne({ _id: owner,
      assistantTestRun: manifest.marker, role: "admin", enabledControls: "products" }, { $set: { enabledControls: ["analytics"] } });
    assert.equal(restored.modifiedCount, 1);
    const visible = await getBusinessRun(owner, submissions[0].run.id, config);
    assert.equal(visible.run.status, "failed"); assert.equal(visible.message, null); assert.deepEqual(visible.reports, []);
    const history = await getBusinessHistory(owner, {}, config);
    assert.equal(history.messages.length, 1); assert.equal(history.messages[0].role, "user");
    assert.equal((await submitBusinessMessage(owner, body, key, config)).duplicate, true);
    assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).dayMessages, 1);
    assert.equal((await processBusinessReports(ids.assistantruns[0], { getConfig: () => config })).skipped, true);
    return;
  }
  assert.equal(results.filter((value) => value.status === "completed").length, 1);
  assert.equal(results.filter((value) => value.skipped === true).length, 1);
  if (recoveryMode) {
    assert.deepEqual(resumedTools, ["lowest_selling_products", "highest_selling_products"], "A saved card must not be recomputed");
    const scoped = scopeSharedBusinessRecovery(t, manifest);
    try { assert.equal(await recoverBusinessReports(config), 0); } finally { scoped.mock.restore(); }
  }
  const retained = await getBusinessRun(owner, submissions[0].run.id, config);
  assert.equal(retained.run.status, "completed"); assert.equal(retained.message.outcome, reportMode ? "reports" : "clarify");
  assert.equal(retained.message.language, "ar");
  if (reportMode) {
    assert.deepEqual(retained.reports.map((card) => card.status), ["success", "success", "success"]);
    assert.equal(retained.reports[0].data.periods.current.metrics.totalSales, 240);
    assert.equal(retained.reports[0].data.periods.baseline.metrics.totalSales, 100);
    assert.equal(retained.reports[0].data.changes.totalSales.percentage, 140);
    assert.equal(retained.reports[1].data.results[0].productId, String(analytics.zero));
    assert.equal(retained.reports[1].data.results[0].unitsSold, 0);
    assert.equal(retained.reports[2].data.results[0].productId, String(analytics.sold));
    assert.equal(retained.reports[2].data.results[0].recordedItemValue, 200);
    const stored = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(stored.adminReports.length, 3); assert.ok(stored.adminReports.every((card) => typeof card.dataJson === "string"));
    const history = await getBusinessHistory(owner, {}, config);
    assert.equal(history.messages[0].reportHeaders.length, 3);
    assert.equal(JSON.stringify(history).includes('"periods"'), false);
    const before = JSON.stringify(retained.reports);
    const product = analyticsManifest.records.products[0];
    const changed = await mongoose.connection.db.collection("products").updateOne({ _id: new mongoose.Types.ObjectId(product),
      assistantTestRun: analyticsManifest.marker }, { $set: { name_en: "Changed after snapshot" } });
    assert.equal(changed.modifiedCount, 1);
    assert.equal(JSON.stringify((await getBusinessRun(owner, submissions[0].run.id, config)).reports), before,
      "Retained report cards must use the saved snapshot rather than rescan mutable catalog data");
    const publicResult = JSON.stringify(retained);
    for (const privateField of ["dataJson", "adminPlan", "synthetic-no-paid-planner", "baseSignature"]) assert.equal(publicResult.includes(privateField), false);
    assert.equal((await processBusinessReports(ids.assistantruns[0], { getConfig: () => config })).skipped, true);
  } else assert.deepEqual(retained.reports, []);
  assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).activeRun, null);
  assert.equal((await AssistantAdminChat.findById(ids.assistantadminchats[0]).lean()).nextSequence, 2);
  assert.equal((await getBusinessHistory(owner, {}, config)).messages.length, 2);
  assert.equal((await submitBusinessMessage(owner, body, key, config)).duplicate, true);
  assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).dayMessages, 1);
  assert.equal(await AssistantAdminMessage.countDocuments({ _id: { $in: ids.assistantadminmessages }, owner }), 2);
});
