import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantChat, AssistantEvent,
  AssistantMemory, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { processBusinessReports, recoverBusinessReports } from "../../../src/domains/assistant/admin/assistant.admin-reports.js";
import { businessConfigSnapshot } from "../../../src/domains/assistant/admin/assistant.admin-policy.js";
import { snapshotCard, reportCardDto, unavailableCard } from "../../../src/domains/assistant/admin/assistant.admin-cards.js";
import { renderBusinessResponse } from "../../../src/domains/assistant/admin/assistant.admin-render.js";
import { executeAdminAnalyticsTool } from "../../../src/domains/assistant/admin/assistant.admin-analytics.js";
import { getBusinessRun, getBusinessHistory } from "../../../src/domains/assistant/admin/assistant.admin-service.js";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ADMIN_PLAN_VERSION } from "../../../src/domains/assistant/admin/assistant.admin-plan.js";
import { testConfig, testPolicy } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";

const owner = new mongoose.Types.ObjectId();
const config = testConfig();
const invocation = (tool = "lowest_selling_products") => ({ tool,
  arguments: tool === "compare_order_months" ? { month: "2026-09", compareTo: "2026-08" } : { month: "2026-09", metric: "units", limit: 5 } });
const plain = (value) => value?.toObject ? value.toObject() : value;
const query = (read) => ({ session() { return this; }, select() { return this; }, maxTimeMS() { return this; }, sort() { return this; }, limit() { return this; },
  async lean() { const value = read(); return Array.isArray(value) ? value.map(plain) : plain(value); },
  then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });

function fixture(t, reports = [invocation()], language = "ar") {
  mockAssistantTransactions(t);
  const chat = new AssistantAdminChat({ _id: new mongoose.Types.ObjectId(), owner, contextVersion: 0, nextSequence: 1 });
  const run = new AssistantRun({ _id: new mongoose.Types.ObjectId(), owner, chat: chat._id, purpose: "admin_business", status: "queued", phase: "reports",
    key: "admin-business/report-test", hash: "synthetic", contextVersion: 0, input: "مبيعات سبتمبر", userSequence: 1, accounting: "settled",
    attempt: "paid-plan-1", attempts: [{ id: "paid-plan-1", number: 1, phase: "plan", accounting: "settled" }],
    adminPlan: { version: ADMIN_PLAN_VERSION, outcome: "reports", language, clarification: "none", reports }, adminWarehouseIds: [],
    config: businessConfigSnapshot(config), deadline: new Date(Date.now() + 60000), createdAt: new Date() });
  const state = { run, chat, account: { owner, activeRun: run._id, blocked: false }, user: { _id: owner, role: "superAdmin", active: true,
    phoneVerified: true, account_status: "confirmed" }, messages: [], events: [], reads: [], sourceRows: [], onRead: null, onSave: null, options: { getConfig: () => config } };
  run.save = async () => { assert.equal(run.validateSync(), undefined); await state.onSave?.(); };
  chat.save = async () => { assert.equal(chat.validateSync(), undefined); };
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => matchesQuery(run, filter) ? run : null));
  t.mock.method(AssistantRun, "find", (filter) => query(() => matchesQuery(run, filter) ? [run] : []));
  t.mock.method(UserModel, "findById", () => query(() => state.user));
  t.mock.method(AssistantAccount, "findOne", (filter) => query(() => matchesQuery(state.account, filter) ? state.account : null));
  t.mock.method(AssistantAccount, "updateOne", async (filter, update) => {
    if (matchesQuery(state.account, filter)) Object.assign(state.account, update.$set); return { modifiedCount: 1 };
  });
  t.mock.method(AssistantAdminChat, "findOne", (filter) => query(() => matchesQuery(chat, filter) ? chat : null));
  t.mock.method(AssistantAdminMessage, "create", async ([value]) => {
    const message = new AssistantAdminMessage({ ...value, _id: new mongoose.Types.ObjectId(), createdAt: new Date() });
    assert.equal(message.validateSync(), undefined); state.messages.push(message); return [message];
  });
  t.mock.method(AssistantAdminMessage, "findOne", (filter) => query(() => state.messages.find((value) => matchesQuery(value, filter)) ?? null));
  t.mock.method(AssistantAdminMessage, "find", (filter) => query(() => state.messages.filter((value) => matchesQuery(value, filter))));
  t.mock.method(AssistantEvent, "create", async ([value]) => { state.events.push(value); return [{ _id: new mongoose.Types.ObjectId() }]; });
  t.mock.method(OrderModel, "aggregate", (pipeline) => {
    state.reads.push(pipeline); state.onRead?.(pipeline);
    const values = pipeline.some((stage) => stage.$lookup) ? state.sourceRows
      : pipeline.some((stage) => stage.$group?.avgOrderValue) ? [{ totalSales: 300, totalOrders: 3, avgOrderValue: 100 }] : [];
    return Object.assign(Promise.resolve(values), { option(value) { assert.equal(value.maxTimeMS, 5000); return this; } });
  });
  for (const method of ["updateOne", "findOneAndUpdate", "create"]) t.mock.method(AssistantBudget, method, () => { throw new Error("Reports must not access financial ledgers"); });
  for (const model of [AssistantChat, AssistantMessage, AssistantMemory]) t.mock.method(model, "find", () => { throw new Error("No customer context"); });
  return state;
}

