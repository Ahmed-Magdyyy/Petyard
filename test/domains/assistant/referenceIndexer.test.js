import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceIndexer } from "../../../src/domains/assistant/references/assistant.reference-indexer.js";
import { createReferenceWorker } from "../../../src/domains/assistant/references/assistant.reference-worker.js";
import { loadReferenceIndexingConfig } from "../../../src/domains/assistant/references/assistant.reference-config.js";
import { AssistantError } from "../../../src/domains/assistant/shared/assistant.errors.js";
import { referenceDto } from "../../../src/domains/assistant/references/assistant.reference-service.js";
import { AssistantReference } from "../../../src/domains/assistant/references/assistant.reference.model.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";
import { referenceMemory, referenceActor, referenceBody, referenceFile, referenceTestConfig } from "./fixtures/referenceMemory.js";

const now = new Date("2026-10-25T12:00:00Z");
const price = { version: "synthetic-indexer-price", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
  inputMicroUsdPerMillion: 20000, validFrom: "2026-10-24T00:00:00Z", validUntil: "2026-11-01T00:00:00Z" };
const shared = testPolicy({ enabled: true });
const indexing = { enabled: true, price, timeoutMs: 1000 };

async function fixture() {
  const memory = referenceMemory(), { state, model } = memory, actor = referenceActor(); state.time = new Date(now);
  const config = referenceTestConfig(); config.limits.maxPages = 20;
  await memory.application.upload(actor, referenceBody(), referenceFile(), config);
  const extraction = createReferenceWorker({ ...memory.dependencies, extract: async () => ({ sha256: state.rows[0].sha256,
    units: Array.from({ length: 17 }, (_, index) => ({ locator: `PDF page ${index + 1}`, text: `Fictional case ${index}.` })), warnings: [] }) });
  extraction.start(config); await extraction.idle();
  Object.assign(state, { storeChecks: 0, indexChecks: 0, coverageCalls: 0, adapterFactories: 0, actorReads: 0, batchCalls: [], paidRequests: 0, projections: [], saved: new Map() });
  const indexOne = createReferenceIndexer({ model, storage: memory.dependencies.storage, now: () => new Date(state.time),
    ensureStore: async () => { state.storeChecks++; }, ensureIndex: async () => {
      state.indexChecks++; if (state.noIndex) throw new AssistantError("reference_vector_index_unavailable", 503);
    }, getActor: async () => { state.actorReads++; return state.actorOverride ?? actor; },
    adapterFactory: () => { state.adapterFactories++; return { ...embeddingProfile }; },
    verifyCoverage: async (source, manifest) => {
      state.coverageCalls++; assert.equal(source.stage, "awaiting_search"); assert.ok(manifest.equals(state.objects.get(source.passageKey)));
      if (state.beforeCoverage) await state.beforeCoverage();
      if (state.searchLag) throw new AssistantError("reference_search_incomplete", 503);
      return { model: "text-embedding-3-large", dimensions: 1536, manifestHash: source.passageHash, indexId: "fictional-search-index", indexName: "petyard_reference_vector_v1",
        indexVersion: 1, passageCount: source.passageCount, verifiedAt: new Date(state.time) };
    },
    batches: { async processBatch(args) {
      assert.equal(args.actor._id, actor._id); assert.equal(args.manifest.equals(state.objects.get(state.rows[0].passageKey)), true);
      assert.equal(args.shared, shared); state.batchCalls.push(args.start);
      if (state.budgetWait) throw new AssistantError("monthly_budget_limit", 429, new Date(now.getTime() + 86400000));
      if (!state.saved.has(args.start)) { state.paidRequests++; state.saved.set(args.start, { status: "dispatching", accounting: "reserved" }); }
      if (state.beforeBatch) await state.beforeBatch(args);
      if (state.uncertain) return { status: "uncertain", accounting: "reserved" };
      if (state.knownFailure) return { status: "failed", accounting: "settled" };
      const result = { status: "completed", accounting: "settled" }; state.saved.set(args.start, result); return result;
    } }, projection: { async projectBatch(args) {
      state.projections.push(args.start);
      if (state.failProjection) throw new Error("fictional transient DB failure");
      return { passageCount: Math.min(16, state.rows[0].passageCount - args.start) };
    } } });
  const worker = createReferenceWorker({ ...memory.dependencies, indexOne });
  const run = async () => { worker.start(config, { shared, indexing }); await worker.idle(); };
  return { ...memory, actor, config, indexOne, worker, run };
}

