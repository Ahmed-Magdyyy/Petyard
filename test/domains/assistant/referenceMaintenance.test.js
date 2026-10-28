import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceCoverageRefresher } from "../../../src/domains/assistant/references/assistant.reference-indexer.js";
import { createReferenceWorker } from "../../../src/domains/assistant/references/assistant.reference-worker.js";
import { AssistantReference } from "../../../src/domains/assistant/references/assistant.reference.model.js";
import { approvedReference } from "../../../src/domains/assistant/references/assistant.reference-search.js";
import { referenceCanRefreshCoverage } from "../../../src/domains/assistant/references/assistant.reference-coverage.js";
import { referenceVectorIndex } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { AssistantEmbeddingBatch } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { removeExpiredQueryVectors } from "../../../src/domains/assistant/customer/assistant.query-embedding.js";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { drainAssistantWork } from "../../../src/domains/assistant/assistant.runtime.js";
import { referenceMemory, referenceActor, referenceBody, referenceFile, referenceTestConfig } from "./fixtures/referenceMemory.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

async function fixture() {
  const f = referenceMemory(), config = referenceTestConfig(), actor = referenceActor();
  await f.application.upload(actor, referenceBody(), referenceFile(), config);
  const worker = f.worker(); worker.start(config); await worker.idle();
  const row = f.state.rows[0]; row.status = "ready"; row.stage = "ready"; row.version++;
  row.storedPassageCount = row.passageCount;
  row.activation = { sourceHash: row.sha256, manifestHash: row.passageHash, actor: actor._id, at: new Date(f.state.time), reviewedVersion: row.version - 1 };
  row.searchVerification = { model: "text-embedding-3-large", dimensions: 1536, manifestHash: row.passageHash, indexId: "old-index", indexName: referenceVectorIndex.name,
    indexVersion: 1, passageCount: row.passageCount, verifiedAt: new Date(f.state.time) };
  Object.assign(f.state, { checks: 0, verifications: 0, index: { id: "new-index", name: referenceVectorIndex.name, version: 2 } });
  const refresh = createReferenceCoverageRefresher({ ...f.dependencies,
    ensureIndex: async () => { f.state.checks++; if (f.state.noIndex) throw new Error("Fictional index unavailable"); return f.state.index; },
    verifyCoverage: async (source, manifest, { signal }) => {
      f.state.verifications++; assert.equal(referenceCanRefreshCoverage(source), true);
      assert.equal(manifest.equals(f.state.objects.get(row.passageKey)), true); assert.equal(signal.aborted, false);
      await f.state.beforeCoverage?.();
      if (f.state.failure) throw Object.assign(new Error("Fictional coverage failure"), { code: f.state.failure });
      return { model: "text-embedding-3-large", dimensions: 1536, manifestHash: source.passageHash, indexId: f.state.index.id, indexName: f.state.index.name,
        indexVersion: f.state.index.version, passageCount: source.passageCount, verifiedAt: new Date(f.state.time) };
    } });
  const controller = new AbortController(), shared = { enabled: true };
  return { ...f, config, row, refresh, controller, shared,
    run: () => refresh(config, shared, controller.signal), advance() { f.state.time = new Date(f.state.time.getTime() + 60_001); } };
}

test("an index rebuild refreshes stored coverage without changing human approval or generating new vectors", async t => {
  const f = await fixture(), approval = JSON.stringify(f.row.activation), version = f.row.version;
  t.mock.method(globalThis, "fetch", () => { throw new Error("No provider or storage HTTP is permitted"); });
  assert.equal(approvedReference(f.row, f.state.index), false); await f.run();
  assert.equal(approvedReference(f.row, f.state.index), true); assert.equal(f.row.status, "ready"); assert.equal(f.row.stage, "ready");
  assert.equal(JSON.stringify(f.row.activation), approval); assert.equal(f.row.version, version + 1); assert.equal(f.state.verifications, 1);
  assert.equal(f.row.searchVerification.indexId, "new-index"); assert.ok(f.row.indexingRetryAt > f.state.time);
  assert.equal(new AssistantReference(f.row).validateSync(), undefined);
});

