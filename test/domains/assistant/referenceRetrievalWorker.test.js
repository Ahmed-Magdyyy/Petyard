import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";
import { createCustomerReferenceRetrieval } from "../../../src/domains/assistant/customer/assistant.reference-retrieval.js";
import { loadReferenceRetrievalConfig } from "../../../src/domains/assistant/references/assistant.reference-config.js";
import { AssistantReference } from "../../../src/domains/assistant/references/assistant.reference.model.js";
import { fenceReferenceSources } from "../../../src/domains/assistant/references/assistant.reference-search.js";
import { referenceVectorIndex } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { AssistantReferencePassage } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { AssistantEmbeddingBatch } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { referencePassageVersion } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { AssistantBudget, AssistantRun, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { referenceEmbeddingBatchKey } from "../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { referencePassageDocumentId } from "../../../src/domains/assistant/references/assistant.reference-projection.js";
import { buildContextWithKnowledge } from "../../../src/domains/assistant/customer/assistant.context.js";
import { finishRun, prepareRun, processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { messageDto, runDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { knownUsage, structuredReply } from "./fixtures/foundationPolicy.js";
import { reconcileRun } from "../../../src/domains/assistant/customer/assistant.service.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { meaningClarificationReply } from "../../../src/domains/assistant/customer/assistant.reference-query.js";

const rejectedMeaning = JSON.parse(readFileSync(new URL("./fixtures/referenceMeaningFailure.json", import.meta.url), "utf8"));

const price = { version: "fictional-retrieval-price", model: "text-embedding-3-large", dimensions: 1536,
  inputMicroUsdPerMillion: 20000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
const env = { ASSISTANT_REFERENCES_ENABLED: "true", ASSISTANT_REFERENCE_RETRIEVAL_ENABLED: "true", ASSISTANT_EMBEDDING_PRICE_JSON: JSON.stringify(price) };
function enable(t) {
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
function source() {
  const row = { _id: new mongoose.Types.ObjectId(), title: "Fictional approved reference", species: ["cat"], status: "ready", stage: "ready",
    sourceStored: true, sha256: "a".repeat(64), passageHash: "b".repeat(64), passageVersion: referencePassageVersion,
    passageCount: 5, storedPassageCount: 5, version: 5 };
  row.activation = { sourceHash: row.sha256, manifestHash: row.passageHash, actor: "c".repeat(24), at: new Date(), reviewedVersion: 4 };
  row.searchVerification = { model: price.model, dimensions: price.dimensions, manifestHash: row.passageHash, passageCount: 5, indexId: "fictional-index", indexName: referenceVectorIndex.name,
    indexVersion: 1, verifiedAt: new Date() };
  return row;
}
const passage = row => ({ sourceId: String(row._id), version: row.passageHash, title: row.title,
  locator: "PDF page 1, excerpt 1", excerpt: "Fictional general care evidence.", reviewed: true, species: ["cat"] });
const batch = (s, passages) => ({ ownerId: String(s.run.owner), runId: String(s.run._id), subjectId: s.run.subjectId, contextVersion: 0,
  referenceFlowVersion: s.run.referenceFlowVersion,
  generation: 0, phase: "resolve", profileFingerprint: s.run.subjectFingerprint, passages });
function fixture(t) {
  enable(t); const s = customerChatFixture(t, "General cat care, please"); const row = source(); s.reference = row; s.fences = 0;
  Object.assign(s.run, { status: "queued", accounting: "none", attempts: [], attempt: null, generation: 0, referenceFlowVersion: "focused-v1",
    deadline: new Date(Date.now() + 60000), toObject() { return { ...this }; } });
  t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: false, billingTimezone: s.config.timezone, openingExposure: s.config.openingExposure }));
  t.mock.method(AssistantReference, "findOne", filter => ({ session() { return this; }, maxTimeMS() { return this; },
    async lean() { return String(filter._id) === String(row._id) ? { ...row } : null; } }));
  t.mock.method(AssistantReference, "updateOne", async (filter, update, options) => {
    assert.ok(options.session); assert.deepEqual(update, { $inc: { retrievalFence: 1 } });
    if (s.conflict || !matchesQuery(row, filter)) return { modifiedCount: 0 };
    s.fences++; return { modifiedCount: 1 };
  });
  s.outcome = () => ({ structured: structuredReply({ reply: "A general care explanation.", scope: "pet_care" }),
    usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [] });
  return s;
}

test("retrieval uses an independent opt-in and the existing dated embedding price without Bunny credentials", () => {
  const shared = { enabled: true, timeoutMs: 1000, monthlyBudgetMicroUsd: 50000000, dailyBudgetMicroUsd: 50000000,
    costMultiplierBasisPoints: 10000, timezone: "Africa/Cairo", openingExposure: { month: "2026-10", microUsd: 0, reason: "fictional" } };
  assert.deepEqual(loadReferenceRetrievalConfig(shared, {}), { enabled: false });
  assert.deepEqual(loadReferenceRetrievalConfig({ enabled: false }, env), { enabled: false });
  const settings = loadReferenceRetrievalConfig(shared, env); assert.equal(settings.enabled, true); assert.deepEqual(settings.price, price);
  assert.throws(() => loadReferenceRetrievalConfig(shared, { ...env, ASSISTANT_EMBEDDING_PRICE_JSON: "{}" }), { code: "embedding_billing_configuration_required" });
});

test("optional unavailable or empty references do no paid work; unknown receipts are not replayed", async () => {
  let embeddings = 0, searches = 0, eligible = false, failure = null;
  const retrieve = createCustomerReferenceRetrieval({ getConfig: () => ({ enabled: true }), adapterFactory: () => ({}),
    search: { async hasEligibleSources() { return eligible; }, async search() { searches++; return []; } },
    async embed() { embeddings++; if (failure) throw failure; return { status: "uncertain", accounting: "reserved" }; } });
  assert.deepEqual(await retrieve({}, { run: {}, config: {} }), []); assert.equal(embeddings, 0);
  eligible = true; assert.deepEqual(await retrieve({}, { run: {}, config: {} }), []); assert.equal(searches, 0);
  failure = Object.assign(new Error("Unknown provider failure"), { code: "embedding_provider_failed" });
  assert.deepEqual(await retrieve({}, { run: {}, config: {} }), []);
  failure.code = "context_changed"; await assert.rejects(retrieve({}, { run: {}, config: {} }), { code: "context_changed" });
  assert.equal(embeddings, 3); assert.equal(searches, 0);
});

test("the default worker retriever checks enabled stores but pays nothing for an empty approved library", async t => {
  const s = fixture(t); let sourceReads = 0, calls = 0;
  t.mock.method(AssistantReference.collection, "indexes", async () => [{ key: { sha256: 1 }, unique: true }]);
  t.mock.method(AssistantReferencePassage.collection, "indexes", async () => [{ key: { _id: 1 } }, { key: { batchKey: 1 } }]);
  t.mock.method(AssistantReference, "find", () => ({ sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; },
    async lean() { sourceReads++; return []; } }));
  t.mock.method(AssistantEmbeddingBatch, "findOne", () => { throw new Error("An empty library must not start a paid query"); });
  t.mock.method(globalThis, "fetch", () => { throw new Error("No provider HTTP is allowed in this fixture"); });
  const result = await processAssistantRun(s.run._id, { getConfig: () => s.config,
    adapterFactory: () => ({ async generate(request) { calls++; assert.match(request.instructions, /no_reviewed_evidence/); return s.outcome(); } }) });
  assert.equal(result.status, "completed"); assert.equal(sourceReads, 1); assert.equal(calls, 1); assert.equal(s.fences, 0);
});

test("the worker supplies its owned run to retrieval, fences approved evidence twice and preserves public DTOs", async t => {
  const s = fixture(t); let queries = 0, modelCalls = 0;
  const retrieve = createCustomerReferenceRetrieval({ getConfig: shared => loadReferenceRetrievalConfig(shared, env), adapterFactory: () => ({}),
    search: { async hasEligibleSources() { return true; }, async search({ scope, query }) {
      assert.equal(scope.runId, String(s.run._id)); assert.equal(query.status, "completed"); return [passage(s.reference)]; } },
    async embed({ run, scope, shared, signal }) {
      queries++; assert.equal(String(run._id), scope.runId); assert.equal(shared.signature, s.config.signature); assert.equal(signal.aborted, false);
      return { status: "completed", accounting: "settled", vector: [1] };
    } });
  const outcome = await processAssistantRun(s.run._id, { getConfig: () => s.config, retrieveKnowledge: retrieve,
    adapterFactory: () => ({ async generate(request) {
      modelCalls++;
      if (modelCalls === 1) return { ...s.outcome(), structured: { answer: structuredReply({ reply: "" }),
        referenceAction: "prepare" } };
      if (modelCalls === 2) return { ...s.outcome(), structured: { status: "ready", query: "General cat care" } };
      assert.match(request.instructions, /Fictional general care evidence/); assert.equal(s.fences, 1); return s.outcome();
    } }) });
  assert.equal(outcome.status, "completed"); assert.equal(queries, 1); assert.equal(modelCalls, 3); assert.equal(s.fences, 2);
  assert.equal(s.messages.length, 1); assert.equal(s.run.accounting, "settled");
  assert.deepEqual(s.run.referenceSources, [{ sourceId: String(s.reference._id), manifestHash: s.reference.passageHash }]);
  assert.doesNotMatch(JSON.stringify({ run: runDto(s.run), message: messageDto(s.messages[0]) }), /referenceSources|manifestHash|retrievalFence/);
});

test("disabled approval, changed manifest and concurrent disabling cannot reserve a chat attempt", async t => {
  const s = fixture(t), evidence = batch(s, [passage(s.reference)]);
  for (const mode of ["disabled", "manifest", "conflict"]) {
    s.reference.status = mode === "disabled" ? "disabled" : "ready";
    s.reference.passageHash = mode === "manifest" ? "d".repeat(64) : "b".repeat(64); s.conflict = mode === "conflict";
    await assert.rejects(prepareRun(s.run._id, s.config, evidence), { code: "reference_knowledge_changed" });
    assert.equal(s.run.attempts.length, 0); assert.equal(s.budgetUpdates.length, 0);
  }
});

test("disabling after model dispatch withholds publication but settles the known charge", async t => {
  const s = fixture(t), prepared = await prepareRun(s.run._id, s.config, batch(s, [passage(s.reference)]));
  s.reference.status = "disabled"; s.reference.stage = "disabled"; s.reference.version++;
  const finished = await finishRun(prepared, s.outcome(), null, { currentConfig: s.config });
  assert.equal(finished.status, "failed"); assert.equal(finished.publicCode, "reference_knowledge_changed"); assert.equal(finished.accounting, "settled");
  assert.ok(finished.chargedMicroUsd > 0); assert.equal(s.messages.length, 0); assert.equal(s.unlocked, 1);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 2);
});