test("indexing requires its own explicit flag and dated price while retaining the existing budget policy", () => {
  const config = referenceTestConfig(), env = { ASSISTANT_REFERENCE_INDEXING_ENABLED: "true", ASSISTANT_EMBEDDING_PRICE_JSON: JSON.stringify(price) };
  assert.deepEqual(loadReferenceIndexingConfig(config, shared, {}, now), { enabled: false });
  assert.deepEqual(loadReferenceIndexingConfig({ enabled: false }, shared, env, now), { enabled: false });
  assert.deepEqual(loadReferenceIndexingConfig(config, { enabled: false }, env, now), { enabled: false });
  assert.deepEqual(loadReferenceIndexingConfig(config, shared, env, now), indexing);
  for (const changed of [undefined, "{}", "not-json", JSON.stringify({ ...price, validUntil: "2020-01-01" }),
    JSON.stringify({ ...price, model: "wrong" }), JSON.stringify({ ...price, extraBudget: 100 })]) {
    assert.throws(() => loadReferenceIndexingConfig(config, shared, { ...env, ASSISTANT_EMBEDDING_PRICE_JSON: changed }, now));
  }
  assert.throws(() => loadReferenceIndexingConfig(config, { ...shared, monthlyBudgetMicroUsd: 50_000_001 }, env, now));
});

test("background worker processes one batch per pass and stores progress without activating the source", async () => {
  const f = await fixture(); await f.run();
  assert.equal(f.state.rows[0].storedPassageCount, 16); assert.equal(f.state.rows[0].stage, "awaiting_index");
  assert.equal(f.state.paidRequests, 1); assert.deepEqual(f.state.projections, [0]);
  await f.run();
  assert.equal(f.state.rows[0].storedPassageCount, 17); assert.equal(f.state.rows[0].stage, "awaiting_search");
  assert.equal(f.state.rows[0].status, "processing"); assert.equal(f.state.actorReads, 2); assert.equal(f.state.paidRequests, 2);
  const dto = referenceDto(f.state.rows[0]); assert.equal(dto.actions.canActivate, false); assert.equal(dto.storedPassageCount, 17);
  assert.equal(dto.indexingBlocked, false); await f.run(); assert.equal(f.state.paidRequests, 2);
  assert.equal(f.state.rows[0].status, "needs_review"); assert.equal(f.state.rows[0].stage, "awaiting_approval");
  assert.equal(f.state.coverageCalls, 1); assert.equal(f.state.adapterFactories, 2);
  assert.equal(referenceDto(f.state.rows[0]).searchVerifiedAt, now.toISOString());
  assert.equal(referenceDto(f.state.rows[0]).actions.canActivate, true);
  assert.equal(new AssistantReference(f.state.rows[0]).validateSync(), undefined);
  await f.run(); assert.equal(f.state.coverageCalls, 1);
});

test("disabled indexing does not inspect indexes, read manifests, construct providers or reserve costs", async () => {
  const f = await fixture(), reads = f.state.reads;
  f.worker.start(f.config); await f.worker.idle();
  assert.equal(f.state.indexChecks, 0); assert.equal(f.state.reads, reads); assert.equal(f.state.paidRequests, 0);
});

test("missing index and budget exhaustion defer work before spending and expose a safe next-attempt time", async () => {
  for (const mode of ["noIndex", "budgetWait"]) {
    const f = await fixture(); f.state[mode] = true; await f.run();
    assert.equal(f.state.paidRequests, 0); assert.equal(f.state.rows[0].indexingBlocked, false);
    const dto = referenceDto(f.state.rows[0]); assert.ok(dto.nextAttemptAt);
    assert.equal(dto.error.code, mode === "noIndex" ? "reference_index_wait" : "reference_embedding_budget_wait");
    const checks = f.state.indexChecks; await f.run(); assert.equal(f.state.indexChecks, checks);
    f.state[mode] = false; f.state.time = new Date(f.state.rows[0].indexingRetryAt.getTime() + 1);
    await f.run(); assert.equal(f.state.paidRequests, 1); assert.equal(f.state.rows[0].storedPassageCount, 16);
  }
});

test("unknown and failed paid batches block processing instead of automatically paying again", async () => {
  for (const mode of ["uncertain", "knownFailure"]) {
    const f = await fixture(); f.state[mode] = true; await f.run();
    assert.equal(f.state.rows[0].indexingBlocked, true); assert.equal(f.state.rows[0].storedPassageCount ?? 0, 0);
    assert.equal(f.state.rows[0].failureCode, mode === "uncertain" ? "reference_embedding_needs_review" : "reference_embedding_failed");
    f.state.time = new Date(now.getTime() + 86400000); await f.run(); assert.equal(f.state.paidRequests, 1);
    assert.equal(referenceDto(f.state.rows[0]).actions.canRetry, false);
  }
});

