import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantChat,
  AssistantEvent, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { getBusinessMetadata, getBusinessChat, getBusinessHistory, submitBusinessMessage,
  getBusinessRun } from "../../../src/domains/assistant/admin/assistant.admin-service.js";
import { getMetadata } from "../../../src/domains/assistant/customer/assistant.service.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { metadataDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";

const actor = new mongoose.Types.ObjectId();
const config = testConfig();
const root = { _id: actor, role: "superAdmin", active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed" };
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

function fixtures(t) {
  mockAssistantTransactions(t);
  const state = { user: { ...root }, account: null, chat: null, runs: [], messages: [], events: [], userReads: 0,
    accountSaves: 0, chatSaves: 0, onHistoryRead: null, onUserRead: null };
  const query = (read) => {
    let limit = Infinity;
    const value = () => { const result = read(); return Array.isArray(result) ? result.slice(0, limit) : result; };
    return { select() { return this; }, session() { return this; }, sort() { return this; }, limit(count) { limit = count; return this; },
      maxTimeMS(ms) { assert.equal(ms, 5000); return this; }, async lean() { return value(); },
      then(resolve, reject) { return Promise.resolve().then(value).then(resolve, reject); } };
  };
  const account = () => ({ owner: actor, blocked: false, activeRun: null, dayMessages: 0, rateCount: 0,
    async save() { state.accountSaves++; } });
  state.makeAccount = account;
  t.mock.method(UserModel, "findById", (id) => {
    assert.equal(String(id), String(actor));
    return query(() => { state.userReads++; state.onUserRead?.(state.userReads); return state.user; });
  });
  t.mock.method(AssistantAccount, "findOne", ({ owner }) => { assert.equal(String(owner), String(actor)); return query(() => state.account); });
  t.mock.method(AssistantAccount, "findOneAndUpdate", ({ owner }) => {
    assert.equal(String(owner), String(actor)); state.account ??= account(); return query(() => state.account);
  });
  t.mock.method(AssistantAdminChat, "findOneAndUpdate", ({ owner }) => {
    assert.equal(String(owner), String(actor));
    state.chat ??= { _id: new mongoose.Types.ObjectId(), owner: actor, contextVersion: 0, nextSequence: 0,
      async save() { state.chatSaves++; } };
    return query(() => state.chat);
  });
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => state.runs.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantRun, "create", async ([value]) => {
    const row = { ...value, _id: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date() };
    assert.equal(new AssistantRun(row).validateSync(), undefined); state.runs.push(row); return [row];
  });
  t.mock.method(AssistantAdminMessage, "create", async ([value]) => {
    const row = { ...value, _id: new mongoose.Types.ObjectId(), createdAt: new Date() };
    assert.equal(new AssistantAdminMessage(row).validateSync(), undefined); state.messages.push(row); return [row];
  });
  t.mock.method(AssistantAdminMessage, "find", (filter) => query(() => {
    const rows = state.messages.filter((row) => matchesQuery(row, filter)).sort((a, b) => b.sequence - a.sequence);
    state.onHistoryRead?.(); return rows;
  }));
  t.mock.method(AssistantAdminMessage, "findOne", (filter) => query(() => state.messages.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantEvent, "create", async ([value]) => { state.events.push(value); return [{ _id: new mongoose.Types.ObjectId() }]; });
  for (const [model, methods] of [[AssistantChat, ["findOneAndUpdate"]], [AssistantMessage, ["find", "findOne", "create"]],
    [AssistantBudget, ["updateOne", "findOneAndUpdate"]]]) {
    for (const method of methods) t.mock.method(model, method, () => { throw new Error("Unexpected customer or financial write/read"); });
  }
  return state;
}

test("explicit admin initialization fails closed before writes and can retry without changing customer startup", async (t) => {
  const state = fixtures(t);
  let attempts = 0;
  t.mock.method(AssistantAdminMessage, "createIndexes", async () => { if (++attempts === 1) throw new Error("private index failure"); });
  await rejectsCode(getBusinessChat(actor, config), "assistant_unavailable");
  assert.equal(state.chat, null); assert.equal(state.account, null);
  const chat = await getBusinessChat(actor, config);
  assert.equal(chat.id, String(state.chat._id)); assert.equal(attempts, 2);
  assert.equal((await getBusinessChat(actor, config)).id, chat.id);
  assert.equal(state.runs.length, 0); assert.equal(state.messages.length, 0);
});

test("every admin entry checks current role/account/phone/analytics controls; disabled config never reads identity", async (t) => {
  const state = fixtures(t);
  await rejectsCode(getBusinessMetadata(actor, { enabled: false }), "assistant_disabled"); assert.equal(state.userReads, 0);
  for (const user of [null, { ...root, role: "user" }, { ...root, role: "moderator", enabledControls: ["analytics"] },
    { ...root, role: "admin", enabledControls: ["products"] }, { ...root, role: "admin", enabledControls: "analytics" },
    { ...root, active: false }, { ...root, phoneVerified: false }, { ...root, deletedAt: new Date() },
    { ...root, account_status: "banned" }, { ...root, account_status: "deleted" }]) {
    state.user = user;
    for (const call of [() => getBusinessMetadata(actor, config), () => getBusinessChat(actor, config),
      () => getBusinessHistory(actor, {}, config), () => getBusinessRun(actor, String(new mongoose.Types.ObjectId()), config),
      () => submitBusinessMessage(actor, { text: "hello" }, "request-key", config)]) await rejectsCode(call(), "access_denied");
  }
  state.user = { ...root, role: "admin", enabledControls: ["analytics"] };
  assert.equal((await getBusinessMetadata(actor, config)).available, true);
  assert.equal(state.runs.length, 0); assert.equal(state.chat, null);
});

test("business admission uses separate history, one shared quota/lock, private config and namespaced retry keys", async (t) => {
  const state = fixtures(t);
  const result = await submitBusinessMessage(actor, { text: "  قارن سبتمبر بأغسطس  " }, "same-client-key", config);
  assert.equal(result.duplicate, false); assert.equal(state.runs.length, 1); assert.equal(state.messages.length, 1);
  const run = state.runs[0];
  assert.equal(run.purpose, "admin_business"); assert.equal(run.phase, "plan");
  assert.equal(run.key, "admin-business/same-client-key"); assert.equal(run.input, "قارن سبتمبر بأغسطس");
  assert.equal(String(state.account.activeRun), String(run._id)); assert.equal(state.account.dayMessages, 1);
  assert.equal(state.account.rateCount, 1); assert.equal(state.chat.nextSequence, 1);
  assert.equal(state.accountSaves, 1); assert.equal(state.chatSaves, 1);
  assert.equal(run.config.baseSignature, config.signature); assert.notEqual(run.config.signature, config.signature);
  assert.equal(state.events[0].detail.purpose, "admin_business");
  assert.equal(JSON.stringify(result).includes("signature"), false); assert.equal(Object.hasOwn(result.run, "subjectId"), false);
  const duplicate = await submitBusinessMessage(actor, { text: run.input }, "same-client-key", config);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.id, result.run.id);
  assert.equal(state.runs.length, 1); assert.equal(state.messages.length, 1); assert.equal(state.events.length, 1);
  assert.equal(state.account.dayMessages, 1); assert.equal(state.chat.nextSequence, 1);
  await rejectsCode(submitBusinessMessage(actor, { text: "different" }, "same-client-key", config), "idempotency_conflict");
});