test("switching retrieval off during generation blocks reference-based publication without releasing its charge", async t => {
  const s = fixture(t), prepared = await prepareRun(s.run._id, s.config, batch(s, [passage(s.reference)]));
  process.env.ASSISTANT_REFERENCE_RETRIEVAL_ENABLED = "false";
  const finished = await finishRun(prepared, s.outcome(), null, { currentConfig: s.config });
  assert.equal(finished.status, "failed"); assert.equal(finished.publicCode, "reference_retrieval_unavailable");
  assert.equal(finished.accounting, "settled"); assert.equal(s.messages.length, 0);
});

test("only excerpts actually fitting the request contribute approval bindings", async t => {
  const s = fixture(t), first = { ...passage(s.reference), excerpt: "A".repeat(1500) };
  const measured = await buildContextWithKnowledge(s.run, s.chat, [s.subject], s.config, {}, new Date(), batch(s, [first]));
  const tight = { ...s.config, maxContextBytes: Buffer.byteLength(JSON.stringify(measured.request)) };
  const unused = { ...first, sourceId: "e".repeat(24), locator: "Unused source", excerpt: "B".repeat(1500) };
  const prepared = await prepareRun(s.run._id, tight, batch(s, [first, unused]));
  assert.equal(prepared.run.referenceSources.length, 1); assert.equal(s.fences, 1);
  assert.equal(prepared.request.instructions.includes(unused.excerpt), false);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.request)) <= tight.maxContextBytes);
});