test("unchanged indexes avoid manifest reads, coverage queries and public revision changes for 60 seconds", async () => {
  const f = await fixture(); f.state.index = { id: "old-index", name: referenceVectorIndex.name, version: 1 };
  const version = f.row.version, reads = f.state.reads; await f.run(); await f.run();
  assert.equal(f.state.checks, 1); assert.equal(f.state.verifications, 0); assert.equal(f.state.reads, reads); assert.equal(f.row.version, version);
  f.advance(); await f.run(); assert.equal(f.state.checks, 2); assert.equal(f.row.version, version);
});

test("search lag and unavailable indexes defer coverage while preserving approval and refusing current retrieval", async () => {
  for (const mode of ["lag", "index"]) {
    const f = await fixture(), approval = JSON.stringify(f.row.activation);
    if (mode === "lag") f.state.failure = "reference_search_incomplete"; else f.state.noIndex = true;
    await f.run(); assert.equal(f.row.failureCode, "reference_search_wait"); assert.equal(f.row.indexingBlocked, false);
    assert.equal(approvedReference(f.row), false); assert.equal(referenceCanRefreshCoverage(f.row), true);
    const checks = f.state.checks; await f.run(); assert.equal(f.state.checks, checks);
    f.advance(); f.state.failure = null; f.state.noIndex = false; await f.run();
    assert.equal(approvedReference(f.row, f.state.index), true); assert.equal(JSON.stringify(f.row.activation), approval);
  }
});

test("source integrity failures pause automatic coverage without reapproval or paid retries", async () => {
  const f = await fixture(); f.state.failure = "embedding_manifest_invalid"; await f.run();
  assert.equal(f.row.indexingBlocked, true); assert.equal(f.row.failureCode, "reference_indexing_invalid");
  assert.equal(approvedReference(f.row), false); f.advance(); await f.run(); assert.equal(f.state.verifications, 1);
});

test("disable, generation change or lease expiry cannot be overwritten by a late successful coverage result", async () => {
  for (const mode of ["disable", "generation", "expiry"]) {
    const f = await fixture(), original = structuredClone(f.row.searchVerification);
    f.state.beforeCoverage = async () => {
      if (mode === "disable") await f.application.disable(referenceActor(), f.row._id, { expectedVersion: f.row.version }, f.config);
      else if (mode === "generation") { f.row.version++; f.row.passageHash = "f".repeat(64); }
      else f.state.time = new Date(f.row.leaseUntil.getTime() + 1);
    };
    await f.run(); assert.deepEqual(f.row.searchVerification, original);
    assert.equal(f.row.status, mode === "disable" ? "disabled" : "ready");
  }
});

test("cancelled refreshes do not publish a late receipt or erase approval", async () => {
  const f = await fixture(), original = structuredClone(f.row.searchVerification), approval = JSON.stringify(f.row.activation);
  f.state.beforeCoverage = async () => f.controller.abort(); await f.run();
  assert.deepEqual(f.row.searchVerification, original); assert.equal(JSON.stringify(f.row.activation), approval); assert.equal(f.row.lease, null);
  assert.equal(f.row.failureCode, null); assert.ok(f.row.indexingRetryAt > f.state.time);
});

test("the existing worker refreshes coverage even when paid indexing is disabled", async () => {
  const f = await fixture(); let paid = 0;
  const worker = createReferenceWorker({ ...f.dependencies, refreshCoverage: f.refresh,
    indexOne: async (_config, _shared, indexing) => { assert.equal(indexing.enabled, false); paid++; } });
  worker.start(f.config, { shared: f.shared, indexing: { enabled: false } }); await worker.idle();
  assert.equal(f.state.verifications, 1); assert.equal(approvedReference(f.row, f.state.index), true); assert.equal(paid, 1);
});