test("all three reports use actual domain services, publish exact saved cards once and release their own lock without paid work", async (t) => {
  const state = fixture(t, [invocation(), invocation("highest_selling_products"), invocation("compare_order_months")]);
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "completed" });
  assert.equal(state.reads.length, 8); assert.equal(state.run.adminReports.length, 3); assert.equal(state.messages.length, 1);
  assert.equal(state.run.attempts.length, 1); assert.equal(state.run.accounting, "settled"); assert.equal(state.account.activeRun, null);
  const result = await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(result.reports[2].data.periods.current.metrics.totalSales, 300);
  assert.equal(result.message.outcome, "reports"); assert.equal(result.message.language, "ar"); assert.match(result.message.text, /300/);
  assert.equal(result.message.reportHeaders.length, 3); assert.equal(result.reports[0].data.definition.stockAvailabilityAdjusted, false);
  assert.equal(result.reports[2].data.changes.totalSales.absolute, 0);
  const json = JSON.stringify(result);
  for (const privateField of ["dataJson", "reportIntent", "adminPlan", "signature", "provider", "paid-plan-1"]) assert.equal(json.includes(privateField), false);
  assert.equal(state.events.at(-1).type, "run_completed"); assert.equal(state.events.at(-1).detail.purpose, "admin_business");
  await processBusinessReports(state.run._id, state.options); assert.equal(state.reads.length, 8); assert.equal(state.messages.length, 1);
});

test("stored comparison arguments survive real Mongoose casting; history contains headers and get-run alone contains data", async (t) => {
  const state = fixture(t, [invocation("compare_order_months")], "en");
  await processBusinessReports(state.run._id, state.options);
  const history = await getBusinessHistory(owner, {}, config);
  assert.match(history.messages[0].text, /Recorded order total: 300/);
  assert.match(history.messages[0].text, /not profit or net revenue/);
  assert.equal(history.messages[0].reportHeaders[0].id, "report-1");
  assert.equal(JSON.stringify(history).includes("periods"), false); assert.equal(JSON.stringify(history).includes("reportIntent"), false);
  assert.equal(state.messages[0].reportIntent[0].arguments.month, "2026-09");
  const reads = state.reads.length;
  await getBusinessRun(owner, String(state.run._id), config); await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(state.reads.length, reads);
  state.messages[0].expiresAt = new Date(0);
  const expired = await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(expired.message, null); assert.deepEqual(expired.reports, []);
});

test("clarification, identity and unsupported outcomes use two reply languages, including Arabic for Arabizi plans", async (t) => {
  const state = fixture(t, []);
  for (const language of ["ar", "en", "arabizi"]) for (const outcome of ["clarify", "identity", "unsupported"]) {
    state.run.status = "queued"; state.run.responseMessage = null; state.account.activeRun = state.run._id;
    state.run.adminPlan = { version: ADMIN_PLAN_VERSION, outcome, language, clarification: outcome === "clarify" ? "metric" : "none", reports: [] };
    assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "completed" });
    const message = state.messages.at(-1);
    assert.equal(message.outcome, outcome); assert.equal(message.language, language === "arabizi" ? "ar" : language); assert.ok(message.text.length > 20);
    assert.equal(/[\u0621-\u064a]/u.test(message.text), language !== "en");
    assert.equal(/openai|luna|gemini|groq|gpt/i.test(message.text), false);
  }
  assert.equal(state.reads.length, 0);
});

