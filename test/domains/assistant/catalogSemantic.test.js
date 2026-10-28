import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCatalogSemanticSearch, catalogQueryIdentity } from "../../../src/domains/assistant/products/assistant.catalog-semantic.js";
import { catalogOffers } from "../../../src/domains/assistant/products/assistant.catalog-offers.js";
import { catalogVectorIndex } from "../../../src/domains/assistant/products/assistant.catalog-vector.model.js";
import { AssistantProviderError } from "../../../src/domains/assistant/providers/providerContract.js";
import { scrubExpiredQueryVectors } from "../../../src/domains/assistant/customer/assistant.query-embedding.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { catalogEmbeddingLedger, catalogPrice, catalogUsage, catalogVector } from "./fixtures/catalogEmbedding.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { createServer } from "node:http";
import { createOpenAIEmbeddingsAdapter } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";

function fixture() {
  const ledger = catalogEmbeddingLedger(), state = ledger.state;
  const config = testConfig({ productSearchEnabled: true, catalogSemanticEnabled: true, catalogSemanticMinimumScore: 0.8 });
  const run = { _id: "1".repeat(24), owner: "2".repeat(24), attempt: randomUUID(), subjectId: null, subjectFingerprint: null,
    phase: "resolve", generation: 0, contextVersion: 1, config };
  const request = { binding: "3".repeat(64), warehouseId: "4".repeat(24), query: "something for cat scratching", species: "cat" };
  const offer = catalogOffers({ _id: "5".repeat(24), isActive: true, type: "SIMPLE", name_en: "Scratching post", warehouseStocks: [{ warehouse: request.warehouseId, quantity: 3 }] })[0];
  Object.assign(state, { calls: 0, fences: 0, indexReads: 0, sourceChecks: 0, time: new Date(), currentConfig: config,
    found: [{ ...offer, model: catalogPrice.model, dimensions: 1536, score: 0.95 }], inputs: [] });
  const search = createCatalogSemanticSearch({ ...ledger.execution,
    vectors: { findOne(filter) {
      assert.equal(String(filter.warehouseIds), request.warehouseId); assert.deepEqual(filter.kind.$in, ["product"]);
      return { select() { return this; }, maxTimeMS() { return this; }, async lean() { return state.empty ? null : { _id: offer._id }; } };
    }, collection: { aggregate(pipeline, options) {
      assert.equal(pipeline[0].$vectorSearch.index, catalogVectorIndex.name);
      assert.equal(String(pipeline[0].$vectorSearch.filter.$and[0].warehouseIds), request.warehouseId);
      assert.deepEqual(pipeline[0].$vectorSearch.filter.$and[1].kind.$in, ["product"]);
      assert.equal(pipeline[1].$project.vector, undefined); assert.equal(options.maxTimeMS, 5000);
      return { async toArray() { return state.found; } };
    } } },
    runs: { async updateOne(filter) { assert.equal(matchesQuery({ ...run, status: "dispatching" }, filter), true); state.fences++; return { modifiedCount: state.rejectFence ? 0 : 1 }; } },
    ensureStore: async () => { if (state.missingStore) throw Error("Unprovisioned"); }, ensureReceipts: async () => {},
    ensureIndex: async () => ({ id: ++state.indexReads > 1 && state.changeIndex ? "other" : "index", name: catalogVectorIndex.name, version: 0 }),
    getConfig: () => state.currentConfig, getEmbeddingConfig: () => ({ price: catalogPrice, timeoutMs: 1000 }),
    getScope: async () => {
      if (state.revoked) throw Object.assign(Error("revoked"), { code: "ai_restricted" });
      return { ownerId: run.owner, runId: run._id, contextVersion: state.contextChanged ? 2 : 1, species: "cat", profileFingerprint: null };
    }, checkSource: async () => { state.sourceChecks++; if (state.changedSource) throw Object.assign(Error("changed"), { code: "context_changed" }); },
    now: () => state.time,
    adapterFactory: () => state.adapter ?? ({ model: catalogPrice.model, dimensions: 1536, async embed({ input }) {
      state.calls++; state.inputs.push(input); if (state.respond) return state.respond(); return { vectors: [catalogVector()], usage: catalogUsage };
    } }),
  });
  return { ...ledger, config, run, request, offer, search: patch => search({ run, config, request, ...patch }) };
}

