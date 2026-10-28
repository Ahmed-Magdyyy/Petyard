import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { executeAdminAnalyticsTool } from "../../../src/domains/assistant/admin/assistant.admin-analytics.js";
import { AssistantAccount, AssistantRun, AssistantBudget, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const actor = new mongoose.Types.ObjectId();
const root = { _id: actor, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed", enabledControls: [] };
const config = testConfig();
const options = { getConfig: () => config };
const ranking = { tool: "highest_selling_products", arguments: { month: "2020-09", metric: "units", limit: 7 } };

function fixtures(t) {
  const state = { user: { ...root }, account: null, userReads: 0, accountReads: 0, reports: [], onReport: null, onUser: null };
  const query = (read) => ({ select() { return this; }, maxTimeMS(ms) { assert.equal(ms, 5000); return this; }, async lean() { return read(); } });
  t.mock.method(UserModel, "findById", (id) => { assert.equal(String(id), String(actor));
    return query(() => { state.userReads += 1; state.onUser?.(); return state.user; }); });
  t.mock.method(AssistantAccount, "findOne", ({ owner }) => { assert.equal(String(owner), String(actor));
    return query(() => { state.accountReads += 1; return state.account; }); });
  t.mock.method(OrderModel, "aggregate", (pipeline) => { state.reports.push(pipeline); state.onReport?.();
    return Object.assign(Promise.resolve([]), { option(value) { assert.equal(value.maxTimeMS, 5000); return this; } }); });
  return state;
}

const rejectsCode = (promise, code, status) => assert.rejects(promise, (error) => error.code === code && error.status === status);

test("admin tool entry denies disabled config, malformed calls and non-allowlisted names before identity/report reads", async (t) => {
  const state = fixtures(t);
  await rejectsCode(executeAdminAnalyticsTool(actor, ranking, { getConfig: () => ({ enabled: false }) }), "assistant_disabled", 503);
  await rejectsCode(executeAdminAnalyticsTool("bad", ranking, options), "invalid_identifier", 400);
  for (const invocation of [null, [], {}, { ...ranking, actorId: String(actor) }, { ...ranking, arguments: [] }, { ...ranking, arguments: null }]) {
    await rejectsCode(executeAdminAnalyticsTool(actor, invocation, options), "invalid_request", 400);
  }
  for (const tool of ["constructor", "__proto__", "toString", "create_bundle", "block_user", "usage_report", "mongo_query"]) {
    await rejectsCode(executeAdminAnalyticsTool(actor, { ...ranking, tool }, options), "unsupported_analytics_tool", 400);
  }
  assert.equal(state.userReads, 0); assert.equal(state.accountReads, 0); assert.equal(state.reports.length, 0);
});

test("fresh identity and AI access protect report execution, independent of client role or manual bundle permission", async (t) => {
  const state = fixtures(t);
  for (const user of [null, { ...root, role: "user" }, { ...root, role: "moderator", enabledControls: ["analytics"] },
    { ...root, role: "admin", enabledControls: ["products"] }, { ...root, role: "admin", enabledControls: [] },
    { ...root, role: "admin", enabledControls: "analytics" }, { ...root, active: false }, { ...root, deletedAt: new Date() },
    { ...root, phoneVerified: false }, { ...root, account_status: "banned" }, { ...root, account_status: "deleted" }]) {
    state.user = user;
    await rejectsCode(executeAdminAnalyticsTool(actor, ranking, options), "access_denied", 403);
  }
  state.user = { ...root }; state.account = { blocked: true };
  await rejectsCode(executeAdminAnalyticsTool(actor, ranking, options), "ai_restricted", 403);
  assert.equal(state.reports.length, 0);
});

test("all three allowlisted tools reuse actual domain services and return only their existing DTOs", async (t) => {
  const state = fixtures(t); state.user = { ...root, role: "admin", enabledControls: ["analytics"] };
  for (const model of [AssistantAccount, AssistantRun, AssistantBudget, AssistantMessage]) {
    t.mock.method(model, "create", () => { throw new Error("Unexpected assistant write"); });
    t.mock.method(model, "updateOne", () => { throw new Error("Unexpected assistant write"); });
  }
  for (const tool of ["highest_selling_products", "lowest_selling_products"]) {
    const result = await executeAdminAnalyticsTool(actor, { ...ranking, tool }, options);
    assert.equal(result.tool, tool); assert.deepEqual(result.data.results, []); assert.equal(result.data.limit, 7);
    assert.equal(result.data.definition.currency, null);
    assert.deepEqual(Object.keys(result).sort(), ["data", "tool"]);
  }
  const comparison = await executeAdminAnalyticsTool(actor, { tool: "compare_order_months", arguments: { month: "2020-09", compareTo: "2020-08" } }, options);
  assert.equal(comparison.data.definition.id, "dashboard_order_totals_v1");
  assert.equal(comparison.data.periods.current.metrics.totalSales, 0);
  assert.equal(state.userReads, 6); assert.equal(state.accountReads, 6); assert.equal(state.reports.length, 8);
  assert.equal(state.reports[0].find((stage) => stage.$limit).$limit, 7);
  assert.ok(state.reports[1].some((stage) => stage.$unionWith));
});

test("tool arguments retain strict domain validation and only integer numeric limits are adapted", async (t) => {
  const state = fixtures(t);
  for (const limit of ["5", 0, 51, 1.5, true, null, [5], { $gt: 0 }]) {
    await rejectsCode(executeAdminAnalyticsTool(actor, { ...ranking, arguments: { ...ranking.arguments, limit } }, options), "analytics_arguments_invalid", 400);
  }
  for (const args of [{ month: "2020-09" }, { ...ranking.arguments, metric: "profit" },
    { ...ranking.arguments, warehouse: { $ne: null } }, { ...ranking.arguments, query: {} }]) {
    await rejectsCode(executeAdminAnalyticsTool(actor, { ...ranking, arguments: args }, options), "analytics_arguments_invalid", 400);
  }
  await rejectsCode(executeAdminAnalyticsTool(actor, { tool: "compare_order_months", arguments: { month: "2020-09", compareTo: "2020-08", limit: 5 } }, options), "analytics_arguments_invalid", 400);
  assert.equal(state.reports.length, 0);
  const result = await executeAdminAnalyticsTool(actor, { tool: ranking.tool, arguments: { month: "2020-09", metric: "units" } }, options);
  assert.equal(result.data.limit, 5);
});

test("permission revocation, AI block or disabled config during report execution discards computed data", async (t) => {
  const state = fixtures(t);
  for (const [change, code] of [[() => { state.user = { ...root, role: "admin", enabledControls: [] }; }, "access_denied"],
    [() => { state.user = null; }, "access_denied"], [() => { state.user.phoneVerified = false; }, "access_denied"],
    [() => { state.account = { blocked: true }; }, "ai_restricted"]]) {
    state.user = { ...root }; state.account = null; state.onReport = change;
    await rejectsCode(executeAdminAnalyticsTool(actor, ranking, options), code, 403);
  }
  state.user = { ...root }; state.account = null; state.onReport = null;
  let calls = 0;
  await rejectsCode(executeAdminAnalyticsTool(actor, ranking, { getConfig: () => ++calls === 1 ? config : { enabled: false } }), "assistant_disabled", 503);
});

test("authorization/report infrastructure errors fail closed without leaking internal details", async (t) => {
  const state = fixtures(t);
  state.onUser = () => { throw new Error("private database credential"); };
  await rejectsCode(executeAdminAnalyticsTool(actor, ranking, options), "analytics_unavailable", 503);
  assert.equal(state.reports.length, 0); state.onUser = null;
  state.onReport = () => { throw new Error("private query and account data"); };
  await assert.rejects(executeAdminAnalyticsTool(actor, ranking, options), (error) =>
    error.status === 503 && error.code === "analytics_unavailable" && !/private|credential|query/.test(error.message));
});

test("the validated tool and copied arguments cannot be replaced during an asynchronous access read", async (t) => {
  const state = fixtures(t); const invocation = { tool: ranking.tool, arguments: { ...ranking.arguments } };
  state.onUser = () => { invocation.tool = "create_bundle"; invocation.arguments = { command: "not executable" }; };
  const result = await executeAdminAnalyticsTool(actor, invocation, options);
  assert.equal(result.tool, ranking.tool); assert.equal(result.data.limit, 7); assert.equal(state.reports.length, 1);
});
