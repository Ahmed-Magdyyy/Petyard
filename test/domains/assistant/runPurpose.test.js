import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantChat, AssistantEvent,
  AssistantMemory, AssistantMessage, AssistantRun, assistantModels } from "../../../src/domains/assistant/shared/assistant.models.js";
import { customerRunFilter, isCustomerRun, runPurposes } from "../../../src/domains/assistant/shared/assistant.purpose.js";
import { beginAttempt, queuedWorkFilter, queueAnswer } from "../../../src/domains/assistant/shared/assistant.attempts.js";
import { prepareRun, failPreparation, finishRun, knowledgeForRun, processAssistantRun, recoverAssistantRuns,
  drainAssistantRuns } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { getHistory, getRun, submitMessage } from "../../../src/domains/assistant/customer/assistant.service.js";
import { runDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { submission } from "../../../src/domains/assistant/shared/assistant.validation.js";
import { outputSchema } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { knownUsage, testConfig } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { mockAssistantTransactions as mockTransactions } from "./fixtures/mockAssistantTransactions.js";

const owner = new mongoose.Types.ObjectId();
const chatId = new mongoose.Types.ObjectId();
const config = testConfig();
const query = (value) => ({ session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; },
  async lean() { return value; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function run(extras = {}) {
  return { _id: new mongoose.Types.ObjectId(), owner, chat: chatId, status: "queued", key: "customer-key", hash: "hash",
    contextVersion: 0, generation: 0, phase: "resolve", subjectId: null, subjectExplicit: false, input: "hello",
    userSequence: 1, createdAt: new Date(), deadline: new Date("2100-01-01"), config, attempts: [], accounting: "none",
    async save() {}, toObject() { return { ...this }; }, ...extras };
}

test("purpose queries admit only explicit or legacy customers and preserve every supplied condition", () => {
  for (const purpose of [undefined, "customer", "admin_business", null, "unknown"]) {
    const row = run(purpose === undefined ? {} : { purpose });
    assert.equal(isCustomerRun(row), purpose === undefined || purpose === "customer");
    const filter = { _id: row._id, status: "queued", $or: [{ generation: 0 }, { generation: 2 }] };
    const original = { ...filter };
    assert.equal(matchesQuery(row, customerRunFilter(filter)), isCustomerRun(row));
    assert.deepEqual(filter, original);
    assert.equal(matchesQuery({ ...row, status: "completed" }, customerRunFilter(filter)), false);
    assert.equal(matchesQuery({ ...row, generation: 3 }, customerRunFilter(filter)), false);
  }
  assert.equal(isCustomerRun(null), false);
  const current = run({ purpose: "admin_business" });
  assert.equal(matchesQuery(current, queuedWorkFilter(current._id, current)), false);
  assert.throws(() => beginAttempt(current, {}), { code: "run_not_found" });
  assert.throws(() => queueAnswer(current), { code: "run_not_found" });
});

test("private admin storage has separate strict collections and indexes without changing customer startup or shared ledgers", () => {
  assert.notEqual(AssistantAdminChat.collection.name, AssistantChat.collection.name);
  assert.notEqual(AssistantAdminMessage.collection.name, AssistantMessage.collection.name);
  assert.deepEqual(AssistantAdminChat.schema.indexes()[0], [{ owner: 1 }, { unique: true }]);
  assert.deepEqual(AssistantAdminMessage.schema.indexes(), AssistantMessage.schema.indexes());
  assert.deepEqual(AssistantMessage.schema.indexes(), [[{ chat: 1, sequence: 1 }, { unique: true }],
    [{ owner: 1, sequence: -1 }, {}], [{ run: 1, role: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]);
  for (const model of [AssistantAdminChat, AssistantAdminMessage]) {
    assert.equal(model.schema.options.strict, "throw");
    assert.equal(model.schema.options.autoCreate, false); assert.equal(model.schema.options.autoIndex, false);
    assert.equal(model.schema.options.bufferCommands, false);
    assert.equal(Object.values(assistantModels).includes(model), false, "Customer startup does not initialize future admin storage");
  }
  const message = { owner, chat: chatId, run: new mongoose.Types.ObjectId(), sequence: 1, role: "user", text: "Business question", expiresAt: new Date("2100-01-01") };
  assert.equal(new AssistantAdminMessage(message).validateSync(), undefined);
  assert.ok(new AssistantAdminMessage({ ...message, owner: null }).validateSync());
  assert.throws(() => new AssistantAdminMessage({ ...message, subjectId: "pet:private" }), { name: "StrictModeError" });
  assert.throws(() => new AssistantAdminChat({ owner, activeSubject: "pet:private" }), { name: "StrictModeError" });
  const { save, toObject, ...storedRun } = run();
  assert.equal(new AssistantRun(storedRun).purpose, runPurposes.customer);
  const legacy = AssistantRun.hydrate(storedRun);
  assert.equal(isCustomerRun(legacy), true);
  assert.equal(legacy.validateSync(), undefined, "Existing runs without purpose remain saveable without backfill");
  assert.equal(AssistantRun.hydrate({ ...storedRun, purpose: "customer" }).validateSync(), undefined);
  assert.equal(AssistantRun.hydrate({ ...storedRun, purpose: "admin_business" }).validateSync(), undefined);
  assert.equal(new AssistantRun({ ...storedRun, purpose: "admin_business" }).validateSync(), undefined);
  assert.ok(new AssistantRun({ ...storedRun, purpose: null }).validateSync());
  assert.ok(new AssistantRun({ ...storedRun, purpose: "unknown" }).validateSync());
  assert.equal(AssistantRun.schema.path("purpose").options.immutable, true);
  assert.deepEqual(AssistantRun.schema.indexes()[0], [{ owner: 1, key: 1 }, { unique: true }]);
});

test("customer processing, retrieval, failure and finish entry points ignore admin snapshots without provider or account work", async (t) => {
  const value = run({ purpose: "admin_business" });
  let calls = 0;
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(value, filter) ? value : null));
  t.mock.method(AssistantAccount, "findOne", () => { throw new Error("Must not read account"); });
  t.mock.method(AssistantBudget, "updateOne", () => { throw new Error("Must not alter budget"); });
  assert.deepEqual(await processAssistantRun(value._id, { getConfig: () => config, adapterFactory: () => { calls++; } }), { skipped: true });
  assert.equal(await knowledgeForRun(value._id, config, async () => { calls++; }), null);
  assert.equal(await knowledgeForRun(value._id, config, async () => { calls++; }, value), null);
  assert.equal(await finishRun({ run: value }, null, null), null);
  await failPreparation(value._id, new Error("not ours"), value);
  assert.equal(value.status, "queued"); assert.equal(value.accounting, "none"); assert.equal(calls, 0);
});

test("fresh transactional filters prevent preparing, failing or settling an admin run even with a customer snapshot", async (t) => {
  mockTransactions(t);
  const value = run({ purpose: "admin_business" });
  const customerSnapshot = { ...value, purpose: "customer" };
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(value, filter) ? value : null));
  t.mock.method(AssistantBudget, "updateOne", () => { throw new Error("Must not settle or reserve"); });
  t.mock.method(AssistantAccount, "findOneAndUpdate", () => { throw new Error("Must not create customer state"); });
  assert.equal(await prepareRun(value._id, config), null);
  assert.equal(await prepareRun(value._id, config, customerSnapshot), null);
  await failPreparation(value._id, new Error("not ours"), customerSnapshot);
  assert.equal(value.status, "queued"); assert.equal(value.accounting, "none");
  Object.assign(value, { status: "dispatching", attempt: "paid-attempt", accounting: "reserved",
    reservation: { amount: 100, budgetIds: ["global", "user"] } });
  Object.assign(customerSnapshot, { status: value.status, attempt: value.attempt, accounting: value.accounting });
  assert.equal(await finishRun({ run: customerSnapshot }, { usage: knownUsage }, null), null);
  assert.equal(value.status, "dispatching"); assert.equal(value.accounting, "reserved");
});

test("a stale customer snapshot cannot retrieve evidence for a run currently marked as business", async (t) => {
  const value = run({ purpose: "admin_business" });
  const snapshot = { ...value, purpose: "customer" };
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(value, filter) ? value : null));
  t.mock.method(AssistantAccount, "findOne", () => query({ activeRun: value._id, blocked: false }));
  t.mock.method(UserModel, "findById", () => query({ active: true, phoneVerified: true }));
  t.mock.method(AssistantChat, "findById", () => query({ contextVersion: value.contextVersion }));
  await assert.rejects(knowledgeForRun(value._id, config, async () => { throw new Error("Must not retrieve"); }, snapshot),
    { code: "context_changed" });
});