test("queued extraction cannot starve approved-source coverage refresh", async () => {
  const f = await fixture(), file = referenceFile(); file.buffer = Buffer.from("# A different fictional care document");
  await f.application.upload(referenceActor(), referenceBody(), file, f.config);
  const queued = f.state.rows[1]; assert.equal(queued.stage, "queued");
  const worker = createReferenceWorker({ ...f.dependencies, refreshCoverage: f.refresh });
  worker.start(f.config, { shared: f.shared, indexing: { enabled: false } }); await worker.idle();
  assert.equal(f.state.verifications, 1); assert.equal(approvedReference(f.row, f.state.index), true);
  assert.equal(queued.stage, "awaiting_index");
});

function retentionFixture(t) {
  const now = new Date(), rows = [
    { kind: "customer_query", vectorsExpireAt: new Date(now.getTime() - 1), vectors: [[0.5]], accounting: "settled", key: "settled-key", chargedMicroUsd: 3 },
    { kind: "customer_query", vectorsExpireAt: new Date(now.getTime() - 1), vectors: [[0.5]], accounting: "reserved", key: "uncertain-key", reservation: { amount: 10 } },
    { kind: "customer_query", vectorsExpireAt: new Date(now.getTime() + 60000), vectors: [[0.5]], accounting: "settled", key: "unexpired-key" },
    { kind: "reference", vectorsExpireAt: new Date(0), vectors: [[0.5]], accounting: "settled", key: "reference-key" },
  ];
  const f = { rows, updates: 0, indexes: [{ key: { key: 1 }, unique: true }, { key: { kind: 1, vectorsExpireAt: 1 } }] };
  t.mock.method(AssistantEmbeddingBatch.collection, "indexes", async () => f.indexes);
  t.mock.method(AssistantEmbeddingBatch, "updateMany", async (filter, update, options) => {
    assert.deepEqual(update, { $unset: { vectors: 1 } }); assert.equal(options.maxTimeMS, 5000); f.updates++;
    const selected = rows.filter(row => matchesQuery(row, filter)); for (const row of selected) delete row.vectors;
    return { modifiedCount: selected.length };
  });
  return f;
}

test("periodic retention removes only expired customer vectors and preserves every financial record", async t => {
  const f = retentionFixture(t), before = structuredClone(f.rows);
  const result = await removeExpiredQueryVectors({ referenceRetentionEnabled: true }); assert.deepEqual(result, { enabled: true, removed: 2 });
  assert.equal(f.rows[0].vectors, undefined); assert.equal(f.rows[1].vectors, undefined); assert.ok(f.rows[2].vectors); assert.ok(f.rows[3].vectors);
  for (let index = 0; index < 2; index++) { const expected = { ...before[index] }; delete expected.vectors; assert.deepEqual(f.rows[index], expected); }
  assert.deepEqual(await removeExpiredQueryVectors({ referenceRetentionEnabled: true }), { enabled: true, removed: 0 });
});

test("retention runs on a worker poll with chat disabled and without keys, a query or a new feature flag", async t => {
  const f = retentionFixture(t), config = loadAssistantConfig({ ASSISTANT_REFERENCES_ENABLED: "true" });
  assert.deepEqual(config, { enabled: false, referenceRetentionEnabled: true });
  const result = await drainAssistantWork({ getConfig: () => config });
  assert.deepEqual(result, { enabled: false, processed: 0, failed: 0, queryVectorRetention: { enabled: true, removed: 2 } });
  assert.equal(f.updates, 1);
});

test("retention is default-off and missing safe store setup fails in isolation without erasing anything", async t => {
  const f = retentionFixture(t); assert.deepEqual(await removeExpiredQueryVectors({}), { enabled: false }); assert.equal(f.updates, 0);
  f.indexes.pop(); const result = await drainAssistantWork({ getConfig: () => ({ enabled: false, referenceRetentionEnabled: true }) });
  assert.equal(result.failed, 1); assert.equal(result.queryVectorRetention.failed, 1); assert.equal(f.updates, 0);
  assert.ok(f.rows.every(row => row.vectors));
});
