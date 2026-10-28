import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createReferenceCoverageVerifier } from "../../../src/domains/assistant/references/assistant.reference-coverage.js";
import { prepareReferencePassages } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { referenceEmbeddingBatchKey } from "../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { referencePassageDocumentId } from "../../../src/domains/assistant/references/assistant.reference-projection.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { referenceVectorIndex } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";

function fixture() {
  const source = { _id: new mongoose.Types.ObjectId(), sha256: "a".repeat(64), title: "Fictional reference", species: ["cat"],
    status: "processing", stage: "awaiting_search", sourceStored: true, storedPassageCount: 17 };
  const prepared = prepareReferencePassages(source, { sha256: source.sha256,
    units: Array.from({ length: 17 }, (_, index) => ({ locator: `PDF page ${index + 1}`, text: `Fictional case ${index}.` })) },
    { maxPages: 20, maxTextBytes: 10000 });
  const manifest = Buffer.from(JSON.stringify(prepared));
  Object.assign(source, { passageHash: sourceHash(manifest), passageCount: prepared.passages.length, passageVersion: prepared.version });
  const ids = prepared.passages.map((passage, index) => ({ _id: referencePassageDocumentId(
    referenceEmbeddingBatchKey(source._id, source.passageHash, Math.floor(index / 16) * 16), passage.id) }));
  const vector = Array.from({ length: embeddingProfile.dimensions }, (_, index) => index ? 0 : 0.5);
  const state = { stored: structuredClone(ids), found: structuredClone(ids).reverse(), vector, reads: 0, indexReads: 0,
    identity: { id: "fictional-index-id", name: referenceVectorIndex.name, version: 3 } };
  const collection = {
    find(filter, options) {
      state.reads++; assert.equal(String(filter.reference), String(source._id)); assert.equal(filter.manifestHash, source.passageHash);
      assert.equal(filter.model, embeddingProfile.model); assert.equal(filter.dimensions, embeddingProfile.dimensions);
      assert.deepEqual(filter._id.$in, ids.map(row => row._id));
      assert.equal(options.limit, 18); assert.equal(options.readConcern.level, "majority");
      assert.deepEqual(options.projection, { _id: 1 }); assert.equal(options.maxTimeMS, 5000);
      return { async toArray() { return state.stored; } };
    },
    async findOne(filter, options) {
      state.reads++; assert.equal(filter._id, ids[0]._id); assert.equal(filter.manifestHash, source.passageHash);
      assert.deepEqual(options.projection, { vector: 1 }); return { vector: state.vector };
    },
    aggregate(pipeline, options) {
      state.reads++; const search = pipeline[0].$vectorSearch;
      assert.equal(search.index, referenceVectorIndex.name); assert.equal(search.path, "vector"); assert.equal(search.exact, true);
      assert.equal(search.numCandidates, undefined); assert.equal(search.limit, 18); assert.deepEqual(search.queryVector, vector);
      assert.equal(String(search.filter.reference), String(source._id)); assert.equal(search.filter.manifestHash, source.passageHash);
      assert.deepEqual(Object.keys(search.filter).sort(), ["manifestHash", "reference"]);
      assert.deepEqual(pipeline[1], { $project: { _id: 1 } }); assert.equal(options.maxTimeMS, 5000);
      assert.equal(options.readPreference, "primary"); assert.equal(options.readConcern, undefined);
      return { async toArray() { if (state.afterSearch) state.afterSearch(); return state.found; } };
    },
  };
  const verify = createReferenceCoverageVerifier({ collection, now: () => new Date("2026-10-25T12:00:00Z"), ensureIndex: async () => {
    state.indexReads++; if (state.indexUnavailable) throw Object.assign(new Error("fictional index unavailable"), { code: "reference_vector_index_unavailable" });
    return { ...state.identity };
  } });
  return { source, manifest, state, verify, run: options => verify(source, manifest, options) };
}

test("coverage compares every prepared ID through canonical storage and exact filtered vector search without embeddings", async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(result, { model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, manifestHash: f.source.passageHash, indexId: "fictional-index-id", indexName: referenceVectorIndex.name,
    indexVersion: 3, passageCount: 17, verifiedAt: new Date("2026-10-25T12:00:00Z") });
  assert.equal(f.state.reads, 3); assert.equal(f.state.indexReads, 2); assert.equal(f.source.status, "processing");
  assert.equal(f.source.searchVerification, undefined);
});