test("duplicate or invalid approval bindings are rejected without trusting caller identifiers", async t => {
  const s = fixture(t), binding = { sourceId: String(s.reference._id), manifestHash: s.reference.passageHash };
  await assert.rejects(fenceReferenceSources([binding, binding], {}), { code: "reference_knowledge_changed" });
  await assert.rejects(fenceReferenceSources([{ sourceId: "not-an-id", manifestHash: binding.manifestHash }], {}), { code: "reference_knowledge_changed" });
});

// Only storage, Search responses and provider transport are fictional; default retrieval and query receipt wiring run normally.
function connectedFixture(t) {
  const s = fixture(t), vector = Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);
  const nativeFetch = globalThis.fetch;
  Object.assign(s, { receipts: [], embeddingCalls: 0, searches: 0, modelCalls: 0 });
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "fictional-local-test-key";
  t.after(() => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; });
  t.mock.method(AssistantRun, "updateOne", async (filter, update) => {
    assert.ok(matchesQuery(s.run, filter)); s.run.queryEmbeddingFence = (s.run.queryEmbeddingFence ?? 0) + update.$inc.queryEmbeddingFence;
    return { modifiedCount: 1 };
  });
  t.mock.method(AssistantEmbeddingBatch.collection, "indexes", async () => [{ key: { key: 1 }, unique: true }, { key: { kind: 1, vectorsExpireAt: 1 } }]);
  t.mock.method(AssistantEmbeddingBatch.collection, "findOne", async filter => s.receipts.find(row => matchesQuery(row, filter)) ?? null);
  t.mock.method(AssistantEmbeddingBatch.collection, "insertOne", async row => {
    assert.equal(s.receipts.length, 0); s.receipts.push(row); return { acknowledged: true, insertedId: row._id };
  });
  t.mock.method(AssistantEmbeddingBatch.collection, "updateOne", async (filter, update) => {
    const row = s.receipts.find(row => matchesQuery(row, filter)); assert.ok(row);
    assert.equal(update.$set.kind, undefined); Object.assign(row, update.$set);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(AssistantEmbeddingBatch.collection, "updateMany", async filter => {
    assert.equal(filter.kind, "customer_query"); assert.ok(!s.receipts.some(row => matchesQuery(row, filter)));
    return { acknowledged: true, modifiedCount: 0 };
  });
  t.mock.method(AssistantReference.collection, "indexes", async () => [{ key: { sha256: 1 }, unique: true }]);
  t.mock.method(AssistantReferencePassage.collection, "indexes", async () => [{ key: { _id: 1 } }, { key: { batchKey: 1 } }]);
  t.mock.method(AssistantReference, "find", filter => ({ sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; },
    async lean() {
      const row = s.reference;
      return matchesQuery({ ...row, species: "cat" }, filter) ? [{ ...row }] : [];
    } }));
  const batchKey = referenceEmbeddingBatchKey(s.reference._id, s.reference.passageHash, 0), passageId = "d".repeat(64);
  t.mock.method(AssistantReferencePassage.collection, "aggregate", pipeline => ({ async toArray() {
    if (pipeline[0].$listSearchIndexes) return [{ id: "fictional-index", name: referenceVectorIndex.name, type: referenceVectorIndex.type,
      status: "READY", queryable: true, latestDefinition: referenceVectorIndex.definition, latestDefinitionVersion: { version: 1 },
      statusDetail: [{ status: "READY", queryable: true, mainIndex: { status: "READY", queryable: true,
        definition: referenceVectorIndex.definition, definitionVersion: { version: 1 } } }] }];
    const query = pipeline[0].$vectorSearch; assert.deepEqual(query.queryVector, vector);
    assert.deepEqual(query.filter.$and[1].$or, [{ reference: s.reference._id, manifestHash: s.reference.passageHash }]);
    s.searches++;
    return s.noMatches ? [] : [{ _id: referencePassageDocumentId(batchKey, passageId), batchKey, passageId,
      reference: s.reference._id, manifestHash: s.reference.passageHash, sourceHash: s.reference.sha256,
      model: price.model, dimensions: price.dimensions, text: passage(s.reference).excerpt, locator: passage(s.reference).locator, score: 0.9 }];
  } }));
  t.mock.method(globalThis, "fetch", async (url, request) => {
    if (s.localResponsesEndpoint && String(url) === s.localResponsesEndpoint) return nativeFetch(url, request);
    assert.equal(url, "https://api.openai.com/v1/embeddings"); assert.equal(request.method, "POST");
    assert.deepEqual(JSON.parse(request.body).input, [`Species: cat\nQuestion: ${s.normalizedQuery ?? "General cat care"}`]); s.embeddingCalls++;
    s.afterEmbedding?.();
    return new Response(JSON.stringify({ object: "list", model: price.model, data: [{ object: "embedding", index: 0, embedding: vector }],
      usage: { prompt_tokens: 100, total_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  s.process = (options = {}) => processAssistantRun(s.run._id, { getConfig: () => s.config,
    adapterFactory: () => ({ async generate(request) {
      s.modelCalls++; s.request = request;
      if (request.outputSchema.properties.answer) {
        s.afterPreparationDispatch?.();
        return { ...s.outcome(), structured: { answer: structuredReply({ reply: s.clarification ?? "", replyLanguage: s.replyLanguage ?? "en" }),
          referenceAction: s.referenceAction ?? (s.queryPreparation?.status === "unclear" ? "clarify" : "prepare") } };
      }
      if (request.outputSchema.properties.status) {
        s.normalizationRequest = request;
        s.afterNormalizationDispatch?.();
        return s.normalizationOutcome?.() ?? { ...s.outcome(), structured: s.queryPreparation ?? { status: "ready", query: s.normalizedQuery ?? "General cat care" } };
      }
      s.afterDispatch?.(); return s.outcome();
    } }), ...options });
  return s;
}

test("default customer path connects real query receipt, approved search and fenced answer publication", async t => {
  const s = connectedFixture(t), result = await s.process();
  assert.equal(result.status, "completed"); assert.equal(s.embeddingCalls, 1); assert.equal(s.searches, 1); assert.equal(s.modelCalls, 3);
  assert.equal(s.receipts.length, 1); const receipt = s.receipts[0];
  assert.equal(receipt.kind, "customer_query"); assert.equal(String(receipt.owner), String(s.run.owner));
  assert.equal(String(receipt.run), String(s.run._id)); assert.equal(receipt.status, "completed"); assert.equal(receipt.accounting, "settled");
  assert.ok(receipt.chargedMicroUsd > 0); assert.doesNotMatch(JSON.stringify(receipt), /General cat care/);
  assert.match(s.request.instructions, /Fictional general care evidence/); assert.equal(s.fences, 2); assert.equal(s.messages.length, 1);
  assert.deepEqual(s.run.referenceSources, [{ sourceId: String(s.reference._id), manifestHash: s.reference.passageHash }]);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 8);
  assert.equal(s.run.attempts.length, 3); assert.ok(s.run.attempts.every(attempt => attempt.accounting === "settled"));
  assert.doesNotMatch(JSON.stringify({ run: runDto(s.run), message: messageDto(s.messages[0]) }), /referenceQuery|referencePreparation|contextExpiresAt|General cat care/);
});

test("a source question changed after embedding cannot dispatch the connected chat answer", async t => {
  const s = connectedFixture(t); s.afterEmbedding = () => { s.source.text = "A different user's question"; };
  await s.process();
  assert.equal(s.run.status, "failed"); assert.equal(s.run.publicCode, "context_changed");
  assert.equal(s.embeddingCalls, 1); assert.equal(s.receipts[0].accounting, "settled");
  assert.equal(s.modelCalls, 2); assert.equal(s.messages.length, 0);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 6);
});

test("connected retrieval with no matches retains query accounting and allows general education", async t => {
  const s = connectedFixture(t); s.noMatches = true;
  assert.equal((await s.process()).status, "completed");
  assert.equal(s.embeddingCalls, 1); assert.equal(s.searches, 1); assert.equal(s.receipts[0].accounting, "settled");
  assert.match(s.request.instructions, /no_reviewed_evidence/); assert.doesNotMatch(s.request.instructions, /Fictional general care evidence/);
  assert.equal(s.fences, 0); assert.deepEqual(s.run.referenceSources, []); assert.equal(s.messages.length, 1);
});

test("disabling a source during the connected answer withholds publication and retains all four known charges", async t => {
  const s = connectedFixture(t); s.afterDispatch = () => { s.reference.status = "disabled"; s.reference.stage = "disabled"; s.reference.version++; };
  assert.equal((await s.process()).status, "failed");
  assert.equal(s.run.publicCode, "reference_knowledge_changed"); assert.equal(s.run.accounting, "settled");
  assert.equal(s.receipts[0].accounting, "settled"); assert.equal(s.embeddingCalls, 1); assert.equal(s.modelCalls, 3);
  assert.equal(s.messages.length, 0); assert.equal(s.unlocked, 1);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 8);
});

test("a source question changed during answer generation cannot publish the connected answer", async t => {
  const s = connectedFixture(t); s.afterDispatch = () => { s.source.text = "Changed saved question during generation"; };
  assert.equal((await s.process()).status, "failed");
  assert.equal(s.run.publicCode, "context_changed"); assert.equal(s.run.accounting, "settled");
  assert.equal(s.receipts[0].accounting, "settled"); assert.equal(s.embeddingCalls, 1); assert.equal(s.modelCalls, 3);
  assert.equal(s.messages.length, 0); assert.equal(s.unlocked, 1);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 8);
});

test("ambiguous Arabizi asks in Arabic without embeddings, actions or private DTO fields", async t => {
  const s = connectedFixture(t);
  s.run.input = s.source.text = "farshet el kalb";
  s.queryPreparation = { status: "unclear", query: null };
  s.clarification = "تقصد فرشة النوم ولا فرشاة الشعر؟"; s.replyLanguage = "ar";
  assert.equal((await s.process()).status, "completed");
  assert.equal(s.run.publicCode, "meaning_clarification_required");
  assert.equal(s.messages[0].text, meaningClarificationReply("ar")); assert.equal(s.run.attempts.length, 1);
  assert.equal(s.modelCalls, 1); assert.equal(s.embeddingCalls, 0); assert.equal(s.searches, 0); assert.equal(s.receipts.length, 0);
  assert.doesNotMatch(JSON.stringify({ run: runDto(s.run), message: messageDto(s.messages[0]) }), /referenceQuery|referencePreparation/);
});

test("a short clarification reply retains same-pet wording and searches only the resolved question", async t => {
  const s = connectedFixture(t), createdAt = new Date();
  s.run.input = s.source.text = "farshet el kalb";
  s.queryPreparation = { status: "unclear", query: null }; s.clarification = "تقصد فرشة النوم ولا فرشاة الشعر؟"; s.replyLanguage = "ar";
  assert.equal((await s.process()).status, "completed");
  const history = [{ ...s.source, createdAt }, { ...s.messages[0], createdAt }];
  const foreign = { ...history[0], subjectId: "pet:" + "f".repeat(24), text: "Other pet's private question" };
  t.mock.method(AssistantMessage, "find", filter => ({ sort() { return this; }, limit() { return this; }, session() { return this; },
    async lean() { return [foreign, ...history].filter(row => matchesQuery(row, filter)).reverse(); } }));
  Object.assign(s.run, { _id: new mongoose.Types.ObjectId(), input: "el nom", userSequence: 3, status: "queued", phase: "resolve",
    generation: 0, attempts: [], attempt: null, accounting: "none", referenceQuery: undefined, createdAt: new Date() });
  Object.assign(s.source, { run: s.run._id, sequence: 3, text: s.run.input }); s.account.activeRun = s.run._id;
  s.normalizedQuery = "فرشة نوم الكلب"; s.queryPreparation = { status: "ready", query: s.normalizedQuery }; s.clarification = undefined;
  s.afterPreparationDispatch = () => {
    const content = JSON.stringify(s.request.messages);
    assert.match(content, /farshet el kalb/); assert.ok(content.includes(meaningClarificationReply("ar"))); assert.doesNotMatch(content, /Other pet/);
    assert.equal(s.request.messages.at(-1).content, "el nom");
  };
  assert.equal((await s.process()).status, "completed");
  assert.equal(s.modelCalls, 4); assert.equal(s.embeddingCalls, 1); assert.equal(s.run.attempts.length, 3);
  assert.equal(s.run.referenceQuery.query, s.normalizedQuery); assert.equal(s.run.publicCode, null);
});

test("unknown preparation usage retains its reservation and cannot start embeddings or an answer retry", async t => {
  const s = connectedFixture(t), outcome = s.outcome;
  s.outcome = () => ({ ...outcome(), usage: null });
  assert.equal((await s.process()).status, "uncertain");
  assert.equal(s.run.accounting, "reserved"); assert.equal(s.run.attempts.length, 1);
  assert.equal(s.modelCalls, 1); assert.equal(s.embeddingCalls, 0); assert.equal(s.messages.length, 0);
});

test("forgotten context or expired preparation cannot start reference search after the first call", async t => {
  for (const mode of ["forgotten", "expired", "blocked"]) await t.test(mode, async t => {
    const s = connectedFixture(t);
    s.afterPreparationDispatch = () => {
      if (mode === "forgotten") s.chat.contextVersion++;
      if (mode === "expired") s.run.referenceContextExpiresAt = new Date(Date.now() - 1);
      if (mode === "blocked") s.account.blocked = true;
    };
    await s.process();
    assert.equal(s.run.status, "failed"); assert.equal(s.run.attempts[0].accounting, "settled");
    assert.equal(s.modelCalls, 1); assert.equal(s.embeddingCalls, 0); assert.equal(s.messages.length, 0);
  });
});

test("urgent input preserves the immediate safety answer without reference work or another call", async t => {
  const s = connectedFixture(t); s.queryPreparation = { status: "none", query: null };
  const outcome = s.outcome; s.outcome = () => ({ ...outcome(), structured: structuredReply({ scope: "urgent", reply: "" }) });
  // The preparation schema still carries the normal answer, including its urgent scope.
  s.afterPreparationDispatch = () => {};
  const generate = () => ({ async generate() {
    s.modelCalls++; return { ...s.outcome(), structured: { answer: s.outcome().structured, referenceAction: "none" } };
  } });
  assert.equal((await processAssistantRun(s.run._id, { getConfig: () => s.config, adapterFactory: generate })).status, "completed");
  assert.match(s.messages[0].text, /immediate veterinary attention/); assert.equal(s.modelCalls, 1); assert.equal(s.embeddingCalls, 0);
});

test("a pet switch discards prior-pet search wording and reloads the subject within the same two-call cap", async t => {
  const s = connectedFixture(t), nextPet = { _id: new mongoose.Types.ObjectId(), petOwner: s.run.owner, name: "Roy", type: "dog" };
  s.pets.push(nextPet); s.run.input = s.source.text = "How should I brush Roy?";
  const nextId = `pet:${nextPet._id}`;
  const outcome = await processAssistantRun(s.run._id, { getConfig: () => s.config, adapterFactory: () => ({ async generate(request) {
    s.modelCalls++;
    if (s.modelCalls === 1) return { ...s.outcome(), structured: {
      answer: structuredReply({ reply: "", subjectAction: "select", resolvedSubjectId: nextId }),
      referenceAction: "none" } };
    assert.equal(request.outputSchema.properties.answer, undefined);
    assert.match(request.instructions, /"activeSubject":"pet:/); assert.match(request.instructions, new RegExp(nextId));
    assert.doesNotMatch(JSON.stringify(request), /Wrong prior-pet information/);
    return s.outcome();
  } }) });
  assert.equal(outcome.status, "completed"); assert.equal(s.run.subjectId, nextId); assert.equal(s.source.subjectId, nextId);
  assert.equal(s.run.referenceQuery, undefined); assert.equal(s.modelCalls, 2); assert.equal(s.embeddingCalls, 0);
  assert.equal(s.run.attempts.length, 2); assert.equal(s.messages.length, 1);
});

test("unknown normalization usage keeps its own reservation and never dispatches embeddings or an answer", async t => {
  const s = connectedFixture(t);
  s.normalizationOutcome = () => ({ ...s.outcome(), usage: null, structured: { status: "ready", query: "General cat care" } });
  assert.equal((await s.process()).status, "uncertain");
  assert.deepEqual(s.run.attempts.map(a => a.accounting), ["settled", "reserved"]);
  assert.equal(s.run.attempts[1].phase, "normalize"); assert.equal(s.modelCalls, 2);
  assert.equal(s.embeddingCalls, 0); assert.equal(s.messages.length, 0); assert.equal(s.unlocked, 0);
  assert.equal((await s.process()).skipped, true); assert.equal(s.modelCalls, 2);
});

test("unknown final-answer usage preserves two earlier settlements and cannot create a fourth call", async t => {
  const s = connectedFixture(t), original = s.outcome;
  s.afterDispatch = () => { s.outcome = () => ({ ...original(), usage: null }); };
  assert.equal((await s.process()).status, "uncertain");
  assert.deepEqual(s.run.attempts.map(a => a.accounting), ["settled", "settled", "reserved"]);
  assert.equal(s.receipts[0].accounting, "settled"); assert.equal(s.modelCalls, 3); assert.equal(s.messages.length, 0);
  assert.equal(s.unlocked, 0); assert.equal((await s.process()).skipped, true); assert.equal(s.modelCalls, 3);
});

test("existing reconciliation closes a third uncertain attempt using its original reservation once", async t => {
  const s = connectedFixture(t), original = s.outcome;
  s.afterDispatch = () => { s.outcome = () => ({ ...original(), usage: null }); };
  assert.equal((await s.process()).status, "uncertain");
  const retained = JSON.stringify(s.run.attempts.slice(0, 2)), reserved = s.run.reservation;
  t.mock.method(AssistantRun, "findById", () => ({ async session() { return s.run; } }));
  const close = () => reconcileRun(s.run.owner, String(s.run._id), { resolution: "charge_reserved", reason: "Fictional local review" }, s.config);
  const before = s.budgetUpdates.length;
  assert.equal((await close()).duplicate, false);
  assert.equal(s.run.status, "failed"); assert.equal(s.run.publicCode, "request_closed_after_review");
  assert.equal(s.run.attempts[2].accounting, "charged_reservation"); assert.equal(s.run.attempts[2].chargedMicroUsd, reserved.amount);
  assert.equal(JSON.stringify(s.run.attempts.slice(0, 2)), retained); assert.equal(s.unlocked, 1);
  const settlements = s.budgetUpdates.slice(before);
  assert.deepEqual(settlements.map(row => row.filter._id), reserved.budgetIds);
  assert.ok(settlements.every(row => row.update.$inc.spent === reserved.amount && row.update.$inc.reserved === -reserved.amount));
  assert.equal((await close()).duplicate, true); assert.equal(s.budgetUpdates.length, before + 2);
  assert.equal((await s.process()).skipped, true); assert.equal(s.modelCalls, 3);
});

test("a library disappearing before normalization skips that stage without a paid or phantom attempt", async t => {
  const s = connectedFixture(t);
  s.afterPreparationDispatch = () => { s.reference.status = "disabled"; };
  assert.equal((await s.process()).status, "completed");
  assert.deepEqual(s.run.attempts.map(a => a.phase), ["resolve", "answer"]);
  assert.equal(s.modelCalls, 2); assert.equal(s.normalizationRequest, undefined);
  assert.equal(s.embeddingCalls, 0); assert.equal(s.receipts.length, 0); assert.equal(s.messages.length, 1);
  assert.equal(s.budgetUpdates.filter(row => row.update.$inc?.spent > 0).length, 4);
});

test("normalization ambiguity ends in clarification without embedding, actions or memory", async t => {
  const s = connectedFixture(t); s.referenceAction = "prepare";
  s.queryPreparation = { status: "unclear", query: null };
  s.run.input = s.source.text = "farshet el kalb";
  const clarification = "تقصد فرشة النوم ولا فرشاة الشعر؟", original = s.outcome;
  s.afterDispatch = () => { s.outcome = () => ({ ...original(), structured: structuredReply({ reply: clarification, replyLanguage: "ar" }) }); };
  assert.equal((await s.process()).status, "completed");
  assert.equal(s.run.publicCode, "meaning_clarification_required"); assert.equal(s.messages[0].text, meaningClarificationReply("ar"));
  assert.equal(s.modelCalls, 3); assert.equal(s.embeddingCalls, 0); assert.equal(s.receipts.length, 0);
  assert.deepEqual(s.normalizationRequest.outputSchema.required, ["status", "query"]);
  assert.doesNotMatch(s.normalizationRequest.instructions, /productSearch|checkoutSummary|bookingOptions|memoryKey/);
});

test("malformed normalization fails after settling known usage, without repair or retries", async t => {
  for (const structured of [{ status: "ready", query: "" }, { status: "unclear", query: "A guess" },
    { status: "ready", query: "Care", answer: "Forbidden" }]) await t.test(JSON.stringify(structured), async t => {
    const s = connectedFixture(t); s.normalizationOutcome = () => ({ ...s.outcome(), structured });
    assert.equal((await s.process()).status, "failed");
    assert.ok(["invalid_reference_query", "assistant_response_unavailable"].includes(s.run.publicCode));
    assert.equal(s.modelCalls, 2); assert.equal(s.embeddingCalls, 0);
    assert.deepEqual(s.run.attempts.map(a => a.accounting), ["settled", "settled"]);
    assert.equal(s.messages.length, 0); assert.equal(s.unlocked, 1);
  });
});

test("access, source, pet, configuration and expiry changes during normalization withhold its result after settlement", async t => {
  const modes = { blocked: "ai_restricted", forgotten: "context_changed", source: "context_changed", pet: "context_changed",
    configuration: "configuration_changed", expired: "context_changed", deadline: "queue_expired" };
  for (const [mode, code] of Object.entries(modes)) await t.test(mode, async t => {
    const s = connectedFixture(t);
    s.afterNormalizationDispatch = () => {
      if (mode === "blocked") s.account.blocked = true;
      if (mode === "forgotten") s.chat.contextVersion++;
      if (mode === "source") s.source.text = "Changed question";
      if (mode === "pet") s.pet.name = "Changed pet";
      if (mode === "configuration") s.config = { ...s.config, signature: "changed" };
      if (mode === "expired") s.run.referenceContextExpiresAt = new Date(Date.now() - 1);
      if (mode === "deadline") s.run.deadline = new Date(Date.now() - 1);
    };
    assert.equal((await s.process()).status, "failed"); assert.equal(s.run.publicCode, code);
    assert.equal(s.modelCalls, 2); assert.equal(s.embeddingCalls, 0); assert.equal(s.messages.length, 0);
    assert.deepEqual(s.run.attempts.map(a => a.accounting), ["settled", "settled"]);
  });
});

test("budget freeze before normalization or answer prevents the next reservation and preserves earlier charges", async t => {
  for (const after of ["afterPreparationDispatch", "afterNormalizationDispatch"]) await t.test(after, async t => {
    const s = connectedFixture(t);
    s[after] = () => t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: true }));
    assert.equal((await s.process()).failedBeforeDispatch, true);
    assert.equal(s.run.status, "failed"); assert.equal(s.run.publicCode, "assistant_accounting_unavailable");
    assert.equal(s.modelCalls, after === "afterPreparationDispatch" ? 1 : 2);
    assert.ok(s.run.attempts.every(a => a.accounting === "settled"));
    assert.equal(s.messages.length, 0);
  });
});

