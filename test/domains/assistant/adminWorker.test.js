import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantChat, AssistantEvent,
  AssistantMemory, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { prepareBusinessPlan, finishBusinessPlan, processBusinessPlan, recoverBusinessPlans } from "../../../src/domains/assistant/admin/assistant.admin-worker.js";
import { buildBusinessContext } from "../../../src/domains/assistant/admin/assistant.admin-context.js";
import { businessConfigSnapshot, ADMIN_PROMPT_VERSION, ADMIN_RENDER_VERSION, adminInstructions } from "../../../src/domains/assistant/admin/assistant.admin-policy.js";
import { adminPlanSchema } from "../../../src/domains/assistant/admin/assistant.admin-plan.js";
import { costMicroUsd, reservationMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";
import { drainAssistantWork } from "../../../src/domains/assistant/assistant.runtime.js";
import { AssistantBookingReceipt } from "../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { knownUsage, testConfig } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { referenceWorker } from "../../../src/domains/assistant/references/assistant.reference-worker.js";
import { referenceTestConfig } from "./fixtures/referenceMemory.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";

const owner = new mongoose.Types.ObjectId();
const chatId = new mongoose.Types.ObjectId();
const warehouseId = new mongoose.Types.ObjectId();
const config = testConfig();
const plan = (extras = {}) => ({ outcome: "reports", language: "ar", clarification: "none", reports: [
  { tool: "lowest_selling_products", arguments: { month: "2026-09", compareTo: null, metric: "units", warehouse: null, limit: null } },
], ...extras });
const response = (extras = {}) => ({ structured: plan(), usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], providerRequestId: "local-request", latencyMs: 12, ...extras });
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

function fixture(t) {
  mockAssistantTransactions(t);
  const query = (read) => {
    let limit = Infinity;
    const result = () => { const value = read(); return Array.isArray(value) ? value.slice(0, limit) : value; };
    return { session() { return this; }, select() { return this; }, sort() { return this; }, maxTimeMS() { return this; },
      limit(value) { limit = value; return this; }, async lean() { return result(); },
      then(resolve, reject) { return Promise.resolve().then(result).then(resolve, reject); } };
  };
  const run = { _id: new mongoose.Types.ObjectId(), owner, chat: chatId, purpose: "admin_business", phase: "plan", status: "queued",
    key: "admin-business/local-key", hash: "local-hash", contextVersion: 0, input: "هات أقل 5 منتجات مبيعًا بالعدد في سبتمبر 2026", userSequence: 5,
    config: businessConfigSnapshot(config), createdAt: new Date(), deadline: new Date(Date.now() + 60000),
    attempt: null, reservation: null, accounting: "none", attempts: [],
    toObject() { const { save, toObject, ...value } = this; return { ...value, attempts: value.attempts.map((attempt) => ({ ...attempt })) }; },
    async save() { assert.equal(new AssistantRun(this.toObject()).validateSync(), undefined); state.saves++; } };
  const state = { run, rows: [run], user: { _id: owner, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" },
    account: { owner, activeRun: run._id, blocked: false }, chat: { _id: chatId, owner, contextVersion: 0, contextAfterSequence: 1 },
    warehouses: [{ _id: warehouseId, name: "القاهرة", code: "CAI", active: true }], messages: [], events: [], budgets: new Map(),
    budgetWrites: [], saves: 0, calls: 0, failSettlement: false, onHistory: null };
  t.mock.method(UserModel, "findById", (id) => { assert.equal(String(id), String(owner)); return query(() => state.user); });
  t.mock.method(AssistantAccount, "findOne", (filter) => query(() => matchesQuery(state.account, filter) ? state.account : null));
  t.mock.method(AssistantAccount, "updateOne", async (filter, update) => {
    if (matchesQuery(state.account, filter)) Object.assign(state.account, update.$set);
    return { modifiedCount: 1 };
  });
  t.mock.method(AssistantAdminChat, "findOne", (filter) => query(() => state.chat && matchesQuery(state.chat, filter) ? state.chat : null));
  t.mock.method(AssistantAdminMessage, "find", (filter) => query(() => {
    state.onHistory?.(); return state.messages.filter((value) => matchesQuery(value, filter)).sort((a, b) => b.sequence - a.sequence);
  }));
  t.mock.method(WarehouseModel, "find", () => query(() => state.warehouses));
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => state.rows.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantRun, "find", (filter) => query(() => state.rows.filter((row) => matchesQuery(row, filter))));
  t.mock.method(AssistantEvent, "create", async ([value]) => { state.events.push(value); return [{ _id: new mongoose.Types.ObjectId() }]; });
  t.mock.method(AssistantBudget, "findOneAndUpdate", () => query(() => ({ billingTimezone: config.timezone, openingExposure: config.openingExposure, frozen: false })));
  t.mock.method(AssistantBudget, "updateOne", async (filter, update) => {
    state.budgetWrites.push({ filter, update });
    if (state.failSettlement && update.$inc?.spent !== undefined) throw new Error("Synthetic ledger outage");
    let row = state.budgets.get(filter._id);
    if (update.$setOnInsert) { if (!row) state.budgets.set(filter._id, { spent: update.$setOnInsert.spent ?? 0, reserved: 0 }); return { modifiedCount: 1 }; }
    row = state.budgets.get(filter._id);
    assert.ok(row);
    if (filter.reserved) assert.ok(row.reserved >= filter.reserved.$gte);
    if (update.$inc) for (const [key, amount] of Object.entries(update.$inc)) row[key] += amount;
    return { modifiedCount: 1 };
  });
  for (const model of [AssistantChat, AssistantMessage, AssistantMemory]) {
    t.mock.method(model, "find", () => { throw new Error("Business planner must not read customer context"); });
  }
  state.options = { getConfig: () => config, adapterFactory: () => ({ async generate(request) { state.calls++; state.request = request; return response(); } }) };
  return state;
}