test("projection retry resumes the already completed batch without another paid request", async () => {
  const f = await fixture(); f.state.failProjection = true; await f.run();
  assert.equal(f.state.paidRequests, 1); assert.equal(f.state.rows[0].storedPassageCount ?? 0, 0);
  f.state.failProjection = false; f.state.time = new Date(f.state.rows[0].indexingRetryAt.getTime() + 1);
  await f.run(); assert.deepEqual(f.state.batchCalls, [0, 0]); assert.equal(f.state.paidRequests, 1);
  assert.equal(f.state.rows[0].storedPassageCount, 16);
});

test("current uploader permission and invalid saved progress stop indexing before spending", async () => {
  const f = await fixture(); f.state.actorOverride = { ...f.actor, role: "admin" }; await f.run();
  assert.equal(f.state.paidRequests, 0); assert.equal(f.state.rows[0].failureCode, "reference_indexing_access");
  assert.equal(f.state.rows[0].indexingBlocked, true);
  const invalid = await fixture(); invalid.state.rows[0].storedPassageCount = 2; await invalid.run();
  assert.equal(invalid.state.paidRequests, 0); assert.equal(invalid.state.rows[0].failureCode, "reference_indexing_invalid");
});

test("single flight and source leases prevent two workers from indexing the same source at once", async () => {
  const f = await fixture(); let release;
  const pending = new Promise(resolve => { release = resolve; }); f.state.beforeBatch = async () => pending;
  f.worker.start(f.config, { shared, indexing });
  for (let count = 0; count < 20 && !f.state.paidRequests; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.paidRequests, 1);
  assert.equal(f.worker.start(f.config, { shared, indexing }).scheduled, false);
  await f.indexOne(f.config, shared, indexing, new AbortController().signal); assert.equal(f.state.batchCalls.length, 1);
  release(); await f.worker.idle(); assert.equal(f.state.rows[0].storedPassageCount, 16);
});

test("disable wins over a late progress update and an expired lease can safely revisit saved work", async () => {
  const f = await fixture(); f.state.beforeBatch = async () => {
    const row = f.state.rows[0]; await f.application.disable(f.actor, row._id, { expectedVersion: row.version }, f.config);
  };
  await f.run(); assert.equal(f.state.rows[0].status, "disabled"); assert.equal(f.state.rows[0].storedPassageCount ?? 0, 0);
  const resumed = await fixture(); resumed.state.rows[0].lease = "interrupted"; resumed.state.rows[0].leaseUntil = new Date(now.getTime() - 1);
  await resumed.run(); assert.equal(resumed.state.rows[0].storedPassageCount, 16);
});

test("shutdown cancellation settles through the batch seam and stops further scheduling", async () => {
  const f = await fixture(); let entered;
  const dispatched = new Promise(resolve => { entered = resolve; });
  f.state.beforeBatch = args => new Promise(resolve => {
    entered(); args.signal.addEventListener("abort", () => { f.state.uncertain = true; resolve(); }, { once: true });
  });
  f.worker.start(f.config, { shared, indexing }); await dispatched; await f.worker.stop();
  assert.equal(f.state.rows[0].failureCode, "reference_embedding_needs_review"); assert.equal(f.state.paidRequests, 1);
  assert.deepEqual(f.worker.start(f.config, { shared, indexing }), { enabled: false });
});

test("search replication waits retry without embeddings and never bypass SuperAdmin approval", async () => {
  const f = await fixture(); await f.run(); await f.run(); f.state.searchLag = true; await f.run();
  assert.equal(f.state.rows[0].stage, "awaiting_search"); assert.equal(f.state.rows[0].failureCode, "reference_search_wait");
  assert.equal(f.state.rows[0].searchVerification, undefined); assert.equal(f.state.paidRequests, 2);
  await f.run(); assert.equal(f.state.coverageCalls, 1);
  f.state.time = new Date(f.state.rows[0].indexingRetryAt.getTime() + 1); f.state.searchLag = false; await f.run();
  assert.equal(f.state.rows[0].status, "needs_review"); assert.equal(f.state.paidRequests, 2); assert.equal(f.state.adapterFactories, 2);
});

test("disable and lease expiry prevent late coverage results from publishing a reviewable source", async () => {
  for (const expired of [false, true]) {
    const f = await fixture(); await f.run(); await f.run();
    f.state.beforeCoverage = async () => {
      const source = f.state.rows[0];
      if (expired) f.state.time = new Date(source.leaseUntil.getTime() + 1);
      else await f.application.disable(f.actor, source._id, { expectedVersion: source.version }, f.config);
    };
    await f.run(); assert.equal(f.state.rows[0].searchVerification, undefined);
    assert.equal(f.state.rows[0].status, expired ? "processing" : "disabled"); assert.equal(f.state.paidRequests, 2);
  }
});