test("customer keys and actor/tool fields cannot override business ownership, purpose or query arguments", async (t) => {
  const state = fixtures(t);
  for (const field of ["owner", "actorId", "chatId", "purpose", "subjectId", "tool", "arguments", "model", "config"]) {
    await rejectsCode(submitBusinessMessage(actor, { text: "hello", [field]: "forged" }, "request-key", config), "invalid_request");
  }
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "admin-business/request-key", config), "idempotency_key_required");
  await rejectsCode(submitBusinessMessage(actor, { text: "x".repeat(config.maxMessageChars + 1) }, "request-key", config), "message_too_long");
  await rejectsCode(getBusinessMetadata("bad-id", config), "invalid_identifier");
  assert.equal(state.runs.length, 0); assert.equal(state.userReads, 0);
  state.runs.push({ _id: new mongoose.Types.ObjectId(), owner: actor, key: "same-client-key", purpose: "customer" });
  await submitBusinessMessage(actor, { text: "business" }, "same-client-key", config);
  assert.equal(state.runs.length, 2); assert.equal(state.runs[1].key, "admin-business/same-client-key");
});

test("business admission cannot bypass a customer active lock, shared daily quota or shared rate limit", async (t) => {
  const state = fixtures(t);
  state.account = state.makeAccount(); state.account.activeRun = new mongoose.Types.ObjectId();
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "active-request", config), "active_request");
  state.account.activeRun = null; state.account.day = periods(config).day; state.account.dayMessages = config.dailyMessageLimit;
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "daily-request", config), "daily_message_limit");
  state.account.dayMessages = 0; state.account.rateStart = new Date(); state.account.rateCount = config.rateMax;
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "rate-request", config), "request_rate_limit");
  assert.equal(state.runs.length, 0); assert.equal(state.messages.length, 0); assert.equal(state.accountSaves, 0);
});