test("one planning attempt uses shared reservations, persists only a validated typed plan and keeps the report-stage lock", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { status: "queued", phase: "reports" });
  assert.equal(state.calls, 1); assert.equal(state.run.attempts.length, 1); assert.equal(state.run.accounting, "settled");
  assert.equal(state.run.chargedMicroUsd, costMicroUsd(knownUsage, config));
  assert.equal(state.run.adminPlan.reports[0].arguments.limit, 5);
  assert.equal(state.run.config.adminPromptVersion, ADMIN_PROMPT_VERSION);
  assert.equal(String(state.account.activeRun), String(state.run._id));
  assert.equal(state.budgets.size, 2);
  for (const [id, budget] of state.budgets) {
    assert.ok(id.startsWith("global:") || id.startsWith(`user:${owner}:`));
    assert.deepEqual(budget, { spent: costMicroUsd(knownUsage, config), reserved: 0 });
  }
  assert.equal(state.budgetWrites.filter(({ update }) => update.$inc?.reserved === reservationMicroUsd(config)).length, 2);
  assert.equal(state.run.attempts[0].accounting, "settled");
  assert.equal(state.request.outputSchema, adminPlanSchema); assert.deepEqual(state.request.tools, []);
  assert.equal(state.events.at(-1).type, "admin_plan_ready"); assert.equal(JSON.stringify(state.events).includes(state.run.input), false);
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { skipped: true }); assert.equal(state.calls, 1);
});

