import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { once } from "node:events";
import { createReferenceEmbeddingService } from "../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { AssistantEmbeddingBatch, assertEmbeddingBatchStore } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { AssistantProviderError } from "../../../src/domains/assistant/providers/providerContract.js";
import { embeddingProfile, createOpenAIEmbeddingsAdapter } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { referencePassageVersion } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";
import { referenceActor, referenceTestConfig } from "./fixtures/referenceMemory.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";

const now = new Date("2026-10-25T12:00:00Z");
const price = { version: "synthetic-embedding-rate-v1", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
  inputMicroUsdPerMillion: 20000, validFrom: "2026-10-24T00:00:00Z", validUntil: "2026-11-01T00:00:00Z" };
const usage = { inputTokens: 100, outputTokens: 0, totalTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const vector = () => Array.from({ length: embeddingProfile.dimensions }, (_, index) => index === 0 ? 0.5 : 0);

// Serialized rollback fixture exercises coordinator decisions, not native transaction/unique-index races.
function fixture() {
  const actor = referenceActor(), id = new mongoose.Types.ObjectId();
  const passages = Array.from({ length: 17 }, (_, index) => ({ id: String(index).padStart(64, "0"), text: `Fictional passage ${index}` }));
  const manifest = Buffer.from(JSON.stringify({ version: referencePassageVersion, sourceId: String(id), sourceVersion: "a".repeat(64), passages }));
  const state = { batches: [], source: { _id: String(id), creator: String(actor._id), status: "processing", stage: "awaiting_index", version: 3,
    sourceStored: true, sha256: "a".repeat(64), passageHash: sourceHash(manifest), passageVersion: referencePassageVersion, passageCount: passages.length },
    calls: 0, reservations: 0, settlements: 0, reserved: 0, spent: 0, transactions: 0 };
  const query = get => ({ session() { return this; }, async lean() { return get(); }, then(resolve, reject) { return Promise.resolve(get()).then(resolve, reject); } });
  const document = data => Object.assign(structuredClone(data), { async save() {
    if (state.failSave) throw new Error("fictional commit failure");
    const copy = { ...this }; delete copy.save;
    state.batches[state.batches.findIndex(row => row.key === copy.key)] = structuredClone(copy);
  } });
  const batches = { findOne: filter => query(() => {
    const row = state.batches.find(entry => matchesQuery(entry, filter)); return row ? document(row) : null;
  }), async create(rows) {
    assert.equal(state.batches.some(row => row.key === rows[0].key), false);
    state.batches.push(structuredClone(rows[0])); return [document(rows[0])];
  } };
  const references = { findById: () => query(() => ({ ...state.source })), async updateOne(filter, update) {
    if (state.disableBeforeAdmission) state.source.status = "disabled";
    if (!matchesQuery(state.source, filter)) return { modifiedCount: 0 };
    state.source.embeddingFence = (state.source.embeddingFence ?? 0) + update.$inc.embeddingFence; return { modifiedCount: 1 };
  } };
  let tail = Promise.resolve();
  const service = createReferenceEmbeddingService({ batches, references, ensureStore: async () => {}, now: () => now,
    atomic(callback) {
      const task = tail.then(async () => {
        const before = structuredClone({ batches: state.batches, source: state.source, reserved: state.reserved, spent: state.spent,
          reservations: state.reservations, settlements: state.settlements });
        state.transactions++;
        try { return await callback({ fictional: true }); } catch (error) { Object.assign(state, before); throw error; }
      }); tail = task.catch(() => {}); return task;
    },
    async reserve(_owner, config) {
      if (state.denyBudget) throw Object.assign(new Error("monthly_budget_limit"), { code: "monthly_budget_limit" });
      state.reservations++; state.reserved += 2622;
      return { amount: 2622, budgetIds: ["global:fictional", "user:fictional"], priceVersion: config.price.version };
    },
    async settle(row, billed) {
      assert.equal(row.accounting, "reserved"); state.settlements++; state.reserved -= row.reservation.amount;
      state.spent += billed.inputTokens ? 2 : 0; row.accounting = "settled"; row.usage = billed;
      row.chargedMicroUsd = billed.inputTokens ? 2 : 0; return true;
    } });
  const args = { actor, referenceId: id, manifest, start: 0, referenceConfig: referenceTestConfig(), shared: testPolicy({ enabled: true }), price,
    timeoutMs: 1000, adapter: { ...embeddingProfile, async embed({ input }) {
      state.calls++; assert.equal(state.batches[0].status, "dispatching"); assert.equal(state.reservations, state.calls);
      if (state.respond) return state.respond(input);
      return { vectors: input.map(vector), usage, providerRequestId: "fictional-request" };
    } } };
  return { service, state, args, run: patch => service.processBatch({ ...args, ...patch }) };
}

test("embedding store requires full uniqueness, rejects TTL, and never sets up a store", async t => {
  let indexes = [{ key: { key: 1 }, unique: true }];
  t.mock.method(AssistantEmbeddingBatch.collection, "indexes", async () => indexes);
  t.mock.method(AssistantEmbeddingBatch, "createCollection", () => assert.fail("setup forbidden"));
  t.mock.method(AssistantEmbeddingBatch, "createIndexes", () => assert.fail("setup forbidden"));
  await assertEmbeddingBatchStore();
  for (const bad of [[], [{ key: { key: 1 }, unique: true, sparse: true }], [{ key: { key: 1 }, unique: true, partialFilterExpression: {} }],
    [{ key: { key: 1 }, unique: true, collation: { locale: "en" } }], [...indexes, { key: { createdAt: 1 }, expireAfterSeconds: 1 }]]) {
    indexes = bad; await assert.rejects(assertEmbeddingBatchStore(), { code: "embedding_store_unavailable" });
  }
});

test("completed vectors and frozen request identity survive re-entry without a second call or settlement", async () => {
  const f = fixture(), first = await f.run();
  assert.equal(first.status, "completed"); assert.equal(first.accounting, "settled"); assert.equal(first.vectors.length, 16);
  assert.equal(first.passageIds.length, 16); assert.equal(first.sourceHash, f.state.source.sha256);
  const fields = { ...first, reference: f.args.referenceId, owner: f.args.actor._id }; delete fields.save;
  const persisted = new AssistantEmbeddingBatch(fields);
  assert.equal(persisted.validateSync(), undefined); assert.equal(persisted.vectors[0].length, embeddingProfile.dimensions);
  const again = await f.run({ price: { ...price, validUntil: "2020-01-01" } });
  assert.deepEqual(again.vectors, first.vectors); assert.equal(f.state.calls, 1); assert.equal(f.state.settlements, 1);
  await f.run({ start: 16 }); assert.equal(f.state.calls, 2); assert.equal(f.state.batches[1].passageIds.length, 1);
});

test("concurrent calls for the same source/batch admit only one request in the serialized fixture", async () => {
  const f = fixture(); let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.state.respond = async input => { await pending; return { vectors: input.map(vector), usage }; };
  const first = f.run();
  for (let count = 0; count < 10 && !f.state.calls; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.calls, 1);
  const second = await f.run(); assert.equal(second.status, "dispatching"); assert.equal(f.state.calls, 1);
  release(); assert.equal((await first).status, "completed"); assert.equal(f.state.reservations, 1);
});

test("unknown timeout and crash/failed-save checkpoints retain exposure and never automatically replay", async () => {
  for (const mode of ["timeout", "commit"]) {
    const f = fixture();
    if (mode === "timeout") f.state.respond = () => { throw new AssistantProviderError("timeout", { chargeExposure: "unknown" }); };
    else f.state.failSave = true;
    if (mode === "commit") await assert.rejects(f.run(), /fictional commit failure/);
    else assert.equal((await f.run()).status, "uncertain");
    assert.equal(f.state.reserved, 2622); assert.equal(f.state.settlements, 0);
    const again = await f.run(); assert.equal(again.status, mode === "commit" ? "dispatching" : "uncertain");
    assert.equal(f.state.calls, 1); assert.equal(f.state.reservations, 1);
  }
});

test("known billable malformed responses settle once without publishing vectors or paid replay", async () => {
  const f = fixture();
  f.state.respond = () => ({ vectors: [[NaN]], usage });
  const row = await f.run(); assert.equal(row.status, "failed"); assert.equal(row.accounting, "settled");
  assert.equal(row.vectors, undefined); assert.equal(f.state.spent, 2); assert.equal(f.state.reserved, 0);
  await f.run(); assert.equal(f.state.calls, 1); assert.equal(f.state.settlements, 1);
});

test("explicit pre-dispatch adapter failure releases reservation; arbitrary exceptions remain uncertain", async () => {
  for (const knownFree of [true, false]) {
    const f = fixture(); f.state.respond = () => { throw knownFree ? new AssistantProviderError("cancelled") : new Error("private failure"); };
    const row = await f.run(); assert.equal(row.status, knownFree ? "failed" : "uncertain");
    assert.equal(f.state.reserved, knownFree ? 0 : 2622); assert.equal(row.vectors, undefined);
    assert.equal(row.failureCode, knownFree ? "cancelled" : "embedding_provider_failed");
  }
});

test("permission, feature gates, source/manifest identity and batch bounds fail before reservation/dispatch", async () => {
  const cases = [f => ({ actor: { ...f.args.actor, role: "admin" } }), f => ({ actor: referenceActor() }),
    () => ({ shared: { ...testPolicy(), enabled: false } }), () => ({ referenceConfig: { enabled: false } }),
    () => ({ manifest: Buffer.from("changed") }), () => ({ start: 1 }), () => ({ start: 32 }),
    () => ({ timeoutMs: 30001 }), () => ({ signal: AbortSignal.abort() }),
    f => { f.state.source.status = "disabled"; return {}; },
    f => { f.state.source.passageVersion = "wrong"; return {}; },
    f => { f.state.disableBeforeAdmission = true; return {}; },
    f => { f.state.denyBudget = true; return {}; }];
  for (const patch of cases) {
    const f = fixture(); await assert.rejects(f.run(patch(f)));
    assert.equal(f.state.calls, 0); assert.equal(f.state.reservations, 0); assert.equal(f.state.batches.length, 0);
  }
});

test("disabling an in-flight source does not lose known cost or make saved vectors eligible for retrieval", async () => {
  const f = fixture(); f.state.respond = input => {
    f.state.source.status = "disabled";
    return { vectors: input.map(vector), usage };
  };
  assert.equal((await f.run()).status, "completed"); assert.equal(f.state.spent, 2);
  assert.equal(f.state.source.status, "disabled");
  await assert.rejects(f.run(), { code: "embedding_source_unavailable" }); assert.equal(f.state.calls, 1);
});

test("actual embedding adapter over loopback is reserved before HTTP and never replays a 429 or completed request", async t => {
  let active, status = 200, requests = 0;
  const server = createServer(async (req, res) => {
    requests++; assert.equal(active.state.batches[0].status, "dispatching"); assert.equal(active.state.reservations, 1);
    assert.equal(req.headers.authorization, undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, embeddingProfile.model); assert.equal(body.input.length, 16);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { object: "list", model: embeddingProfile.model,
      data: body.input.map((_, index) => ({ object: "embedding", index, embedding: vector() })),
      usage: { prompt_tokens: 100, total_tokens: 100 } } : { error: { message: "fictional rate limit" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const adapter = createOpenAIEmbeddingsAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/embeddings` });
  for (status of [200, 429]) {
    active = fixture(); const row = await active.run({ adapter });
    assert.equal(row.status, status === 200 ? "completed" : "uncertain");
    assert.equal(row.accounting, status === 200 ? "settled" : "reserved");
    await active.run({ adapter });
  }
  assert.equal(requests, 2);
});