test("fresh approval verification accepts a prepared source awaiting a SuperAdmin decision", async () => {
  const f = fixture(); f.source.status = "needs_review"; f.source.stage = "awaiting_approval";
  assert.equal((await f.run()).manifestHash, f.source.passageHash); assert.equal(f.state.reads, 3);
  assert.equal(f.source.status, "needs_review");
});

test("an already approved source can verify rebuilt-index coverage without changing its approval", async () => {
  const f = fixture(); Object.assign(f.source, { status: "ready", stage: "ready", version: 5 });
  f.source.activation = { sourceHash: f.source.sha256, manifestHash: f.source.passageHash,
    actor: new mongoose.Types.ObjectId(), at: new Date(), reviewedVersion: 4 };
  f.source.searchVerification = { model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, manifestHash: f.source.passageHash, passageCount: 17, indexId: "old-index",
    indexName: referenceVectorIndex.name, indexVersion: 1, verifiedAt: new Date() };
  const approval = JSON.stringify(f.source.activation); assert.equal((await f.run()).indexVersion, 3);
  assert.equal(JSON.stringify(f.source.activation), approval); assert.equal(f.source.searchVerification.indexId, "old-index");
  f.source.activation.sourceHash = "f".repeat(64); f.state.reads = 0;
  await assert.rejects(f.run(), { code: "reference_indexing_invalid" }); assert.equal(f.state.reads, 0);
});

test("equal counts cannot hide missing, duplicated, foreign or extra Search identities", async () => {
  for (const mutate of [state => state.found.pop(), state => { state.found[0] = { ...state.found[1] }; },
    state => { state.found[0] = { _id: "f".repeat(64) }; }, state => state.found.push({ _id: "f".repeat(64) })]) {
    const f = fixture(); mutate(f.state); await assert.rejects(f.run(), { code: "reference_search_incomplete" });
    assert.equal(f.source.searchVerification, undefined);
  }
});

test("missing canonical rows and invalid seed vectors fail before Search", async () => {
  for (const mutate of [state => state.stored.pop(), state => { state.stored[0] = { _id: "f".repeat(64) }; },
    state => { state.vector = []; }, state => { state.vector[0] = NaN; }, state => { state.vector.fill(0); }]) {
    const f = fixture(); mutate(f.state); await assert.rejects(f.run(), { code: "reference_projection_incomplete" });
    assert.ok(f.state.reads < 3);
  }
});

test("index replacement or rebuild during the probe invalidates its result", async () => {
  for (const change of [state => { state.identity.id = "replacement-index"; }, state => { state.identity.version++; },
    state => { state.identity.name = "different-index"; }, state => { state.indexUnavailable = true; }]) {
    const f = fixture(); f.state.afterSearch = () => change(f.state);
    await assert.rejects(f.run(), { code: "reference_vector_index_unavailable" }); assert.equal(f.source.searchVerification, undefined);
  }
});

test("disabled, blocked, incomplete, mismatched or malformed sources cannot issue a coverage query", async () => {
  for (const change of [f => { f.source.status = "disabled"; }, f => { f.source.indexingBlocked = true; },
    f => { f.source.storedPassageCount = 16; }, f => { f.source.passageHash = "f".repeat(64); },
    f => { f.source.stage = "awaiting_index"; }]) {
    const f = fixture(); change(f); await assert.rejects(f.run()); assert.equal(f.state.reads, 0);
  }
  const f = fixture(), prepared = JSON.parse(f.manifest); prepared.passages[1].id = prepared.passages[0].id;
  const manifest = Buffer.from(JSON.stringify(prepared)); f.source.passageHash = sourceHash(manifest);
  await assert.rejects(f.verify(f.source, manifest), { code: "embedding_manifest_invalid" }); assert.equal(f.state.reads, 0);
});

test("cancelled or interrupted verification cannot return a successful receipt", async () => {
  const f = fixture(); await assert.rejects(f.run({ signal: AbortSignal.abort() }), { code: "reference_search_cancelled" });
  assert.equal(f.state.reads, 0);
  const late = fixture(), controller = new AbortController(); late.state.afterSearch = () => controller.abort();
  await assert.rejects(late.run({ signal: controller.signal }), { code: "reference_search_cancelled" });
  assert.equal(late.source.searchVerification, undefined);
});