test("private context obeys ownership, retention, cutoff and history bounds and sends no contact/pet/account data", async (t) => {
  const state = fixture(t);
  const message = (sequence, extras = {}) => ({ owner, chat: chatId, sequence, role: "user", text: `message-${sequence}`, expiresAt: new Date("2100-01-01"), ...extras });
  state.messages = [message(1), message(2), message(3, { owner: new mongoose.Types.ObjectId() }), message(4, { expiresAt: new Date(0) }), message(5), message(6)];
  state.warehouses[0].email = "private@example.test";
  const { request, allowedWarehouseIds } = await buildBusinessContext(state.run, state.chat, config, null, new Date("2026-10-19T12:00:00Z"));
  assert.deepEqual(request.messages.map(({ content }) => content), ["message-2", state.run.input]);
  assert.deepEqual(allowedWarehouseIds, [String(warehouseId)]);
  assert.match(request.instructions, /2026-10-19/); assert.match(request.instructions, /Egyptian Arabic/);
  assert.equal(request.instructions.includes("private@example.test"), false); assert.equal(request.instructions.includes(String(owner)), false);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= config.maxContextBytes);
  const small = { ...config, maxContextBytes: Buffer.byteLength(JSON.stringify(request)) - 1 };
  assert.equal((await buildBusinessContext(state.run, state.chat, small, null)).request.messages.length, 1);
  await rejectsCode(buildBusinessContext(state.run, state.chat, { ...config, maxContextBytes: 1 }, null), "context_too_large");
});

test("Arabizi source wording is retained while planner instructions require Arabic-script replies", async t => {
  const state=fixture(t),input="3ayez a2al montagat bel 3adad fe september 2026";
  state.run.input=input;
  await processBusinessPlan(state.run._id,state.options);
  assert.equal(state.calls,1);assert.equal(state.run.input,input);assert.equal(state.request.messages.at(-1).content,input);
  assert.match(adminInstructions,/Choose language ar for Arabic or Arabizi input, en for English input/);
  assert.match(adminInstructions,/never Latin-script Arabizi/);assert.equal(state.request.outputSchema,adminPlanSchema);
});

test("old business prompt or renderer snapshots fail before any new provider reservation", async t => {
  const state=fixture(t);
  for(const [field,old]of [["adminPromptVersion","petyard-admin-planner-v1"],["adminRenderVersion","petyard-admin-cards-v1"]]){
    state.run.status="queued";state.run.config={...businessConfigSnapshot(config),[field]:old};state.account.activeRun=state.run._id;
    assert.deepEqual(await processBusinessPlan(state.run._id,state.options),{failedBeforeDispatch:true});
    assert.equal(state.run.publicCode,"configuration_changed");assert.equal(state.calls,0);assert.equal(state.budgetWrites.length,0);
  }
  assert.notEqual(ADMIN_PROMPT_VERSION,"petyard-admin-planner-v1");assert.notEqual(ADMIN_RENDER_VERSION,"petyard-admin-cards-v1");
});

test("disabled, customer/unknown-purpose and report-stage runs never plan or spend", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await processBusinessPlan(state.run._id, { ...state.options, getConfig: () => ({ enabled: false }) }), { skipped: true });
  for (const purpose of [undefined, null, "customer", "unknown"]) {
    state.run.purpose = purpose;
    assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { skipped: true });
    assert.equal(await finishBusinessPlan({ run: state.run }, response(), null, { currentConfig: config }), null);
  }
  state.run.purpose = "admin_business"; state.run.phase = "reports";
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { skipped: true });
  assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0);
});

test("invalid authority/config/context/expired queues fail before reservation and release only their own active lock", async (t) => {
  const state = fixture(t);
  const scenarios = [() => { state.user.role = "moderator"; }, () => { state.account.blocked = true; },
    () => { state.user.passwordChangedAT = new Date(Date.now() + 1000); }, () => { state.chat.contextVersion++; },
    () => { state.run.config.adminPromptVersion = "stale"; }, () => { state.run.deadline = new Date(0); },
    () => { state.account.activeRun = new mongoose.Types.ObjectId(); }];
  for (const mutate of scenarios) {
    state.user = { _id: owner, role: "superAdmin", active: true, phoneVerified: true };
    state.account.blocked = false; state.account.activeRun = state.run._id; state.chat.contextVersion = 0;
    state.run.config = businessConfigSnapshot(config); state.run.deadline = new Date(Date.now() + 60000); state.run.status = "queued";
    mutate(); const previousLock = state.account.activeRun;
    assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { failedBeforeDispatch: true });
    assert.equal(state.run.status, "failed");
    assert.equal(state.account.activeRun, String(previousLock) === String(state.run._id) ? null : previousLock);
  }
  assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0);
});