test("a failed report produces an unavailable card alongside completed reports and cannot leak infrastructure errors", async (t) => {
  const state = fixture(t, [invocation(), invocation("highest_selling_products")]);
  state.onRead = (pipeline) => { if (pipeline.some((stage) => stage.$unionWith)) throw new Error("secret database URI"); };
  await processBusinessReports(state.run._id, state.options);
  const result = await getBusinessRun(owner, String(state.run._id), config);
  assert.deepEqual(result.reports.map((card) => card.status), ["unavailable", "success"]);
  assert.equal(result.reports[0].data, undefined); assert.equal(result.reports[0].code, "analytics_unavailable");
  assert.equal(result.message.outcome, "reports"); assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("all report failures produce execution_error without fabricated figures", async (t) => {
  const state = fixture(t);
  state.onRead = () => { throw new Error("query outage"); };
  await processBusinessReports(state.run._id, state.options);
  assert.equal(state.messages[0].outcome, "execution_error");
  const result = await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(result.reports[0].status, "unavailable"); assert.equal(result.reports[0].data, undefined);
});

test("oversized report data becomes a bounded unavailable card, with no truncated ranking or partial rows", async (t) => {
  const state = fixture(t);
  state.sourceRows = [{ _id: new mongoose.Types.ObjectId(), unitsSold: 1, recordedItemValue: 2, name_en: "x".repeat(70000), name_ar: null, imageUrl: null }];
  await processBusinessReports(state.run._id, state.options);
  const result = await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(result.reports[0].code, "report_snapshot_too_large"); assert.equal(result.reports[0].data, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(state.run.adminReports)) < config.adminReportMaxBytes);
});

test("revocation after an earlier saved report prevents the entire response and releases no data even if authority returns", async (t) => {
  const state = fixture(t, [invocation(), invocation("highest_selling_products")]);
  state.onRead = () => { if (state.reads.length === 2) state.user.role = "user"; };
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "failed" });
  assert.equal(state.run.adminReports.length, 1); assert.equal(state.messages.length, 0); assert.equal(state.account.activeRun, null);
  state.user.role = "superAdmin";
  assert.deepEqual((await getBusinessRun(owner, String(state.run._id), config)).reports, []);
});

test("a configuration change during a report discards its figures before saving or publishing", async (t) => {
  const state = fixture(t); let current = config;
  state.options.getConfig = () => current;
  state.onRead = () => { current = testConfig({ version: "report-policy-changed" }); };
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "failed" });
  assert.equal(state.run.publicCode, "configuration_changed"); assert.equal(state.messages.length, 0);
  assert.equal(state.run.adminReports?.length ?? 0, 0); assert.equal(state.account.activeRun, null);
});

test("item-value rankings keep exact row values, warehouse scope and missing-catalog evidence through real model casting", async (t) => {
  const warehouse = String(new mongoose.Types.ObjectId());
  const request = invocation("highest_selling_products"); Object.assign(request.arguments, { metric: "item_value", warehouse });
  const state = fixture(t, [request], "en"); state.run.adminWarehouseIds = [warehouse];
  state.sourceRows = [{ _id: new mongoose.Types.ObjectId(), name_en: null, name_ar: null, imageUrl: null,
    unitsSold: 2, recordedItemValue: 500, catalogPresent: false }];
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "completed" });
  const result = await getBusinessRun(owner, String(state.run._id), config);
  assert.equal(result.reports[0].data.results[0].recordedItemValue, 500);
  assert.equal(result.reports[0].data.results[0].catalogPresent, false);
  assert.equal(result.reports[0].data.filters.warehouse, warehouse);
  assert.match(result.message.text, /first row value 500/); assert.match(result.message.text, /changed or deleted/);
});

test("current configuration, password, block, ownership and active lock are checked before reads", async (t) => {
  const state = fixture(t);
  const cases = [() => { state.account.blocked = true; }, () => { state.user.passwordChangedAT = new Date(Date.now() + 1000); },
    () => { state.chat.owner = new mongoose.Types.ObjectId(); }, () => { state.run.config.adminRenderVersion = "changed"; },
    () => { state.account.activeRun = new mongoose.Types.ObjectId(); }];
  for (const mutate of cases) {
    state.run.status = "queued"; state.account.blocked = false; delete state.user.passwordChangedAT;
    state.chat.owner = owner; state.run.config = businessConfigSnapshot(config); state.account.activeRun = state.run._id;
    mutate();
    assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "failed" });
  }
  assert.equal(state.reads.length, 0); assert.equal(state.messages.length, 0);
});

