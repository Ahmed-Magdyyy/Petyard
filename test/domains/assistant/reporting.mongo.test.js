import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantBudget, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { getUsageReport, usageReportPeriod } from "../../../src/domains/assistant/reporting/assistant.reporting.js";
import { testConfig, knownUsage } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { TOPIC_TAXONOMY_VERSION } from "../../../src/domains/assistant/reporting/assistant.topics.js";

test("isolated Mongo usage report: retained turns, distinct users, cross-month attempts and durable exposure", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`;
  let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true;
  t.diagnostic(`assistant_test_database=${database}`);
  await AssistantRun.createCollection(); await AssistantBudget.createCollection();
  // Keep expired fixtures for logical-retention assertions instead of racing Mongo's TTL monitor.
  await AssistantRun.collection.createIndex({ createdAt: 1 });
  await AssistantRun.collection.createIndex({ "attempts.dispatchedAt": 1 });
  const config = testConfig(); const now = new Date("2026-10-19T12:00:00Z");
  const period = usageReportPeriod({}, config.timezone, now);
  const first = new mongoose.Types.ObjectId(); const second = new mongoose.Types.ObjectId();
  const expiresAt = new Date("2100-01-01");
  const attempt = (date, usage = knownUsage, latencyMs) => ({ dispatchedAt: new Date(date), usage, latencyMs });
  const frozen = { provider: "recorded-provider", model: "recorded-model", promptVersion: "old-prompt", key: "private-key" };
  await AssistantRun.collection.insertMany([
    { owner: first, key: "previous-month", createdAt: new Date("2026-09-30T20:00Z"), status: "completed", expiresAt,
      config: frozen, attempts: [attempt("2026-09-30T20:01Z", knownUsage, 50000), attempt("2026-10-01T00:00Z", knownUsage, 1000)] },
    { owner: first, key: "two-stage", createdAt: new Date("2026-10-01T20:30Z"), status: "completed", expiresAt,
      topic: { key: "nutrition", taxonomyVersion: TOPIC_TAXONOMY_VERSION },
      config: { ...frozen, promptVersion: "new-prompt" },
      input: "private synthetic text", attempts: [attempt("2026-10-01T20:31Z", knownUsage, 0), attempt("2026-10-01T21:30Z", knownUsage, 2000)] },
    { owner: first, key: "failed", createdAt: new Date("2026-10-02T22:00Z"), status: "failed", expiresAt, attempts: [],
      topic: { key: "behavior", taxonomyVersion: TOPIC_TAXONOMY_VERSION } },
    { owner: second, key: "uncertain", createdAt: new Date("2026-10-03T22:00Z"), status: "uncertain", expiresAt: null,
      attempts: [attempt("2026-10-03T22:01Z", null)] },
    { owner: second, key: "expired", createdAt: new Date("2026-10-01T00:00Z"), status: "completed",
      expiresAt: new Date("2026-10-02"), attempts: [attempt("2026-10-01T00:01Z")] },
  ]);
  const globalId = `global:${period.start.toUTC().toISO()}`;
  await AssistantBudget.collection.insertMany([
    { _id: "control", billingTimezone: config.timezone, openingExposure: { month: "2026-10", microUsd: 100 }, frozen: false },
    { _id: globalId, spent: 1000, reserved: 50, frozen: false },
  ]);
  const report = await getUsageReport({}, config, now);
  assert.equal(report.totals.acceptedMessages, 3); assert.equal(report.totals.uniqueUsers, 2);
  assert.equal(report.totals.statuses.completed, 1); assert.equal(report.totals.statuses.failed, 1);
  assert.equal(report.totals.statuses.uncertain, 1); assert.equal(report.totals.providerAttempts, 4);
  assert.equal(report.models.truncated, false); assert.equal(report.models.groups.length, 3);
  const currentModel = report.models.groups[0];
  assert.equal(currentModel.provider, frozen.provider); assert.equal(currentModel.model, frozen.model);
  assert.equal(currentModel.promptVersion, "new-prompt"); assert.equal(currentModel.providerAttempts, 2);
  assert.deepEqual(currentModel.latency, { knownAttempts: 2, unknownAttempts: 0, meanMs: 1000, minMs: 0, maxMs: 2000 });
  const oldModel = report.models.groups.find((row) => row.promptVersion === "old-prompt");
  assert.equal(oldModel.providerAttempts, 1); assert.equal(oldModel.latency.meanMs, 1000, "Outside-month latency is excluded");
  assert.equal(report.models.groups.find((row) => row.model === null).latency.meanMs, null);
  assert.equal(report.models.groups.reduce((count, row) => count + row.providerAttempts, 0), report.totals.providerAttempts);
  for (const field of Object.keys(report.totals.tokenUsage)) {
    for (const measure of ["knownTokens", "unknownAttempts"]) {
      assert.equal(report.models.groups.reduce((count, row) => count + row.tokenUsage[field][measure], 0), report.totals.tokenUsage[field][measure]);
    }
  }
  assert.equal(report.topics.totalMessages, 3); assert.equal(report.topics.classifiedMessages, 1);
  assert.equal(report.topics.unknownMessages, 2);
  assert.equal(report.topics.categories.find((row) => row.key === "nutrition").count, 1);
  await AssistantRun.collection.updateOne({ key: "two-stage" }, { $set: { "topic.taxonomyVersion": "unsupported-future-version" } });
  assert.equal((await getUsageReport({}, config, now)).topics.unknownMessages, 3);
  assert.deepEqual(report.totals.tokenUsage.inputTokens, { knownTokens: 300, unknownAttempts: 1 });
  assert.deepEqual(report.totals.tokenUsage.outputTokens, { knownTokens: 60, unknownAttempts: 1 });
  assert.deepEqual(report.totals.tokenUsage.reasoningTokens, { knownTokens: 15, unknownAttempts: 1 });
  assert.equal(report.daily[0].acceptedMessages, 1); assert.equal(report.daily[0].providerAttempts, 2);
  assert.equal(report.daily[1].providerAttempts, 1); assert.equal(report.daily[2].acceptedMessages, 1);
  assert.equal(report.budget.accountedMicroUsd, 1000); assert.equal(report.budget.reservedMicroUsd, 50);
  assert.equal(report.budget.openingExposureMicroUsd, 100);
  assert.equal(report.budget.remainingUnderCurrentPolicyMicroUsd, config.monthlyBudgetMicroUsd - 1050);
  assert.doesNotMatch(JSON.stringify(report), /private synthetic text|private-key/);
  assert.equal(await AssistantRun.countDocuments(), 5, "Report did not mutate or delete retained/expired data");
  assert.equal((await AssistantBudget.findById(globalId)).spent, 1000);

  await AssistantRun.collection.insertMany([-1, "12", null, NaN, Infinity].map((latencyMs, index) => ({
    owner: first, key: `invalid-${index}`, createdAt: new Date("2026-10-10"), status: "failed", expiresAt,
    config: { provider: ["private-array"], model: "x".repeat(129), promptVersion: { private: "object" } },
    attempts: [attempt("2026-10-10T00:00Z", null, latencyMs)],
  })));
  const invalid = await getUsageReport({}, config, now);
  const unknown = invalid.models.groups.find((row) => row.provider === null && row.model === null && row.promptVersion === null);
  assert.deepEqual(unknown.latency, { knownAttempts: 0, unknownAttempts: 6, meanMs: null, minMs: null, maxMs: null });
  assert.doesNotMatch(JSON.stringify(invalid), /private-array|private-key/);
  await AssistantRun.collection.insertMany(Array.from({ length: 102 }, (_, index) => ({
    owner: first, key: `group-${index}`, createdAt: new Date("2026-10-10"), status: "completed", expiresAt,
    config: { provider: "aaa-fixture", model: `model-${String(index).padStart(3, "0")}`, promptVersion: "fixture" },
    attempts: [attempt("2026-10-10T00:00Z", knownUsage, 1)],
  })));
  const bounded = await getUsageReport({}, config, now);
  assert.equal(bounded.models.truncated, true); assert.equal(bounded.models.groups.length, 100);
  assert.equal(bounded.models.groups[0].providerAttempts, 6); assert.equal(bounded.models.groups[1].providerAttempts, 2);
  assert.equal(bounded.models.groups[2].model, "model-000");
  assert.equal(bounded.models.groups.at(-1).model, "model-097");
  assert.equal((await AssistantBudget.findById(globalId)).spent, 1000, "Reporting never changes the budget ledger");
});