test("warehouse context overflow fails before spending rather than silently ignoring warehouses", async (t) => {
  const state = fixture(t);
  state.warehouses = Array.from({ length: 101 }, () => ({ _id: new mongoose.Types.ObjectId(), name: "Warehouse" }));
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.publicCode, "admin_context_too_large"); assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0);
});

test("current access is checked again immediately before HTTP; denied dispatch settles zero without a call", async (t) => {
  const state = fixture(t);
  state.options.adapterFactory = () => { state.account.blocked = true; return { async generate() { state.calls++; } }; };
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { failedBeforeDispatch: true });
  assert.equal(state.run.status, "failed"); assert.equal(state.run.accounting, "settled"); assert.equal(state.run.chargedMicroUsd, 0);
  assert.equal(state.account.activeRun, null); assert.equal(state.calls, 0);
  for (const budget of state.budgets.values()) assert.deepEqual(budget, { spent: 0, reserved: 0 });
});

test("known usage is charged even for an invalid plan, and there is no repair call", async (t) => {
  const state = fixture(t);
  state.options.adapterFactory = () => ({ async generate() { state.calls++; return response({ structured: plan({ reports: [
    { tool: "lowest_selling_products", arguments: { month: "2026-09", compareTo: null, metric: "units", warehouse: String(new mongoose.Types.ObjectId()), limit: 5 } },
  ] }) }); } });
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.run.publicCode, "invalid_admin_plan");
  assert.equal(state.run.accounting, "settled"); assert.equal(state.run.chargedMicroUsd, costMicroUsd(knownUsage, config));
  assert.equal(state.run.adminPlan, undefined); assert.equal(state.account.activeRun, null); assert.equal(state.calls, 1);
  await processBusinessPlan(state.run._id, state.options); assert.equal(state.calls, 1);
});

test("access loss after a paid response charges usage but never publishes a plan", async (t) => {
  const state = fixture(t);
  state.options.adapterFactory = () => ({ async generate() { state.calls++; state.user.role = "user"; return response(); } });
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.publicCode, "access_denied"); assert.equal(state.run.status, "failed");
  assert.equal(state.run.adminPlan, undefined); assert.equal(state.run.accounting, "settled"); assert.equal(state.account.activeRun, null);
});

test("policy changes during HTTP settle the original price snapshot but discard the plan", async (t) => {
  const state = fixture(t);
  let current = config;
  state.options.getConfig = () => current;
  state.options.adapterFactory = () => ({ async generate() {
    state.calls++; current = testConfig({ version: "changed-after-dispatch" }); return response();
  } });
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.publicCode, "configuration_changed"); assert.equal(state.run.adminPlan, undefined);
  assert.equal(state.run.chargedMicroUsd, costMicroUsd(knownUsage, config)); assert.equal(state.account.activeRun, null);
});

test("unknown usage retains exposure and lock, with no automatic HTTP retry or TTL", async (t) => {
  const state = fixture(t);
  state.options.adapterFactory = () => ({ async generate() { state.calls++; throw new Error("Synthetic timeout after dispatch"); } });
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.status, "uncertain"); assert.equal(state.run.accounting, "reserved"); assert.equal(state.run.expiresAt, undefined);
  assert.equal(String(state.account.activeRun), String(state.run._id));
  for (const budget of state.budgets.values()) assert.deepEqual(budget, { spent: 0, reserved: reservationMicroUsd(config) });
  await processBusinessPlan(state.run._id, state.options); assert.equal(state.calls, 1);
});

test("unverified billing tier never settles using an unverified standard price", async (t) => {
  const state = fixture(t);
  state.options.adapterFactory = () => ({ async generate() { state.calls++; return response({ serviceTier: "flex" }); } });
  await processBusinessPlan(state.run._id, state.options);
  assert.equal(state.run.status, "uncertain"); assert.equal(state.run.accounting, "reserved"); assert.equal(state.run.internalCode, "unverified_service_tier");
});