test("a crash leaves saved cards intact; lease recovery resumes only unfinished reads without another model attempt", async (t) => {
  const state = fixture(t, [invocation(), invocation("highest_selling_products")]);
  const calls = [];
  state.options.executeReport = async (actor, request, options) => {
    calls.push(request.tool);
    if (calls.length === 2) throw new Error("Synthetic process interruption");
    return executeAdminAnalyticsTool(actor, request, options);
  };
  await assert.rejects(processBusinessReports(state.run._id, state.options), /Synthetic process interruption/);
  assert.equal(state.run.status, "dispatching"); assert.equal(state.run.adminReports.length, 1); assert.equal(state.messages.length, 0);
  const first = state.run.adminReports[0].dataJson;
  assert.equal(await recoverBusinessReports(config, new Date(Date.now() + 31000)), 1); assert.equal(state.run.status, "queued");
  await processBusinessReports(state.run._id, state.options);
  assert.deepEqual(calls, ["lowest_selling_products", "highest_selling_products", "highest_selling_products"]);
  assert.equal(state.run.adminReports[0].dataJson, first); assert.equal(state.run.attempts.length, 1); assert.equal(state.messages.length, 1);
});

test("an old report worker cannot persist or publish after its lease has been replaced", async (t) => {
  const state = fixture(t);
  state.options.executeReport = async (actor, request, options) => {
    const result = await executeAdminAnalyticsTool(actor, request, options); state.run.reportLease = "replacement-claim"; return result;
  };
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "superseded" });
  assert.equal(state.run.reportLease, "replacement-claim"); assert.equal(state.run.status, "dispatching");
  assert.equal(state.run.adminReports?.length ?? 0, 0); assert.equal(state.messages.length, 0);
});

test("recovery expires the whole report stage and unlocks only its own request without touching financial/customer/planner runs", async (t) => {
  const state = fixture(t);
  for (const change of [{ purpose: "customer" }, { phase: "plan" }, { accounting: "reserved" }]) {
    Object.assign(state.run, { purpose: "admin_business", phase: "reports", accounting: "settled", deadline: new Date(0) }, change);
    assert.equal(await recoverBusinessReports(config), 0);
  }
  Object.assign(state.run, { purpose: "admin_business", phase: "reports", accounting: "settled" });
  const foreignLock = new mongoose.Types.ObjectId(); state.account.activeRun = foreignLock;
  assert.equal(await recoverBusinessReports(config), 1); assert.equal(state.run.status, "failed");
  assert.equal(state.run.publicCode, "report_stage_expired"); assert.equal(state.account.activeRun, foreignLock);
});

test("missing admin snapshot limit never changes customer config signatures and rejects business snapshot creation", () => {
  const env = { ASSISTANT_ENABLED: "true", ASSISTANT_ADMIN_ENABLED: "true", OPENAI_API_KEY: "synthetic", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy()) };
  const missing = loadAssistantConfig(env); const small = loadAssistantConfig({ ...env, ASSISTANT_ADMIN_REPORT_MAX_BYTES: "4096" });
  const large = loadAssistantConfig({ ...env, ASSISTANT_ADMIN_REPORT_MAX_BYTES: "65536" });
  assert.equal(missing.enabled, true); assert.equal(missing.signature, small.signature); assert.equal(small.signature, large.signature);
  assert.throws(() => businessConfigSnapshot(missing), { code: "admin_report_configuration_required" });
  assert.notEqual(businessConfigSnapshot(small).signature, businessConfigSnapshot(large).signature);
  for (const value of ["junk", "4095", "262145", "3.5"]) assert.throws(() => businessConfigSnapshot(loadAssistantConfig({ ...env,
    ASSISTANT_ADMIN_REPORT_MAX_BYTES: value })), { code: "admin_report_configuration_required" });
});

test("snapshot projection rejects wrong scope or malformed numbers and strips fields outside existing DTOs", async (t) => {
  const state = fixture(t, [invocation("highest_selling_products")]);
  const request = invocation("highest_selling_products");
  const result = await executeAdminAnalyticsTool(owner, request, state.options);
  result.data.privateSecret = "hidden";
  const card = snapshotCard(request, 0, result, config, 1);
  assert.equal(card.dataJson.includes("privateSecret"), false);
  result.data.filters.warehouse = String(new mongoose.Types.ObjectId());
  assert.throws(() => snapshotCard(request, 0, result, config, 1), { code: "invalid_report_snapshot" });
  assert.equal(reportCardDto({ ...card, dataJson: "not-json" }).code, "stored_report_unavailable");
  const comparison = await executeAdminAnalyticsTool(owner, invocation("compare_order_months"), state.options);
  comparison.data.periods.current.metrics.totalSales = Infinity;
  assert.throws(() => snapshotCard(invocation("compare_order_months"), 0, comparison, config, 1), { code: "invalid_report_snapshot" });
});