test("blocked history policy allows retained reads but never a new message; metadata remains restricted", async (t) => {
  const state = fixtures(t);
  const original = await submitBusinessMessage(actor, { text: "hello" }, "existing-request", config);
  state.account.blocked = true;
  assert.equal((await getBusinessMetadata(actor, config)).state, "restricted");
  await rejectsCode(getBusinessChat(actor, config), "ai_restricted");
  await rejectsCode(getBusinessHistory(actor, {}, config), "ai_restricted");
  const allowed = testConfig({ blockedHistoryAllowed: true });
  assert.deepEqual((await getBusinessHistory(actor, {}, allowed)).messages.map((row) => row.text), ["hello"]);
  await getBusinessChat(actor, allowed);
  const duplicate = await submitBusinessMessage(actor, { text: "hello" }, "existing-request", allowed);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.id, original.run.id);
  assert.equal(state.account.dayMessages, 1); assert.equal(state.messages.length, 1);
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "blocked-request", allowed), "ai_restricted");
  assert.equal(state.runs.length, 1);
});

test("private paginated history omits expired/other-owner records and revocation prevents release", async (t) => {
  const state = fixtures(t);
  const message = (sequence, extras = {}) => ({ _id: new mongoose.Types.ObjectId(), owner: actor, run: new mongoose.Types.ObjectId(),
    chat: new mongoose.Types.ObjectId(), role: "user", text: `Business ${sequence}`, sequence, createdAt: new Date(), expiresAt: new Date("2100-01-01"), ...extras });
  state.messages.push(message(1), message(2), message(3), message(4, { expiresAt: new Date(0) }), message(5, { owner: new mongoose.Types.ObjectId() }));
  const first = await getBusinessHistory(actor, { limit: "2" }, config);
  assert.deepEqual(first.messages.map((row) => row.sequence), [3, 2]); assert.equal(first.nextBefore, 2);
  assert.equal(Object.hasOwn(first.messages[0], "owner"), false); assert.equal(Object.hasOwn(first.messages[0], "subjectId"), false);
  assert.deepEqual((await getBusinessHistory(actor, { before: String(first.nextBefore), limit: "2" }, config)).messages.map((row) => row.sequence), [1]);
  state.onHistoryRead = () => { state.user = { ...root, role: "user" }; };
  await rejectsCode(getBusinessHistory(actor, {}, config), "access_denied");
});