test("three stages cross the real Responses HTTP adapter with separate schemas and one final publication", async t => {
  const s = connectedFixture(t), requests = [];
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const part of request) text += part;
    const body = JSON.parse(text); requests.push(body);
    const schema = body.text.format.schema;
    const structured = schema.properties.answer ? { answer: structuredReply({ reply: "" }), referenceAction: "prepare" }
      : schema.properties.status ? { status: "ready", query: "General cat care" } : s.outcome().structured;
    response.setHeader("x-request-id", `fictional-${requests.length}`);
    response.end(JSON.stringify({ model: "gpt-6-luna", status: "completed", service_tier: "default",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(structured) }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  s.localResponsesEndpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const outcome = await s.process({ adapterFactory: () => createOpenAIResponsesAdapter({ endpoint: s.localResponsesEndpoint }) });
  assert.equal(outcome.status, "completed"); assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].text.format.schema.required, ["answer", "referenceAction"]);
  assert.deepEqual(requests[1].text.format.schema.required, ["status", "query"]);
  assert.equal(requests[2].text.format.schema.properties.referenceAction, undefined);
  assert.ok(requests.every(r => r.store === false && r.reasoning.effort === "low"));
  assert.doesNotMatch(requests[1].instructions, /productSearch|checkoutSummary|bookingOptions|reviewedKnowledge/);
  assert.match(requests[2].instructions, /Fictional general care evidence/);
  assert.deepEqual(s.run.attempts.map(a => a.providerRequestId), ["fictional-1", "fictional-2", "fictional-3"]);
  assert.ok(s.run.attempts.every(a => a.accounting === "settled")); assert.equal(s.messages.length, 1);
  assert.equal(s.embeddingCalls, 1); assert.equal(s.fences, 2);
});