test("legacy and explicit customer preparation still reserves one attempt and builds the unchanged customer request", async (t) => {
  mockTransactions(t);
  let current;
  const chat = { _id: chatId, owner, contextVersion: 0, contextAfterSequence: 0, nextSequence: 1, activeSubject: null, subjects: [] };
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(current, filter) ? current : null));
  t.mock.method(AssistantAccount, "findOneAndUpdate", () => query({ owner, activeRun: current._id, blocked: false }));
  t.mock.method(AssistantChat, "findOneAndUpdate", () => query(chat));
  t.mock.method(UserModel, "findById", () => query({ active: true, phoneVerified: true }));
  t.mock.method(PetModel, "find", () => query([]));
  t.mock.method(AssistantMemory, "find", () => query([])); t.mock.method(AssistantMessage, "find", () => query([]));
  t.mock.method(AssistantMessage, "findOne", filter => {
    const source = { owner: current.owner, chat: current.chat, run: current._id, role: "user", sequence: current.userSequence,
      text: current.input, subjectId: current.subjectId, expiresAt: new Date("2100-01-01") };
    assert.ok(matchesQuery(source, filter)); return query(source);
  });
  t.mock.method(AssistantBudget, "findOneAndUpdate", () => query({ frozen: false, billingTimezone: config.timezone, openingExposure: config.openingExposure }));
  let reservations = 0;
  t.mock.method(AssistantBudget, "updateOne", async (_filter, update) => { if (update.$inc) reservations++; return { modifiedCount: 1 }; });
  t.mock.method(AssistantEvent, "create", async () => [{ _id: new mongoose.Types.ObjectId() }]);
  for (const extras of [{}, { purpose: "customer" }]) {
    current = run(extras);
    const prepared = await prepareRun(current._id, config);
    assert.equal(current.status, "dispatching"); assert.equal(current.attempts.length, 1);
    assert.equal(current.accounting, "reserved"); assert.deepEqual(prepared.request.outputSchema, outputSchema);
    assert.deepEqual(prepared.request.tools, []); assert.equal(prepared.allowedSubjects[0], "user");
  }
  assert.equal(reservations, 4, "One global and one user reservation per customer attempt");
});

