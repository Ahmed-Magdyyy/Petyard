import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOpenAIEmbeddingsAdapter, embeddingBatchBounds, embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";

const vector = () => Array.from({ length: embeddingProfile.dimensions }, (_, index) => index === 0 ? 0.5 : 0);
const payload = () => ({ object: "list", model: embeddingProfile.model,
  data: [{ object: "embedding", index: 0, embedding: vector() }], usage: { prompt_tokens: 5, total_tokens: 5 } });
async function fixture(t) {
  const state = { calls: 0, response: payload(), status: 200, delay: 0 };
  const server = http.createServer(async (req, res) => {
    state.calls++; const parts = []; for await (const part of req) parts.push(part);
    state.request = JSON.parse(Buffer.concat(parts)); state.authorization = req.headers.authorization;
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    res.writeHead(state.status, { "content-type": "application/json", "x-request-id": "fictional-embedding-request" });
    res.end(typeof state.response === "string" ? state.response : JSON.stringify(state.response));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  state.adapter = createOpenAIEmbeddingsAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/v1/embeddings`, apiKey: "must-never-be-forwarded" });
  return state;
}

test("embedding boundary permits only bounded plain text and supported endpoint credentials", () => {
  for (const input of [[], new Array(1), [""], ["\ud800"], ["x\u0000"], ["a".repeat(2001)], ["ا".repeat(1001)], Array(17).fill("Text")]) {
    assert.throws(() => embeddingBatchBounds(input), { code: "invalid_embedding_input" });
  }
  assert.equal(embeddingBatchBounds(["مرجع تجريبي"]).items, 1);
  for (const options of [{}, { apiKey: "encrypted:payload" }, { apiKey: "  encrypted:payload  " }, { endpoint: "https://example.invalid/v1/embeddings", apiKey: "test" },
    { endpoint: "http://127.0.0.1:1234/v1/embeddings?key=secret" }]) assert.throws(() => createOpenAIEmbeddingsAdapter(options));
});

test("real localhost embedding protocol sends only embedding inputs and normalizes input-only usage", async t => {
  const state = await fixture(t);
  const result = await state.adapter.embed({ input: ["Fictional text"], timeoutMs: 1000 });
  assert.deepEqual(state.request, { model: embeddingProfile.model, dimensions: 1536, encoding_format: "float", input: ["Fictional text"] });
  assert.equal(state.authorization, undefined); assert.equal(result.vectors[0].length, 1536);
  assert.equal(result.usage.inputTokens, 5); assert.equal(result.usage.outputTokens, 0);
  assert.equal(result.providerRequestId, "fictional-embedding-request");
});

test("response indexes restore input order and reject duplicate/missing or malformed vectors while retaining known usage", async t => {
  const state = await fixture(t), one = vector(), two = vector(); two[0] = 0.25;
  state.response.data = [{ object: "embedding", index: 1, embedding: two }, { object: "embedding", index: 0, embedding: one }];
  assert.equal((await state.adapter.embed({ input: ["A", "B"], timeoutMs: 1000 })).vectors[0][0], 0.5);
  state.response.data = [{ object: "embedding", index: 0, embedding: one }, { object: "embedding", index: 0, embedding: two }];
  await assert.rejects(state.adapter.embed({ input: ["A", "B"], timeoutMs: 1000 }), { code: "invalid_embedding_response" });
  for (const data of [[{ object: "embedding", index: 0, embedding: [1] }],
    [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }],
    [{ object: "embedding", index: 1, embedding: vector() }],
    [{ object: "embedding", index: 0, embedding: vector().map((value, index) => index === 5 ? null : value) }]]) {
    state.response = { ...payload(), data };
    await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 1000 }), error =>
      error.code === "invalid_embedding_response" && error.usage.inputTokens === 5 && error.chargeExposure === "unknown");
  }
});

test("wrong model, absent or impossible usage cannot be treated as settled spending", async t => {
  const state = await fixture(t);
  for (const response of [{ ...payload(), model: "text-embedding-3-small" }, { ...payload(), usage: null },
    { ...payload(), usage: { prompt_tokens: 9000, total_tokens: 9000 } }]) {
    state.response = response;
    await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 1000 }), error => error.usage === null && error.chargeExposure === "unknown");
  }
});

test("HTTP failures, malformed/oversized responses and timeout are not retried or leaked", async t => {
  const state = await fixture(t);
  for (const [status, response, code] of [[429, "private provider detail", "rate_limited"], [200, "not-json", "invalid_provider_json"],
    [200, "x".repeat(2 * 1024 * 1024 + 1), "response_limit"]]) {
    state.status = status; state.response = response; const calls = state.calls;
    await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 1000 }), error => error.code === code && error.chargeExposure === "unknown" && !error.message.includes("private"));
    assert.equal(state.calls, calls + 1);
  }
  state.status = 200; state.response = payload(); state.delay = 100;
  await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 20 }), { code: "timeout", chargeExposure: "unknown" });
});

test("pre-dispatch cancellation and invalid limits make no HTTP call", async t => {
  const state = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 1000, signal: controller.signal }), { code: "cancelled", chargeExposure: "none" });
  await assert.rejects(state.adapter.embed({ input: ["Text"], timeoutMs: 0 }), { code: "invalid_embedding_timeout" });
  assert.equal(state.calls, 0);
});
