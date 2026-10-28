import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { beginAttempt, queueAnswer, queuedWorkFilter, recordAttempt, validAttemptSequence } from "../../../src/domains/assistant/shared/assistant.attempts.js";
import { AssistantRun, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { bindReferenceQuery, boundReferenceQuery, meaningClarificationReply, normalizationInstructions, normalizationSchema } from "../../../src/domains/assistant/customer/assistant.reference-query.js";
import { buildContextWithKnowledge } from "../../../src/domains/assistant/customer/assistant.context.js";
import { createCustomerReferenceRetrieval } from "../../../src/domains/assistant/customer/assistant.reference-retrieval.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

const run = extra => ({ purpose: "customer", referenceFlowVersion: "focused-v1", phase: "resolve", attempts: [],
  accounting: "none", generation: 0, config: { signature: "original", promptVersion: "historical" }, ...extra });
const dispatch = s => beginAttempt(s, { amount: 100, budgetIds: ["month", "day"] });
const settle = s => { s.accounting = "settled"; s.chargedMicroUsd = 42; recordAttempt(s); };

test("only the admitted focused sequence permits three attempts, with one settlement before each transition", () => {
  const s = run(); dispatch(s); const first = s.attempt; settle(s); queueAnswer(s, "normalize");
  const stale = { ...s };
  dispatch(s); const second = s.attempt;
  assert.throws(() => queueAnswer(s), { code: "assistant_attempt_limit" });
  settle(s); queueAnswer(s); assert.equal(matchesQuery(s, queuedWorkFilter(s._id, stale)), false);
  dispatch(s); settle(s);
  assert.equal(new Set([first, second, s.attempt]).size, 3);
  assert.deepEqual(s.attempts.map(a => a.phase), ["resolve", "normalize", "answer"]);
  assert.ok(s.attempts.every(a => a.chargedMicroUsd === 42 && a.accounting === "settled"));
  assert.throws(() => dispatch(s), { code: "assistant_attempt_limit" });
  assert.throws(() => queueAnswer(s, "normalize"), { code: "assistant_attempt_limit" });
  for (const phases of [["normalize"], ["answer"], ["resolve", "normalize", "normalize"], ["resolve", "answer", "answer"]]) {
    assert.equal(validAttemptSequence(s, phases.map(phase => ({ phase }))), false);
  }
});

test("legacy runs retain two calls, and an unresolved charge blocks the next focused dispatch", () => {
  const legacy = run({ referenceFlowVersion: undefined }); dispatch(legacy); settle(legacy);
  assert.throws(() => queueAnswer(legacy, "normalize"), { code: "assistant_attempt_limit" });
  queueAnswer(legacy); dispatch(legacy); settle(legacy);
  assert.throws(() => dispatch(legacy), { code: "assistant_attempt_limit" });
  const current = run(); dispatch(current); settle(current); queueAnswer(current, "normalize");
  current.attempts[0].accounting = "reserved";
  assert.throws(() => dispatch(current), { code: "request_needs_review" });
});

test("skipping an undispatched normalizer leaves no phantom attempt and still caps the answer", () => {
  const s = run(); dispatch(s); settle(s); queueAnswer(s, "normalize"); queueAnswer(s);
  assert.equal(s.attempts.length, 1); assert.equal(s.generation, 2);
  dispatch(s); settle(s);
  assert.deepEqual(s.attempts.map(a => a.phase), ["resolve", "answer"]);
  assert.throws(() => dispatch(s), { code: "assistant_attempt_limit" });
});

test("historical three-attempt records remain valid across prompt versions; other purposes cannot gain the cap", () => {
  const data = { owner: new mongoose.Types.ObjectId(), chat: new mongoose.Types.ObjectId(), key: "fictional", hash: "hash",
    status: "uncertain", contextVersion: 0, input: "care", userSequence: 1,
    ...run({ phase: "answer", attempts: ["resolve", "normalize", "answer"].map(phase => ({ phase, accounting: "settled" })) }) };
  assert.equal(new AssistantRun(data).validateSync(), undefined);
  assert.ok(new AssistantRun({ ...data, referenceFlowVersion: undefined }).validateSync()?.errors.attempts);
  for (const purpose of ["admin_business", "automatic_bundles"]) {
    assert.ok(new AssistantRun({ ...data, purpose }).validateSync());
  }
  const old = AssistantRun.hydrate({ ...data, referenceFlowVersion: undefined, purpose: undefined, attempts: [] });
  assert.equal(old.referenceFlowVersion, undefined); assert.equal(old.purpose, undefined);
  assert.equal(old.validateSync(), undefined);
  assert.equal(AssistantRun.schema.path("referenceFlowVersion").options.immutable, true);
});

test("private wording is also bound to saved configuration and the earliest context expiry", () => {
  const s = run({ phase: "answer", owner: "owner", chat: "chat", userSequence: 1, input: "care", contextVersion: 1,
    subjectId: "pet:cat", subjectFingerprint: "fingerprint" });
  const expires = new Date(Date.now() + 30000);
  bindReferenceQuery(s, { status: "ready", query: "Care question" }, expires);
  assert.equal(boundReferenceQuery(s).query, "Care question");
  assert.throws(() => boundReferenceQuery({ ...s, config: { signature: "changed" } }), { code: "context_changed" });
  assert.throws(() => boundReferenceQuery(s, expires), { code: "context_changed" });
});

test("focused context reuses selection and bounds without answer, action, other-pet or booking instructions", async t => {
  const s = customerChatFixture(t, "anaddaf sandou2 el raml ezay ben kol ghasla wel tanya?");
  Object.assign(s.run, { referenceFlowVersion: "focused-v1", phase: "normalize", catalogContext: { warehouseId: "a".repeat(24) } });
  const other = { id: "pet:other", name: "Other", species: "dog", profile: { chronicConditions: "OTHER_PRIVATE" } };
  const built = await buildContextWithKnowledge(s.run, s.chat, [s.subject, other], s.config, {}, new Date());
  assert.ok(built.request.instructions.startsWith(normalizationInstructions));
  assert.deepEqual(built.request.outputSchema, normalizationSchema); assert.deepEqual(built.request.tools, []);
  assert.equal(built.request.messages.at(-1).content, s.run.input);
  assert.doesNotMatch(built.request.instructions, /OTHER_PRIVATE|bookingDraft|checkoutSummary|productSearch|dietaryWarningAction|memoryKey/);
  assert.ok(Buffer.byteLength(JSON.stringify(built.request)) <= s.config.maxContextBytes);
  await assert.rejects(buildContextWithKnowledge(s.run, s.chat, [s.subject], { ...s.config, maxContextBytes: 10 }, {}), { code: "context_too_large" });
});

test("active reference configuration or authority failures stop rather than silently skipping normalization", async () => {
  for (const phase of ["normalize", "answer"]) {
    const scope = { phase, ...(phase === "answer" ? { referenceQueryState: "ready" } : {}) };
    const broken = createCustomerReferenceRetrieval({ getConfig() { throw Object.assign(new Error("Invalid config"), { code: "bad_configuration" }); } });
    await assert.rejects(broken(scope, { run: run(), config: {} }), { code: "bad_configuration" });
    const off = createCustomerReferenceRetrieval({ getConfig: () => ({ enabled: false }) });
    await assert.rejects(off(scope, { run: run(), config: {} }), { code: "reference_retrieval_unavailable" });
  }
  const retrieve = createCustomerReferenceRetrieval({ getConfig: () => ({ enabled: true }), search: {
    async hasEligibleSources() { throw Object.assign(new Error("Changed context"), { code: "context_changed" }); },
  } });
  await assert.rejects(retrieve({ phase: "normalize" }, { run: run(), config: {} }), { code: "context_changed" });
});

test("short-clarification context preserves the original object/question and the actual safe clarification", async t => {
  const s = customerChatFixture(t, "el nom"), now = new Date();
  Object.assign(s.run, { referenceFlowVersion: "focused-v1", phase: "normalize", userSequence: 3 });
  const common = { owner: s.run.owner, chat: s.run.chat, subjectId: s.run.subjectId,
    createdAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 60000) };
  const history = [{ ...common, sequence: 1, role: "user", text: "anaddaf farshet el kalb ezay?" },
    { ...common, sequence: 2, role: "assistant", text: meaningClarificationReply("ar") },
    { ...common, sequence: 2, role: "assistant", subjectId: "pet:other", text: "OTHER_PET_PRIVATE" }];
  t.mock.method(AssistantMessage, "find", filter => ({ sort() { return this; }, limit() { return this; }, session() { return this; },
    async lean() { return history.filter(row => matchesQuery(row, filter)).slice().reverse(); } }));
  const built = await buildContextWithKnowledge(s.run, s.chat, [s.subject], s.config, {}, now, null, null);
  assert.match(built.request.instructions, /For a short clarification reply, reconstruct the original user question/);
  assert.match(built.request.instructions, /Keep its concrete object and action/);
  assert.ok(built.request.messages[0].content.includes(history[0].text));
  assert.ok(built.request.messages[1].content.includes(meaningClarificationReply("ar")));
  assert.equal(built.request.messages.at(-1).content, "el nom");
  assert.doesNotMatch(JSON.stringify(built.request), /OTHER_PET_PRIVATE|اغسل الغطا/);
  assert.deepEqual(built.request.outputSchema, normalizationSchema);
});