test("recovery updates only expired legacy/customer attempts and never touches admin exposure", async (t) => {
  mockTransactions(t);
  const rows = [{}, { purpose: "customer" }, { purpose: "admin_business" }, { purpose: null }, { purpose: "unknown" }].map((extras) =>
    run({ ...extras, status: "dispatching", dispatchDeadline: new Date(0), attempt: "attempt", accounting: "reserved", attempts: [{ id: "attempt" }] }));
  const events = [];
  t.mock.method(AssistantRun, "find", (filter) => query(rows.filter((value) => matchesQuery(value, filter))));
  t.mock.method(AssistantRun, "findOne", (filter) => query(rows.find((value) => matchesQuery(value, filter)) ?? null));
  t.mock.method(AssistantMemory, "updateMany", async () => {});
  t.mock.method(AssistantEvent, "create", async ([event]) => { events.push(event); return [{ _id: new mongoose.Types.ObjectId() }]; });
  t.mock.method(AssistantBudget, "updateOne", () => { throw new Error("Recovery must not release exposure"); });
  assert.equal(await recoverAssistantRuns(config), 2);
  assert.deepEqual(rows.map((value) => value.status), ["uncertain", "uncertain", "dispatching", "dispatching", "dispatching"]);
  assert.ok(rows.every((value) => value.accounting === "reserved")); assert.equal(events.length, 2);
});