test("settlement outages leave the durable dispatch boundary and never send another paid request", async (t) => {
  const state = fixture(t); state.failSettlement = true;
  await assert.rejects(processBusinessPlan(state.run._id, state.options), /Synthetic ledger outage/);
  assert.equal(state.run.status, "dispatching"); assert.equal(state.run.accounting, "reserved"); assert.equal(state.calls, 1);
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { skipped: true }); assert.equal(state.calls, 1);
});

test("duplicate finish does not charge twice; a recovered attempt can accept its own late known result", async (t) => {
  const state = fixture(t);
  const prepared = await prepareBusinessPlan(state.run._id, config);
  state.run.dispatchDeadline = new Date(0);
  assert.equal(await recoverBusinessPlans(config), 1); assert.equal(state.run.status, "uncertain");
  await finishBusinessPlan(prepared, response(), null, { currentConfig: config });
  assert.equal(state.run.phase, "reports");
  const writes = state.budgetWrites.length;
  assert.equal(await finishBusinessPlan(prepared, response(), null, { currentConfig: config }), null);
  assert.equal(state.budgetWrites.length, writes);
});

test("recovery only expires unpaid admin plans or holds interrupted admin exposure, leaving customer and reports alone", async (t) => {
  const state = fixture(t);
  const expired = { ...state.run, _id: new mongoose.Types.ObjectId(), deadline: new Date(0) };
  state.run.purpose = "customer"; state.run.deadline = new Date(0);
  const reports = { ...expired, _id: new mongoose.Types.ObjectId(), phase: "reports", accounting: "settled" };
  state.rows.push(expired, reports); state.account.activeRun = expired._id;
  assert.equal(await recoverBusinessPlans(config), 1);
  assert.equal(expired.status, "failed"); assert.equal(expired.publicCode, "queue_expired"); assert.equal(state.account.activeRun, null);
  assert.equal(state.run.status, "queued"); assert.equal(reports.status, "queued"); assert.equal(state.budgetWrites.length, 0);
});

test("planner uses the real adapter over local HTTP, with the Postman fixture selectable explicitly", async (t) => {
  const state = fixture(t);
  let endpoint = process.env.ASSISTANT_ADMIN_SIMULATION_URL;
  let requests = 0;
  if (!endpoint) {
    const server = createServer(async (req, res) => {
      requests++;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/responses"); assert.equal(req.headers.authorization, undefined);
      assert.deepEqual(body.text.format.schema, adminPlanSchema); assert.equal(body.text.format.strict, true);
      assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.service_tier, "default"); assert.equal(body.tools, undefined);
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "local-worker-protocol" });
      res.end(JSON.stringify({ id: "resp_local_worker", model: config.model, status: "completed", service_tier: "default",
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
          text: JSON.stringify(plan({ outcome: "clarify", clarification: "metric", reports: [] })) }] }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  }
  state.options.adapterFactory = () => createOpenAIResponsesAdapter({ apiKey: "local-test-never-a-real-key", model: config.model,
    endpoint });
  const result = await processBusinessPlan(state.run._id, state.options);
  assert.deepEqual(result, { status: "queued", phase: "reports" });
  assert.equal(state.run.adminPlan.outcome, "clarify"); assert.equal(state.run.accounting, "settled");
  if (!process.env.ASSISTANT_ADMIN_SIMULATION_URL) assert.equal(requests, 1);
});