test("localized ranking responses preserve stock/currency caveats and never exceed the configured response size silently", async (t) => {
  const state = fixture(t);
  const request = invocation(); const result = await executeAdminAnalyticsTool(owner, request, state.options);
  const card = snapshotCard(request, 0, result, config, 1);
  for (const language of ["ar", "en", "arabizi"]) {
    const rendered = renderBusinessResponse({ outcome: "reports", language }, [card], config);
    assert.equal(rendered.language, language === "arabizi" ? "ar" : language); assert.match(rendered.text, /2026-09/); assert.ok(rendered.text.length > 150);
    if (language === "arabizi") assert.deepEqual(rendered, renderBusinessResponse({ outcome: "reports", language: "ar" }, [card], config));
  }
  assert.throws(() => renderBusinessResponse({ outcome: "reports", language: "en" }, [card], { ...config, maxOutputChars: 10 }), { code: "admin_response_too_large" });
});

test("legacy Arabizi plans render all clarifications and failed reports as Arabic without mutating plans or cards", () => {
  for (const clarification of ["period", "baseline_period", "metric", "warehouse", "request"]) {
    const plan = Object.freeze({ outcome:"clarify", language:"arabizi", clarification, reports:[] });
    const response = renderBusinessResponse(plan, [], config);
    assert.equal(response.language,"ar");assert.match(response.text,/[\u0621-\u064a]/u);assert.equal(plan.language,"arabizi");
    assert.deepEqual(response,renderBusinessResponse({...plan,language:"ar"},[],config));
  }
  const cards=[unavailableCard(invocation(),0)],before=JSON.stringify(cards);
  const result=renderBusinessResponse({outcome:"reports",language:"arabizi"},cards,config);
  assert.equal(result.language,"ar");assert.equal(result.outcome,"execution_error");assert.match(result.text,/غير متاح/);
  assert.equal(JSON.stringify(cards),before);
});

test("new Arabic-script replies preserve original Arabizi input and historical saved replies", async t => {
  const state=fixture(t,[],"arabizi"),originalInput="3ayez ta2reer shahr 9";
  state.run.input=originalInput;state.run.adminPlan.outcome="clarify";state.run.adminPlan.clarification="period";
  const legacy=new AssistantAdminMessage({_id:new mongoose.Types.ObjectId(),owner,chat:state.chat._id,run:state.run._id,
    role:"assistant",sequence:1,text:"Te2sad shahr w sana eh?",language:"arabizi",outcome:"clarify",createdAt:new Date(),expiresAt:new Date("2100-01-01")});
  assert.equal(legacy.validateSync(),undefined);state.messages.push(legacy);
  await processBusinessReports(state.run._id,state.options);
  assert.equal(state.messages.at(-1).language,"ar");assert.equal(state.messages.at(-1).text,"تقصد شهر وسنة إيه؟");
  assert.equal(state.run.input,originalInput);assert.equal(state.run.adminPlan.language,"arabizi");
  const history=await getBusinessHistory(owner,{},config),old=history.messages.find(row=>row.id===String(legacy._id));
  assert.equal(old.language,"arabizi");assert.equal(old.text,"Te2sad shahr w sana eh?");assert.equal(state.reads.length,0);
});

test("a malformed saved plan fails before reads and malformed report output becomes an explicit unavailable card", async (t) => {
  const state = fixture(t);
  state.run.adminPlan.reports = undefined;
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "failed" });
  assert.equal(state.run.publicCode, "invalid_admin_plan"); assert.equal(state.reads.length, 0);
  state.run.adminPlan.reports = [invocation()]; state.run.status = "queued"; state.account.activeRun = state.run._id;
  state.options.executeReport = async () => null;
  assert.deepEqual(await processBusinessReports(state.run._id, state.options), { status: "completed" });
  assert.equal(state.run.adminReports[0].code, "invalid_report_snapshot"); assert.equal(state.messages[0].outcome, "execution_error");
});
