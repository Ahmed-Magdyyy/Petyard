import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { getUsageReport, usageReportPeriod, usageReportPipeline } from "../../../src/domains/assistant/reporting/assistant.reporting.js";
import { AssistantBudget, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const now = new Date("2026-10-19T12:00:00Z");
const config = testConfig();
const period = usageReportPeriod({}, config.timezone, now);

test("monthly reporting validates its only query and uses Cairo calendar boundaries across DST", () => {
  assert.equal(period.month, "2026-10");
  assert.equal(period.start.toUTC().toISO(), "2026-09-30T21:00:00.000Z");
  assert.equal(period.end.toUTC().toISO(), "2026-10-31T22:00:00.000Z");
  assert.equal(period.observedThrough.toJSDate().getTime(), now.getTime());
  assert.equal(usageReportPeriod({ month: "2024-02" }, config.timezone, now).end.day, 1);
  for (const query of [{ month: "2026-13" }, { month: "2026-1" }, { month: ["2026-10"] },
    { month: { $gt: "" } }, { month: "2026-11" }, { userId: "foreign" }, { model: "private" }]) {
    assert.throws(() => usageReportPeriod(query, config.timezone, now));
  }
  const pipeline = usageReportPipeline(period, config.timezone, now);
  assert.equal(pipeline[0].$match.$and[0].$or[1].expiresAt.$gt, now);
  assert.equal(pipeline[0].$match.$and[1].$or[1]["attempts.dispatchedAt"].$gte.getTime(), period.start.toMillis());
  assert.deepEqual(Object.keys(pipeline[1].$project).sort(), ["createdAt", "owner", "purpose", "status", "attempts.dispatchedAt", "attempts.usage",
    "attempts.latencyMs", "topic.key", "topic.taxonomyVersion", "provider", "model", "promptVersion"].sort());
  assert.deepEqual(pipeline[2].$facet.users.at(-1), { $count: "count" });
});

function mockReads(t, rows, budgets) {
  const calls = [];
  t.mock.method(AssistantRun, "aggregate", (pipeline) => ({ option(options) { calls.push({ pipeline, options }); return Promise.resolve(rows); } }));
  t.mock.method(AssistantBudget, "find", (filter) => ({ select(selection) { calls.push({ filter, selection }); return this; },
    maxTimeMS(value) { calls.push({ maxTimeMS: value }); return this; }, async lean() { return budgets; } }));
  return calls;
}

test("report separates distinct users, turns and attempts, preserves unknown usage, and takes exposure from durable ledger", async (t) => {
  const calls = mockReads(t, [{
    daily: [{ _id: "2026-10-01", acceptedMessages: 2, uniqueUsers: 2, completed: 1, uncertain: 1 },
      { _id: "2026-10-02", acceptedMessages: 1, uniqueUsers: 1, failed: 1 }],
    topics: [{ _id: "nutrition", count: 1 }, { _id: "unknown", count: 2 }],
    users: [{ count: 2 }], attempts: [{ _id: "2026-10-02", providerAttempts: 3,
      inputTokensKnown: 200, inputTokensUnknown: 1, outputTokensKnown: 40, outputTokensUnknown: 1,
      reasoningTokensKnown: 10, reasoningTokensUnknown: 1, cachedInputTokensKnown: 0, cachedInputTokensUnknown: 2,
      cacheWriteInputTokensKnown: 0, cacheWriteInputTokensUnknown: 2 }],
  }], [{ _id: "control", billingTimezone: config.timezone, openingExposure: { month: "2026-10", microUsd: 100 } },
    { _id: `global:${period.start.toUTC().toISO()}`, spent: 1234, reserved: 56 }]);
  const report = await getUsageReport({}, config, now);
  assert.equal(report.totals.acceptedMessages, 3);
  assert.equal(report.totals.uniqueUsers, 2, "monthly users are not the sum of daily unique counts");
  assert.equal(report.totals.providerAttempts, 3);
  assert.equal(report.topics.totalMessages, 3); assert.equal(report.topics.unknownMessages, 2);
  assert.equal(report.topics.categories.find((row) => row.key === "nutrition").shareBasisPoints, 3333);
  assert.deepEqual(report.totals.tokenUsage.inputTokens, { knownTokens: 200, unknownAttempts: 1 });
  assert.deepEqual(report.totals.tokenUsage.cachedInputTokens, { knownTokens: 0, unknownAttempts: 2 });
  assert.equal(report.totals.tokenUsage.outputTokens.knownTokens, 40, "reasoning is already included in output");
  assert.equal(report.daily.length, 19);
  assert.equal(report.daily[2].acceptedMessages, 0);
  assert.equal(report.budget.accountedMicroUsd, 1234);
  assert.equal(report.budget.reservedMicroUsd, 56);
  assert.equal(report.budget.remainingUnderCurrentPolicyMicroUsd, config.monthlyBudgetMicroUsd - 1290);
  assert.equal(report.budget.openingExposureMicroUsd, 100);
  assert.equal(report.budget.actualInvoiceMicroUsd, null);
  assert.equal(report.coverage.completeness, "not_guaranteed");
  assert.equal(report.coverage.consistency, "independent_reads");
  assert.equal(calls[0].options.maxTimeMS, 5000);
  assert.doesNotMatch(JSON.stringify(report), /owner|sourceQuote|providerRequestId|system|input\.text/);
});

test("model groups preserve recorded identities and timing coverage without repricing or leaking extra data", async (t) => {
  mockReads(t, [{ daily: [], users: [], attempts: [], models: [
    { _id: { provider: "historical-provider", model: "historical-model", promptVersion: "old-prompt" }, providerAttempts: 3,
      latencyKnown: 2, latencyMean: 1000, latencyMin: 0, latencyMax: 2000, inputTokensKnown: 300, inputTokensUnknown: 1,
      providerRequestId: "private-request", config: { key: "private-key" } },
    { _id: { provider: null, model: null, promptVersion: null }, providerAttempts: 1,
      latencyKnown: 0, latencyMean: null, latencyMin: null, latencyMax: null },
  ] }], []);
  const report = await getUsageReport({}, config, now);
  assert.equal(report.models.source, "retained_dispatch_attempts"); assert.equal(report.models.truncated, false);
  assert.deepEqual(report.models.groups[0], {
    provider: "historical-provider", model: "historical-model", promptVersion: "old-prompt", providerAttempts: 3,
    tokenUsage: { inputTokens: { knownTokens: 300, unknownAttempts: 1 },
      cachedInputTokens: { knownTokens: 0, unknownAttempts: 0 }, cacheWriteInputTokens: { knownTokens: 0, unknownAttempts: 0 },
      outputTokens: { knownTokens: 0, unknownAttempts: 0 }, reasoningTokens: { knownTokens: 0, unknownAttempts: 0 } },
    latency: { knownAttempts: 2, unknownAttempts: 1, meanMs: 1000, minMs: 0, maxMs: 2000 },
  });
  assert.deepEqual(report.models.groups[1].latency, { knownAttempts: 0, unknownAttempts: 1, meanMs: null, minMs: null, maxMs: null });
  assert.equal(report.models.groups[1].model, null);
  assert.doesNotMatch(JSON.stringify(report), /private-request|private-key/);
});

test("model group output is bounded and empty reports keep unknown timing distinct from zero", async (t) => {
  const result = { daily: [], users: [], attempts: [], models: [] };
  mockReads(t, [result], []);
  const empty = await getUsageReport({}, config, now);
  assert.deepEqual(empty.models, { source: "retained_dispatch_attempts", limit: 100, truncated: false, groups: [] });
  result.models = Array.from({ length: 101 }, (_, index) => ({ _id: { provider: "test", model: `model-${index}`, promptVersion: null },
    providerAttempts: 1, latencyKnown: 0, latencyMean: null, latencyMin: null, latencyMax: null }));
  const bounded = await getUsageReport({}, config, now);
  assert.equal(bounded.models.groups.length, 100); assert.equal(bounded.models.truncated, true);
});

test("missing ledger stays unknown, historical headroom is not invented, and timezone conflicts fail closed", async (t) => {
  let budgets = [];
  mockReads(t, [], budgets);
  const missing = await getUsageReport({}, config, now);
  assert.equal(missing.budget.initialized, false);
  assert.equal(missing.budget.accountedMicroUsd, null);
  assert.equal(missing.budget.remainingUnderCurrentPolicyMicroUsd, null);
  assert.equal(missing.totals.acceptedMessages, 0);
  const historical = await getUsageReport({ month: "2026-09" }, config, now);
  assert.equal(historical.budget.currentPolicyLimitMicroUsd, null);
  assert.equal(historical.budget.remainingUnderCurrentPolicyMicroUsd, null);
  budgets.push({ _id: "control", billingTimezone: "UTC" });
  await assert.rejects(getUsageReport({}, config, now), { code: "assistant_accounting_unavailable" });
});

test("disabled reporting cannot query the database", async (t) => {
  t.mock.method(AssistantRun, "aggregate", () => { throw new Error("must not read"); });
  t.mock.method(AssistantBudget, "find", () => { throw new Error("must not read"); });
  await assert.rejects(getUsageReport({}, { enabled: false }, now), { code: "assistant_disabled" });
});

test("actual HTTP auth reserves usage reporting for verified superAdmin and sanitizes failures", async (t) => {
  const secretBefore = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "reporting-local-test-secret";
  t.after(() => { if (secretBefore === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = secretBefore; });
  const id = new mongoose.Types.ObjectId();
  const user = { _id: id, role: "user", active: true, phoneVerified: true };
  t.mock.method(UserModel, "findById", async () => user);
  let calls = 0; let failRead = false;
  const app = express();
  app.use("/assistant", createAssistantRouter({ getConfig: () => config, application: {
    async getUsageReport(query) { calls += 1; if (failRead) throw new Error("private OpenAI price prompt secret");
      return { month: query.month, totals: { acceptedMessages: 3 } }; },
  } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/assistant/admin/usage?month=2026-10`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(id) }, process.env.JWT_ACCESS_SECRET)}` };
  assert.equal((await fetch(url)).status, 401);
  for (const role of ["user", "admin", "moderator"]) {
    user.role = role; assert.equal((await fetch(url, { headers })).status, 403);
  }
  assert.equal(calls, 0);
  user.role = "superAdmin"; user.phoneVerified = false;
  assert.equal((await fetch(url, { headers })).status, 403); assert.equal(calls, 0);
  user.phoneVerified = true;
  const allowed = await fetch(url, { headers }); assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json()).data.month, "2026-10");
  user.role = "admin"; assert.equal((await fetch(url, { headers })).status, 403);
  user.role = "superAdmin"; failRead = true;
  const failed = await fetch(url, { headers }); assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /OpenAI|price|prompt|secret|stack/);
});