test("runtime isolates a customer failure and completes business planning plus reports with one provider call", async (t) => {
  const state = fixture(t);
  t.mock.method(AssistantMemory, "updateMany", async () => ({ modifiedCount: 0 }));
  t.mock.method(OrderModel, "aggregate", () => Object.assign(Promise.resolve([]), { option() { return this; } }));
  const messages = [];
  t.mock.method(AssistantAdminMessage, "create", async ([value]) => {
    const message = new AssistantAdminMessage({ ...value, _id: new mongoose.Types.ObjectId(), createdAt: new Date() });
    assert.equal(message.validateSync(), undefined); messages.push(message); return [message];
  });
  state.chat.nextSequence = state.run.userSequence; state.chat.save = async () => {};
  // An infrastructure error on one owner's work must not starve another purpose's queue.
  const customer = { _id: new mongoose.Types.ObjectId(), status: "queued" };
  const unknown = { _id: new mongoose.Types.ObjectId(), status: "queued", purpose: "unknown" };
  state.rows.unshift(customer, unknown);
  const find = AssistantRun.findOne;
  let customerClaims = 0;
  t.mock.method(AssistantRun, "findOne", (filter) => {
    if (filter.$and) { customerClaims++; throw new Error("Synthetic customer read outage"); }
    return find(filter);
  });
  const result = await drainAssistantWork(state.options);
  assert.deepEqual(result, { enabled: true, processed: 2, failed: 1 });
  assert.equal(customerClaims, 1); assert.equal(state.calls, 1); assert.equal(state.run.status, "completed");
  assert.equal(state.run.phase, "reports"); assert.equal(state.account.activeRun, null); assert.equal(messages.length, 1);
  assert.equal(state.run.attempts.length, 1); assert.equal(state.run.accounting, "settled");
  assert.equal(unknown.status, "queued");
  state.options.getConfig = () => ({ ...config, bookingNotificationsEnabled: true, bookingRetentionEnabled: true });
  t.mock.method(AssistantBookingReceipt.collection, "indexes", async () => { throw new Error("Synthetic booking outbox setup outage"); });
  const isolated = await drainAssistantWork(state.options);
  assert.equal(isolated.bookingNotifications.failed, 1); assert.equal(isolated.bookingRetention.failed, 1);
  assert.equal(isolated.failed, 3); assert.equal(state.calls, 1);
  const referenceConfig = referenceTestConfig();
  state.options.getConfig = () => config;
  state.options.getReferenceConfig = () => referenceConfig;
  state.options.getReferenceIndexingConfig = (loaded, shared) => {
    assert.equal(loaded, referenceConfig); assert.equal(shared, config); return { enabled: false };
  };
  t.mock.method(referenceWorker, "start", (loaded, options) => {
    assert.equal(loaded, referenceConfig); assert.equal(options.shared, config); assert.deepEqual(options.indexing, { enabled: false });
    return { enabled: true, scheduled: true };
  });
  const scheduled = await drainAssistantWork(state.options);
  assert.deepEqual(scheduled.references, { enabled: true, scheduled: true }); assert.equal(state.calls, 1);
  const indexingLoader = state.options.getReferenceIndexingConfig;
  state.options.getReferenceIndexingConfig = () => { throw new Error("fictional expired embedding price"); };
  const unpaidRefresh = await drainAssistantWork(state.options);
  assert.deepEqual(unpaidRefresh.references, { enabled: true, scheduled: true }); assert.equal(unpaidRefresh.failed, 2);
  assert.equal(state.calls, 1); state.options.getReferenceIndexingConfig = indexingLoader;
  t.mock.method(referenceWorker, "start", () => { throw new Error("fictional reference configuration failure"); });
  const referenceFailure = await drainAssistantWork(state.options);
  assert.deepEqual(referenceFailure.references, { enabled: true, failed: 1 }); assert.equal(referenceFailure.failed, 2);
  assert.equal(state.calls, 1);
});

test("runtime skips global disable without queries; admin gate closes unpaid work without provider or reservation", async (t) => {
  const state = fixture(t);
  assert.deepEqual(await drainAssistantWork({ getConfig: () => ({ enabled: false }) }), { enabled: false, processed: 0, failed: 0 });
  state.options.getConfig = () => ({ ...config, adminEnabled: false });
  assert.deepEqual(await processBusinessPlan(state.run._id, state.options), { failedBeforeDispatch: true });
  assert.equal(state.run.publicCode, "assistant_business_disabled"); assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0);
  assert.equal(state.account.activeRun, null);
});