test("recorded advice after an unclear meaning becomes a safe question on both clarification paths", async t => {
  for (const stage of ["routing", "normalization"]) await t.test(stage, async t => {
    const s = connectedFixture(t), original = s.outcome;
    s.run.input = s.source.text = rejectedMeaning.ambiguity.input;
    s.queryPreparation = { status: "unclear", query: null }; s.replyLanguage = "ar";
    s.referenceAction = stage === "routing" ? "clarify" : "prepare";
    s.clarification = rejectedMeaning.ambiguity.answer.reply;
    s.afterDispatch = () => { s.outcome = () => ({ ...original(), structured: {
      ...rejectedMeaning.ambiguity.answer, resolvedSubjectId: s.run.subjectId,
    } }); };
    assert.equal((await s.process()).status, "completed");
    assert.equal(s.run.publicCode, "meaning_clarification_required");
    assert.equal(s.messages[0].text, "ممكن توضح قصدك أكتر عشان ما أفهمش سؤالك غلط؟");
    assert.notEqual(s.messages[0].text, rejectedMeaning.ambiguity.answer.reply);
    assert.equal(s.modelCalls, stage === "routing" ? 1 : 3); assert.equal(s.embeddingCalls, 0);
    assert.ok(s.run.attempts.every(attempt => attempt.accounting === "settled")); assert.equal(s.messages.length, 1);
  });
});