test("business run reads are owner/purpose bound and response messages must belong to that same run/chat", async (t) => {
  const state = fixtures(t);
  const result = await submitBusinessMessage(actor, { text: "hello" }, "read-request", config);
  const row = state.runs[0];
  assert.equal((await getBusinessRun(actor, result.run.id, config)).run.id, result.run.id);
  row.responseMessage = new mongoose.Types.ObjectId();
  state.messages.push({ _id: row.responseMessage, owner: actor, chat: new mongoose.Types.ObjectId(), run: row._id,
    role: "assistant", sequence: 2, text: "Wrong chat", expiresAt: new Date("2100-01-01") });
  assert.equal((await getBusinessRun(actor, result.run.id, config)).message, null);
  state.messages.at(-1).chat = row.chat;
  assert.equal((await getBusinessRun(actor, result.run.id, config)).message.text, "Wrong chat");
  row.purpose = "customer"; await rejectsCode(getBusinessRun(actor, result.run.id, config), "run_not_found");
  row.purpose = "admin_business"; row.owner = new mongoose.Types.ObjectId();
  await rejectsCode(getBusinessRun(actor, result.run.id, config), "run_not_found");
});

test("customer and business metadata expose only their own run IDs but retain the same shared allowance", async (t) => {
  const state = fixtures(t); state.account = state.makeAccount();
  state.account.day = periods(config).day; state.account.dayMessages = 3;
  const row = { _id: new mongoose.Types.ObjectId(), owner: actor, purpose: "admin_business" }; state.runs.push(row);
  state.account.activeRun = row._id;
  const customer = await getMetadata(actor, config); const business = await getBusinessMetadata(actor, config);
  assert.equal(customer.activeRunId, null); assert.equal(business.activeRunId, String(row._id));
  assert.deepEqual(customer.limits, business.limits); assert.equal(customer.limits.remainingMessages, config.dailyMessageLimit - 3);
  row.purpose = "customer";
  assert.deepEqual(await getMetadata(actor, config), metadataDto(config, state.account, periods(config)));
  assert.equal((await getBusinessMetadata(actor, config)).activeRunId, null);
  delete row.purpose; assert.equal((await getMetadata(actor, config)).activeRunId, String(row._id));
  row.owner = new mongoose.Types.ObjectId(); assert.equal((await getMetadata(actor, config)).activeRunId, null);
});

test("transaction admission rechecks authority before writing and read failures never leak internal details", async (t) => {
  const state = fixtures(t);
  state.onUserRead = (count) => { if (count === 2) state.user = { ...root, role: "user" }; };
  await rejectsCode(submitBusinessMessage(actor, { text: "hello" }, "revoked-request", config), "access_denied");
  assert.equal(state.runs.length, 0); assert.equal(state.messages.length, 0);
  state.user = { ...root }; state.onUserRead = null;
  t.mock.method(AssistantAdminMessage, "find", () => { throw new Error("OpenAI private database credentials"); });
  await assert.rejects(getBusinessHistory(actor, {}, config), (error) =>
    error.code === "assistant_unavailable" && error.status === 503 && !error.message.includes("credentials"));
});

test("admin feature/cap gates block new admissions but keep identical retry recovery and retained reads available", async (t) => {
  const state = fixtures(t);
  const first = await submitBusinessMessage(actor, { text: "hello" }, "gate-original-key", config);
  for (const [changed, code] of [[{ ...config, adminEnabled: false }, "assistant_business_disabled"],
    [{ ...config, adminReportMaxBytes: null }, "admin_report_configuration_required"]]) {
    assert.equal((await getBusinessMetadata(actor, changed)).state, "unavailable");
    assert.equal((await submitBusinessMessage(actor, { text: "hello" }, "gate-original-key", changed)).run.id, first.run.id);
    await rejectsCode(submitBusinessMessage(actor, { text: "new" }, "gate-new-key", changed), code);
    assert.equal((await getBusinessHistory(actor, {}, changed)).messages.length, 1);
    assert.equal(state.account.dayMessages, 1); assert.equal(state.runs.length, 1);
  }
});