test("semantic query reserves once in shared accounting and returns private identities only", async () => {
  const f = fixture(); const rows = await f.search(); assert.equal(rows.length, 1); assert.equal(rows[0]._id, f.offer._id);
  assert.deepEqual(f.state.inputs[0], ["Species: cat\nShopping request: something for cat scratching"]);
  assert.equal(f.state.rows[0].kind, "catalog_query"); assert.equal(f.state.rows[0].reference, undefined);
  assert.equal(f.state.held, 0); assert.equal(f.state.spent, 15); assert.equal(f.state.reserved, 1);
  assert.equal(rows[0].vector, undefined); assert.equal(rows[0].score, undefined);
  assert.doesNotMatch(JSON.stringify(f.state.rows), /something for cat scratching/);
  await f.search(); assert.equal(f.state.calls, 1); assert.equal(f.state.reserved, 1);
});
test("warehouse, attempt, configuration and binding all change the query identity", () => {
  const f = fixture(), original = catalogQueryIdentity(f.run, f.request).key;
  for (const request of [{ ...f.request, warehouseId: "6".repeat(24) }, { ...f.request, binding: "7".repeat(64) }, { ...f.request, query: "different" }])
    assert.notEqual(catalogQueryIdentity(f.run, request).key, original);
  assert.notEqual(catalogQueryIdentity({ ...f.run, attempt: randomUUID() }, f.request).key, original);
  assert.notEqual(catalogQueryIdentity({ ...f.run, config: { ...f.config, signature: "different" } }, f.request).key, original);
});
test("disabled, empty and unprovisioned semantic paths cannot dispatch", async () => {
  const f = fixture(); assert.deepEqual(await f.search({ config: { ...f.config, catalogSemanticEnabled: false } }), []);
  f.state.empty = true; assert.deepEqual(await f.search(), []); f.state.empty = false; f.state.missingStore = true;
  await assert.rejects(f.search()); assert.equal(f.state.calls, 0); assert.equal(f.state.reserved, 0);
});
test("budget, source, active context and transaction fence failures prevent paid dispatch", async () => {
  for (const flag of ["denyBudget", "changedSource", "contextChanged", "revoked", "rejectFence"]) {
    const f = fixture(); f.state[flag] = true; await assert.rejects(f.search());
    assert.equal(f.state.calls, 0); assert.equal(f.state.rows.length, 0); assert.equal(f.state.held, 0);
  }
  const f = fixture(); f.state.currentConfig = { ...f.config, signature: "new" };
  await assert.rejects(f.search(), { code: "configuration_changed" }); assert.equal(f.state.calls, 0);
});
test("unknown usage remains reserved and is never retried", async () => {
  const f = fixture(); f.state.respond = () => { throw new AssistantProviderError("timeout", { chargeExposure: "unknown" }); };
  assert.deepEqual(await f.search(), []); assert.equal(f.state.rows[0].status, "uncertain"); assert.ok(f.state.held > 0);
  assert.deepEqual(await f.search(), []); assert.equal(f.state.calls, 1); assert.equal(f.state.reserved, 1);
});
test("changed index and revoked access after a known response settle without returning candidates", async () => {
  const f = fixture(); f.state.changeIndex = true; assert.deepEqual(await f.search(), []); assert.equal(f.state.spent, 15);
  const g = fixture(); g.state.respond = () => { g.state.revoked = true; return { vectors: [catalogVector()], usage: catalogUsage }; };
  await assert.rejects(g.search(), { code: "ai_restricted" }); assert.equal(g.state.held, 0); assert.equal(g.state.spent, 15);
});
test("invalid, duplicate, wrong-model and below-threshold candidates are withheld", async () => {
  const f = fixture(), valid = f.state.found[0];
  f.state.found = [valid, valid, { ...valid, _id: "bad" }, { ...valid, sourceId: "x" }, { ...valid, model: "text-embedding-3-small" },
    { ...valid, _id: "product:" + "6".repeat(24) + ":simple", sourceId: "6".repeat(24), score: 0.1 }];
  assert.equal((await f.search()).length, 1);
});
test("query-vector retention scrubs derived catalog vectors without deleting accounting", async () => {
  const f = fixture(); await f.search(); f.state.time = new Date(f.state.rows[0].vectorsExpireAt.getTime() + 1);
  await scrubExpiredQueryVectors(f.state.time, f.batches, "catalog_query"); assert.equal(f.state.rows[0].vectors, undefined);
  assert.deepEqual(await f.search(), []); assert.equal(f.state.calls, 1); assert.equal(f.state.rows[0].chargedMicroUsd, 15);
});
test("cancellation during reservation rolls back without dispatch", async () => {
  const f = fixture(), controller = new AbortController(); f.state.onReserve = () => controller.abort();
  await assert.rejects(f.search({ signal: controller.signal }), { code: "embedding_dispatch_cancelled" });
  assert.equal(f.state.calls, 0); assert.equal(f.state.rows.length, 0); assert.equal(f.state.held, 0);
});

test("the actual embedding HTTP adapter runs through catalog admission, settlement and 429 suppression", async () => {
  let requests = 0, fail = false; const bodies = [];
  const server = createServer(async (request, response) => {
    requests++; const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers.authorization, undefined); bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json"); response.setHeader("x-request-id", `fictional-${requests}`);
    if (fail) { response.writeHead(429); response.end("{}"); return; }
    response.end(JSON.stringify({ object: "list", model: catalogPrice.model, data: [{ object: "embedding", index: 0, embedding: catalogVector() }],
      usage: { prompt_tokens: 100, total_tokens: 100 } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/embeddings`, f = fixture();
    f.state.adapter = createOpenAIEmbeddingsAdapter({ endpoint });
    const found = await f.search(); assert.equal(f.state.rows[0].status, "completed", JSON.stringify({ code: f.state.rows[0].failureCode, requests, bodies }));
    assert.equal(found.length, 1);
    assert.equal(f.state.spent, 15); assert.equal(requests, 1); assert.equal(bodies[0].model, catalogPrice.model);
    assert.equal(bodies[0].dimensions, 1536); assert.equal(bodies[0].input[0], "Species: cat\nShopping request: something for cat scratching");
    fail = true; const g = fixture(); g.state.adapter = createOpenAIEmbeddingsAdapter({ endpoint });
    assert.deepEqual(await g.search(), []); assert.equal(g.state.rows[0].status, "uncertain"); assert.ok(g.state.held > 0);
    assert.deepEqual(await g.search(), []); assert.equal(requests, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