test("a question mark cannot let guessed advice through a known-unclear response", async t => {
  const s = connectedFixture(t); s.queryPreparation = { status: "unclear", query: null };
  s.clarification = "Do you mean bedding? Wash it now with the following steps.";
  assert.equal((await s.process()).status, "completed");
  assert.equal(s.messages[0].text, "Could you clarify what you mean so I do not misunderstand your question?");
  assert.doesNotMatch(s.messages[0].text, /Wash|bedding/); assert.equal(s.embeddingCalls, 0);
});

test("an unclear-query safeguard preserves urgent and health referral priority", async t => {
  for (const scope of ["urgent", "health"]) await t.test(scope, async t => {
    const s = connectedFixture(t), original = s.outcome;
    s.referenceAction = "prepare"; s.queryPreparation = { status: "unclear", query: null }; s.replyLanguage = "ar";
    s.afterDispatch = () => { s.outcome = () => ({ ...original(), structured: structuredReply({ scope, reply: "GUESS", replyLanguage: "ar" }) }); };
    assert.equal((await s.process()).status, "completed"); assert.equal(s.run.publicCode, null);
    assert.match(s.messages[0].text, scope === "urgent" ? /طوارئ بيطرية/ : /طبيب بيطري/);
    assert.notEqual(s.messages[0].text, meaningClarificationReply("ar")); assert.doesNotMatch(s.messages[0].text, /GUESS/);
    assert.equal(s.embeddingCalls, 0); assert.equal(s.modelCalls, 3);
  });
});
