import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { buildContextWithKnowledge, subjectFingerprint } from "../../../src/domains/assistant/customer/assistant.context.js";
import { loadAssistantConfig, reservationMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { testConfig, testPolicy } from "./fixtures/foundationPolicy.js";

const input = "TESt: Give one short general cat-care tip in English. Do not add to cart, create orders, or book services.";
function fixture(t, text = input) {
  const s = customerChatFixture(t, text);
  s.subject.profile = { breed: "Domestic shorthair", gender: "Female", birthDate: new Date("2020-01-01T00:00:00Z"),
    chronicConditions: [], temporaryIssues: [] };
  const config = { ...testConfig({ maxContextBytes: 32768, maxMessageChars: 2000, maxOutputTokens: 1024,
    productSearchEnabled: true, catalogSemanticEnabled: true, catalogSemanticMinimumScore: 0.2,
    cartPolicy: { version: "context-budget-test", proposalSeconds: 600, rateMax: 10, rateWindowSeconds: 60 } }),
    cartEnabled: true, bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true };
  const subjects = [s.subject, ...Array.from({ length: 3 }, (_, index) => ({ id: `pet:${new mongoose.Types.ObjectId()}`,
    name: `Other pet ${index + 1}`, species: "cat", saved: true }))];
  const run = { ...s.run, config, subjectExplicit: true, referenceFlowVersion: "focused-v1", phase: "resolve", generation: 0,
    catalogContext: { warehouseId: String(new mongoose.Types.ObjectId()), language: "en" } };
  const batch = { ownerId: String(run.owner), runId: String(run._id), subjectId: run.subjectId,
    contextVersion: s.chat.contextVersion, referenceFlowVersion: run.referenceFlowVersion, generation: 0, phase: "resolve",
    profileFingerprint: subjectFingerprint(s.subject), passages: [], prepareQuery: true };
  const build = (current = config, knowledge = batch) => buildContextWithKnowledge(run, s.chat, subjects, current, {}, new Date(), knowledge, null);
  return { ...s, config, run, subjects, batch, build };
}

test("the reported short request with four pets and all features exceeds the old cap but fits the bounded complete-feature policy", async t => {
  const s = fixture(t);
  for (const knowledge of [null, s.batch]) {
    await assert.rejects(s.build({ ...s.config, maxContextBytes: 18000 }, knowledge), { code: "context_too_large" });
    const { request } = await s.build(s.config, knowledge);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) > 18000);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= s.config.maxContextBytes);
    assert.equal(request.messages.at(-1).content, input);
    assert.equal(request.tools.length, 0);
    assert.equal(request.outputSchema.properties.answer !== undefined, knowledge !== null);
    assert.equal(request.instructions.includes('"productSearchAvailable":true'), true);
    assert.equal(request.instructions.includes('"checkoutSummaryAvailable":true'), true);
    assert.equal(request.instructions.includes('"bookingOptionsAvailable":true'), true);
  }
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.budgetUpdates, []);
});

test("the full-feature reference answer fits a maximum-length multilingual input and retains all supplied cautions", async t => {
  const s = fixture(t, "ا".repeat(2000));
  s.warnings.push({ _id: "a".repeat(24), owner: s.run.owner, subjectId: s.run.subjectId,
    state: "active", text: "OWNER_CAUTION_PRESERVED", source: "user", version: 1 });
  const passages = Array.from({ length: 3 }, (_, index) => ({ sourceId: `fictional-source-${index}`, version: "fixture-version",
    title: "Fictional reference", locator: `PDF page ${index + 1}`, excerpt: String(index).repeat(2000), reviewed: true, species: ["cat"] }));
  s.run.phase = "answer";
  const { request, passages: used } = await s.build(s.config, { ...s.batch, phase: "answer", prepareQuery: false, passages });
  assert.equal(request.messages.at(-1).content.length, 2000);
  assert.equal(request.instructions.includes("OWNER_CAUTION_PRESERVED"), true);
  assert.deepEqual(used, passages);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= s.config.maxContextBytes);
});

test("the context guard still rejects genuinely oversized protected profiles and too many dietary warnings", async t => {
  const s = fixture(t);
  s.subject.profile = { chronicConditions: ["clinical-history ".repeat(3000)] };
  await assert.rejects(s.build(s.config, null), { code: "context_too_large" });
  delete s.subject.profile;
  s.warnings.push(...Array.from({ length: s.config.maxMemoryEntries + 1 }, () => ({ owner: s.run.owner,
    subjectId: s.run.subjectId, state: "active", text: "Preserve this caution", source: "user", version: 1 })));
  await assert.rejects(s.build(s.config, null), { code: "context_too_large" });
});

test("context policy remains explicit and bounded; changing bytes does not alter financial reservations or model limits", () => {
  const before = testConfig(), after = testConfig({ maxContextBytes: 32768 });
  assert.equal(after.maxContextBytes, 32768);
  assert.equal(reservationMicroUsd(after), reservationMicroUsd(before));
  assert.equal(after.maxOutputTokens, before.maxOutputTokens);
  assert.equal(after.price.contextWindowTokens, before.price.contextWindowTokens);
  const env = policy => ({ ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "fixture-only", ASSISTANT_POLICY_JSON: JSON.stringify(policy) });
  for (const value of [32769, 32768.5, "32768", null, 0]) assert.throws(() => loadAssistantConfig(env(testPolicy({ maxContextBytes: value }))),
    { code: "assistant_configuration_required" });
  const missing = testPolicy(); delete missing.maxContextBytes;
  assert.throws(() => loadAssistantConfig(env(missing)), { code: "assistant_configuration_required" });
});
