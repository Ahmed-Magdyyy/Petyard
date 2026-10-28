import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveSubjectDecision, subjectClarification } from "../../../src/domains/assistant/customer/assistant.subjects.js";
import { beginAttempt, queuedWorkFilter, queueAnswer, recordAttempt } from "../../../src/domains/assistant/shared/assistant.attempts.js";
import { subjectFingerprint, buildContext } from "../../../src/domains/assistant/customer/assistant.context.js";
import { validateResult, outputSchema } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { settleCost } from "../../../src/domains/assistant/shared/assistant.store.js";
import { AssistantBudget, AssistantDietaryWarning, AssistantMemory, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";
import { testConfig, structuredReply, knownUsage } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

const config = testConfig();
const pets = [
  { id: "pet:111111111111111111111111", name: "Milo", species: "cat", saved: true, profile: { chronicConditions: ["Milo-only-condition"] } },
  { id: "pet:222222222222222222222222", name: "Roy", species: "dog", saved: true, profile: { breed: "Roy-only-breed" } },
  { id: "chat:12345678-1234-1234-1234-123456789012", name: null, species: null, saved: false, expiresAt: new Date("2100-01-01") },
];
const fingerprints = Object.fromEntries(pets.map((pet) => [pet.id, subjectFingerprint(pet)]));
const run = (extras = {}) => ({ _id: "run", owner: "owner", chat: "chat", input: "What about Roy?", subjectId: pets[0].id,
  subjectExplicit: false, phase: "resolve", generation: 0, contextVersion: 1, subjectFingerprint: fingerprints[pets[0].id], userSequence: 1, config, attempts: [], ...extras });
const decide = (data, current = run(), subjects = pets, snapshot = fingerprints) => resolveSubjectDecision(structuredReply(data), current, subjects, snapshot, config);

test("structured subject decisions keep ordinary context, select owned pets, clarify ambiguity and honor explicit overrides", () => {
  assert.deepEqual(decide({}), { kind: "publish" });
  assert.equal(decide({ subjectAction: "select", resolvedSubjectId: pets[1].id }).kind, "change");
  assert.equal(decide({ subjectAction: "select", resolvedSubjectId: pets[1].id }, run({ subjectExplicit: true })).kind, "clarify");
  assert.equal(decide({ subjectAction: "create_unsaved" }, run({ subjectId: null, subjectExplicit: true })).kind, "clarify");
  assert.equal(decide({ subjectAction: "clarify" }, run({ subjectId: null })).kind, "clarify");
  assert.throws(() => decide({ subjectAction: "select", resolvedSubjectId: "pet:333333333333333333333333" }), { code: "subject_not_found" });
  assert.throws(() => decide({ resolvedSubjectId: pets[1].id }), { code: "invalid_subject_decision" });
  assert.throws(() => decide({ subjectAction: "select", resolvedSubjectId: pets[1].id }, run(),
    pets.map((pet) => pet.id === pets[1].id ? { ...pet, species: "changed" } : pet)), { code: "context_changed" });
  assert.match(subjectClarification("ar"), /تقصد/);
  assert.match(subjectClarification("arabizi"), /تقصد/);
});

test("anonymous pet identity stays unknown until exact sourced facts update its existing ID; saved profiles cannot be edited", () => {
  const anonymous = decide({ subjectAction: "create_unsaved" });
  assert.equal(anonymous.create, true); assert.equal(anonymous.facts.name, null); assert.equal(anonymous.facts.species, null);
  const current = run({ subjectId: pets[2].id, input: "His name is Bebo and he is a dog." });
  const update = decide({ subjectAction: "update_unsaved", resolvedSubjectId: pets[2].id,
    subjectName: "Bebo", subjectNameQuote: "His name is Bebo", subjectSpecies: "dog", subjectSpeciesQuote: "he is a dog" }, current);
  assert.equal(update.targetId, pets[2].id); assert.equal(update.create, false);
  assert.equal(update.facts.name.value, "Bebo"); assert.equal(update.facts.species.value, "dog");
  assert.equal(decide({}, current).kind, "publish", "short follow-up keeps the anonymous subject rather than creating another");
  assert.throws(() => decide({ subjectAction: "update_unsaved", resolvedSubjectId: pets[0].id,
    subjectName: "Bebo", subjectNameQuote: "Bebo" }, current), { code: "invalid_subject_decision" });
  assert.throws(() => decide({ subjectAction: "create_unsaved", subjectSpecies: "cat", subjectSpeciesQuote: "he is a dog" }, current), { code: "invalid_subject_decision" });
  assert.throws(() => decide({ subjectAction: "create_unsaved", subjectName: "Guessed", subjectNameQuote: "Guessed" }, current), { code: "invalid_subject_decision" });
});

test("answer phase cannot switch or refine again; urgent guidance does not wait for pet resolution or persist facts", () => {
  const second = run({ phase: "answer", subjectId: pets[1].id });
  assert.equal(decide({ subjectAction: "select", resolvedSubjectId: pets[0].id }, second).kind, "clarify");
  assert.equal(decide({ subjectAction: "create_unsaved" }, second).kind, "clarify");
  assert.throws(() => decide({ subjectAction: "select", resolvedSubjectId: "foreign-id" }, second), { code: "subject_not_found" });
  const data = structuredReply({ scope: "urgent", subjectAction: "create_unsaved", subjectName: "Invented", subjectNameQuote: "invalid" });
  assert.deepEqual(resolveSubjectDecision(data, second, pets, fingerprints, config), { kind: "urgent" });
  const result = validateResult({ finishReason: "completed", toolCalls: [], structured: data }, second, config, pets.map((pet) => pet.id));
  assert.match(result.reply, /immediate veterinary/); assert.equal(result.memory, null);
});

test("per-attempt financial records retain first settlement, original periods and unknown second exposure without another allowance or third call", async (t) => {
  const updates = [];
  t.mock.method(AssistantBudget, "updateOne", async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; });
  const current = run();
  const firstReservation = { amount: 1000, budgetIds: ["old-month", "old-day"] };
  beginAttempt(current, firstReservation);
  const firstId = current.attempt;
  assert.equal(await settleCost(current, knownUsage, null), true);
  recordAttempt(current);
  const firstCharge = current.chargedMicroUsd;
  assert.equal(await settleCost(current, knownUsage, null), false, "settlement is not applied twice");
  current.publicCode = "request_needs_review"; current.retryAt = new Date(); current.internalCode = "worker_dispatch_interrupted";
  queueAnswer(current);
  assert.equal(current.publicCode, null); assert.equal(current.retryAt, null); assert.equal(current.internalCode, null);
  assert.equal(current.attempts[0].id, firstId); assert.equal(current.attempts[0].chargedMicroUsd, firstCharge);
  beginAttempt(current, { amount: 2000, budgetIds: ["new-month", "new-day"] });
  assert.equal(current.attempts.length, 2);
  assert.equal(await settleCost(current, null, null), false, "unknown usage never releases the second reservation");
  assert.throws(() => beginAttempt(current, firstReservation), { code: "assistant_attempt_limit" });
  assert.throws(() => queueAnswer(current), { code: "assistant_attempt_limit" });
  assert.equal(current.attempts[0].accounting, "settled"); assert.equal(current.attempts[1].accounting, "reserved");
  await settleCost(current, null, null, { chargeReservation: true }); recordAttempt(current);
  assert.equal(current.attempts[1].accounting, "charged_reservation");
  assert.equal(current.attempts[0].chargedMicroUsd, firstCharge);
  assert.deepEqual(updates.map((item) => item.filter._id), ["old-month", "old-day", "new-month", "new-day"]);
});