test("recovery rechecks purpose inside the transaction after selecting a candidate", async (t) => {
  mockTransactions(t);
  const value = run({ status: "dispatching", dispatchDeadline: new Date(0) });
  t.mock.method(AssistantRun, "find", (filter) => {
    const rows = matchesQuery(value, filter) ? [{ _id: value._id }] : [];
    value.purpose = "admin_business";
    return query(rows);
  });
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(value, filter) ? value : null));
  t.mock.method(AssistantMemory, "updateMany", async () => {});
  t.mock.method(AssistantEvent, "create", () => { throw new Error("Must not write admin event"); });
  assert.equal(await recoverAssistantRuns(config), 1); assert.equal(value.status, "dispatching");
});

test("customer drain selects only customer candidates; already-claimed work does not dispatch", async (t) => {
  const rows = [run(), run({ purpose: "customer" }), run({ purpose: "admin_business" })];
  const claimed = [];
  t.mock.method(AssistantRun, "find", (filter) => query(rows.filter((value) => matchesQuery(value, filter))));
  t.mock.method(AssistantRun, "findOne", (filter) => {
    const matching = rows.filter((value) => matchesQuery(value, filter));
    claimed.push(...matching.map((value) => value._id)); return query(null);
  });
  t.mock.method(AssistantMemory, "updateMany", async () => {});
  const result = await drainAssistantRuns({ getConfig: () => config, adapterFactory: () => { throw new Error("Must not dispatch"); } });
  assert.deepEqual(result, { enabled: true, processed: 2 }); assert.deepEqual(claimed, rows.slice(0, 2).map((value) => value._id));
});

test("customer run reads hide business/unknown purposes and other owners while preserving legacy DTOs", async (t) => {
  let current;
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(current, filter) ? current : null));
  t.mock.method(AssistantAccount, "findOne", () => query(null));
  for (const extras of [{}, { purpose: "customer" }]) {
    current = run(extras);
    assert.deepEqual(await getRun(owner, String(current._id), config), { run: runDto(current), message: null });
    assert.equal(Object.hasOwn(runDto(current), "purpose"), false);
  }
  for (const extras of [{ purpose: "admin_business" }, { purpose: null }, { purpose: "unknown" }, { owner: new mongoose.Types.ObjectId() }]) {
    current = run(extras);
    await assert.rejects(getRun(owner, String(current._id), config), { code: "run_not_found" });
  }
});

test("customer history and duplicate submission retain old collection, key and hash behavior", async (t) => {
  mockTransactions(t);
  const key = "old-customer-key"; const input = "hello";
  let current;
  t.mock.method(AssistantRun, "findOne", (filter) => query(matchesQuery(current, filter) ? current : null));
  t.mock.method(AssistantAccount, "findOne", () => query(null));
  t.mock.method(AssistantAdminMessage, "find", () => { throw new Error("Customer history cannot query admin messages"); });
  t.mock.method(AssistantMessage, "find", () => query([{ _id: new mongoose.Types.ObjectId(), run: new mongoose.Types.ObjectId(),
    sequence: 1, role: "user", text: "Customer message", createdAt: new Date(), expiresAt: new Date("2100-01-01") }]));
  assert.equal((await getHistory(owner, {}, config)).messages[0].text, "Customer message");
  for (const extras of [{}, { purpose: "customer" }]) {
    current = run({ ...extras, key, hash: createHash("sha256").update(JSON.stringify({ text: input, subjectId: "auto" })).digest("hex") });
    const result = await submitMessage(owner, { text: input }, key, config);
    assert.equal(result.duplicate, true); assert.deepEqual(result.run, runDto(current));
    await assert.rejects(submitMessage(owner, { text: "different" }, key, config), { code: "idempotency_conflict" });
  }
  assert.throws(() => submission({ text: input, purpose: "admin_business" }, key, config), { code: "invalid_request" });
  assert.throws(() => submission({ text: input }, "admin-business/client-key", config), { code: "idempotency_key_required" });
});
