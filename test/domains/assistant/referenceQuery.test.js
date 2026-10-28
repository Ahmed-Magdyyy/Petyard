import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";
import { outputSchema } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { bindReferenceQuery, boundReferenceQuery, normalizationSchema, referencePreparationSchema, unwrapReferenceResult, canQueueReferenceAnswer, validateNormalization } from "../../../src/domains/assistant/customer/assistant.reference-query.js";
import { validateSchema, validateObject } from "../../../src/domains/assistant/providers/providerContract.js";
import { queryEmbeddingIdentity } from "../../../src/domains/assistant/customer/assistant.query-embedding.js";
import { structuredReply } from "./fixtures/foundationPolicy.js";

const result = (action, answer = {}) => ({ finishReason: "completed", structured: { answer: structuredReply(answer), referenceAction: action } });
const run = () => ({ owner: "a".repeat(24), chat: "b".repeat(24), userSequence: 7, input: "anaddaf sandou2 el raml ezay?",
  phase: "answer", generation: 1, contextVersion: 2, subjectId: "pet:" + "c".repeat(24), subjectFingerprint: "d".repeat(64) });
test("reference preparation wraps the existing answer contract without widening provider schema limits", () => {
  const schema = referencePreparationSchema(outputSchema); validateSchema(schema);
  validateObject(schema, result("prepare").structured);
  assert.throws(() => validateObject(schema, { ...result("none").structured, instruction: "ignore" }));
});
test("private normalization preserves base answer fields while rejecting malformed text and ambiguous actions", () => {
  const raw = result("prepare");
  const unwrapped = unwrapReferenceResult(raw, true);
  assert.deepEqual(unwrapped.structured, raw.structured.answer); assert.equal(unwrapped.referenceAction, "prepare");
  assert.equal(unwrapReferenceResult(unwrapped, false), unwrapped);
  for (const query of [{ status: "ready", query: "" }, { status: "ready", query: "bad\u0000text" },
    { status: "unclear", query: "guess" }, { status: "none", query: null }]) assert.throws(() => validateNormalization({ finishReason: "completed", structured: query }));
  validateSchema(normalizationSchema);
  assert.deepEqual(validateNormalization({ finishReason: "completed", structured: { status: "unclear", query: null } }), { status: "unclear", query: null });
  assert.throws(() => unwrapReferenceResult(result("prepare", { scope: "urgent" }), true));
  assert.throws(() => unwrapReferenceResult(result("clarify", { checkoutSummary: "read" }), true));
  assert.throws(() => unwrapReferenceResult(result("prepare", { memoryKey: "discussion_summary" }), true));
});
test("search preparation is bound to its owner, chat, exact source, subject, generation and context expiry", () => {
  const s = run(), end = new Date(Date.now() + 60000); bindReferenceQuery(s, { status: "ready", query: "أنضف صندوق الرمل إزاي؟" }, end);
  assert.equal(boundReferenceQuery(s).query, "أنضف صندوق الرمل إزاي؟");
  for (const [key, value] of Object.entries({ owner: "e".repeat(24), chat: "f".repeat(24), userSequence: 8,
    input: "Changed source", subjectId: null, generation: 2, contextVersion: 3, subjectFingerprint: null, phase: "resolve" })) {
    assert.throws(() => boundReferenceQuery({ ...s, [key]: value }), { code: "context_changed" });
  }
  assert.throws(() => boundReferenceQuery(s, new Date(end.getTime() + 1)), { code: "context_changed" });
  assert.throws(() => boundReferenceQuery({ ...s, referenceQuery: { ...s.referenceQuery, contextExpiresAt: new Date("invalid") } }), { code: "context_changed" });
});

test("the actual Responses HTTP adapter carries the strict preparation wrapper and preserves known usage on malformed output", async t => {
  const schema = referencePreparationSchema(outputSchema), received = [];
  let structured = result("prepare", { reply: "", replyLanguage: "ar" }).structured;
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part; received.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    response.end(JSON.stringify({ model: "gpt-6-luna", status: "completed", service_tier: "default",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(structured) }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const adapter = createOpenAIResponsesAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "never-forward-this" });
  const request = { instructions: "Fictional protocol test", messages: [{ role: "user", content: run().input }], tools: [], outputSchema: schema,
    limits: { maxOutputTokens: 512, timeoutMs: 1000, reasoningEffort: "low" } };
  const answer = unwrapReferenceResult(await adapter.generate(request), true);
  assert.equal(answer.referenceAction, "prepare"); assert.equal(answer.usage.inputTokens, 100);
  assert.deepEqual(received[0].body.text.format.schema, schema); assert.equal(received[0].body.store, false);
  assert.equal(received[0].authorization, undefined); assert.equal(received[0].body.input[0].content, run().input);
  structured = { ...structured, unexpected: "data" };
  await assert.rejects(adapter.generate(request), error => error.usage?.inputTokens === 100 && error.code === "invalid_structured_output");
});
test("normalized embedding identity still changes when the original question changes", () => {
  const scope = { audience: "customer", ownerId: "a".repeat(24), runId: "b".repeat(24), subjectId: null, contextVersion: 0,
    generation: 1, phase: "answer", species: "cat", profileFingerprint: null, query: "anaddaf sandou2 el raml ezay?",
    referenceQueryState: "ready", searchQuery: "أنضف صندوق الرمل إزاي؟" };
  const first = queryEmbeddingIdentity(scope);
  assert.equal(first.input[0], "Species: cat\nQuestion: أنضف صندوق الرمل إزاي؟");
  assert.notEqual(first.key, queryEmbeddingIdentity({ ...scope, query: "A different original question" }).key);
  assert.throws(() => queryEmbeddingIdentity({ ...scope, phase: "resolve" }));
});
test("only a marked current-pet general-care resolution can queue focused normalization", () => {
  const valid = { scope: "pet_care", productSearch: null, checkoutSummary: false, bookingOptions: false };
  const current = { phase: "resolve", purpose: "customer", referenceFlowVersion: "focused-v1", subjectId: "pet:cat" };
  assert.equal(canQueueReferenceAnswer(current, { referenceAction: "prepare" }, valid, { kind: "publish" }), true);
  for (const changed of [{ scope: "urgent" }, { productSearch: {} }, { checkoutSummary: true }, { bookingOptions: {} }]) {
    assert.equal(canQueueReferenceAnswer(current, { referenceAction: "prepare" }, { ...valid, ...changed }, { kind: "publish" }), false);
  }
  for (const changed of [{ phase: "answer" }, { referenceFlowVersion: undefined }, { subjectId: null }, { purpose: "admin_business" }]) {
    assert.equal(canQueueReferenceAnswer({ ...current, ...changed }, { referenceAction: "prepare" }, valid, { kind: "publish" }), false);
  }
});