test("stale first-phase retrieval and preparation failure cannot match a newer queued answer generation", () => {
  const current = run({ status: "queued" });
  const staleWorker = structuredClone(current);
  const matches = (filter) => matchesQuery(current, filter);
  const stalePreparation = queuedWorkFilter(current._id, staleWorker);
  assert.equal(matches(stalePreparation), true);
  beginAttempt(current, { amount: 1000, budgetIds: ["period"] });
  current.accounting = "settled"; recordAttempt(current);
  current.contextVersion += 1; current.subjectId = pets[1].id;
  queueAnswer(current);
  assert.equal(matches(stalePreparation), false, "stale preparation sees no eligible job");
  const staleFailureWrite = queuedWorkFilter(current._id, staleWorker);
  if (matches(staleFailureWrite)) current.status = "failed";
  assert.equal(current.status, "queued"); assert.equal(current.phase, "answer"); assert.equal(current.generation, 1);
  assert.equal(matches(queuedWorkFilter(current._id, current)), true);
});

test("scripted Egyptian Arabic, Arabizi and English decisions travel through actual local provider HTTP; reloaded context contains only the resolved profile", async (t) => {
  const emptyQuery = () => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, async lean() { return []; } });
  t.mock.method(AssistantMemory, "find", emptyQuery); t.mock.method(AssistantMessage, "find", emptyQuery);
  t.mock.method(AssistantDietaryWarning, "find", emptyQuery);
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.end(JSON.stringify({ model: "gpt-6-luna", status: "completed", service_tier: "default",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(structuredReply({ reply: "",
        subjectAction: "select", resolvedSubjectId: pets[1].id })) }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const adapter = createOpenAIResponsesAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/v1/responses` });
  for (const input of ["طب وروي؟", "tayeb w Roy?", "What about Roy?"]) {
    const current = run({ input });
    const request = await buildContext(current, { contextVersion: 1, contextAfterSequence: 0 }, pets, config, null);
    const response = await adapter.generate(request);
    assert.equal(response.structured.subjectAction, "select");
    assert.equal(resolveSubjectDecision(response.structured, current, pets, fingerprints, config).kind, "change");
  }
  assert.deepEqual(received[0].text.format.schema, outputSchema);
  assert.match(received[0].instructions, /Milo-only-condition/); assert.doesNotMatch(received[0].instructions, /Roy-only-breed/);
  const second = await buildContext(run({ phase: "answer", subjectId: pets[1].id }), { contextVersion: 2, contextAfterSequence: 0 }, pets, config, null);
  assert.match(second.instructions, /Roy-only-breed/); assert.doesNotMatch(second.instructions, /Milo-only-condition/);
  assert.match(second.instructions, /"resolutionPhase":"answer"/);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= config.maxContextBytes);
});
