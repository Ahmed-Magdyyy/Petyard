import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { approvedReference, createApprovedReferenceSearch } from "../../../src/domains/assistant/references/assistant.reference-search.js";
import { referenceVectorIndex } from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { referencePassageVersion } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { referenceEmbeddingBatchKey } from "../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { referencePassageDocumentId } from "../../../src/domains/assistant/references/assistant.reference-projection.js";
import { queryEmbeddingIdentity } from "../../../src/domains/assistant/customer/assistant.query-embedding.js";

function source(species = ["cat"]) {
  const row = { _id: String(new mongoose.Types.ObjectId()), title: "Fictional approved source", species, status: "ready", stage: "ready",
    sourceStored: true, sha256: "a".repeat(64), passageHash: "b".repeat(64), passageVersion: referencePassageVersion,
    passageCount: 1, storedPassageCount: 1, version: 5 };
  row.activation = { sourceHash: row.sha256, manifestHash: row.passageHash, actor: "c".repeat(24), at: new Date(), reviewedVersion: 4 };
  row.searchVerification = { model: "text-embedding-3-large", dimensions: 1536, manifestHash: row.passageHash, passageCount: 1, indexId: "fixture-index", indexName: referenceVectorIndex.name,
    indexVersion: 1, verifiedAt: new Date() };
  return row;
}

test("Small or unidentified coverage proof cannot authorize Large reference search", () => {
  for (const proof of [{ model: "text-embedding-3-small" }, { model: undefined }, { dimensions: undefined }, { dimensions: 3072 }]) {
    const row = source(); Object.assign(row.searchVerification, proof); assert.equal(approvedReference(row), false);
  }
  assert.equal(approvedReference(source()), true);
});
function candidate(row) {
  const batchKey = referenceEmbeddingBatchKey(row._id, row.passageHash, 0), passageId = "d".repeat(64);
  return { _id: referencePassageDocumentId(batchKey, passageId), reference: row._id, manifestHash: row.passageHash, sourceHash: row.sha256,
    passageId, batchKey, model: "text-embedding-3-large", dimensions: 1536, text: "Fictional care evidence.", locator: "PDF page 1, excerpt 1", score: 0.9 };
}
function fixture() {
  const row = source();
  const scope = { audience: "customer", ownerId: "1".repeat(24), runId: "2".repeat(24), subjectId: "pet:" + "3".repeat(24),
    contextVersion: 0, generation: 0, phase: "resolve", species: "cat", profileFingerprint: "4".repeat(64), query: "General care question" };
  const identity = queryEmbeddingIdentity(scope), vector = Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);
  const state = { rows: [row], found: [candidate(row)], reads: 0, queries: 0, indexReads: 0, indexId: "fixture-index", indexVersion: 1 };
  const sources = { find(filter) {
    state.reads++;
    return { sort() { return this; }, limit(count) { assert.equal(count, 1001); return this; }, maxTimeMS(ms) { assert.equal(ms, 5000); return this; },
      async lean() {
        return state.rows.filter(row => row.status === filter.status && row.stage === filter.stage && row.sourceStored && !row.indexingBlocked &&
          (!filter.species || row.species.some(species => filter.species.$in.includes(species))) && (!filter._id || filter._id.$in.map(String).includes(String(row._id))))
          .slice(0, 1001).map(row => structuredClone(row));
      } };
  } };
  const search = createApprovedReferenceSearch({ sources, ensureStore: async () => {}, ensureIndex: async () => {
    state.indexReads++; if (state.indexReads % 2 === 0 && state.beforeFresh) state.beforeFresh();
    return { id: state.indexId, name: referenceVectorIndex.name, version: state.indexVersion };
  }, collection: { aggregate(pipeline, options) {
    state.queries++; const vectorSearch = pipeline[0].$vectorSearch;
    assert.equal(vectorSearch.limit, 12); assert.equal(vectorSearch.numCandidates, 240); assert.deepEqual(vectorSearch.queryVector, vector);
    assert.equal(options.maxTimeMS, 5000); assert.equal(options.readPreference, "primary");
    const filters = vectorSearch.filter.$and; assert.ok(filters[0].species.$in.includes("cat"));
    assert.deepEqual(filters[1].$or, state.expectedAllowed ?? [{ reference: row._id, manifestHash: row.passageHash }]);
    assert.equal(pipeline[1].$project.vector, undefined);
    return { async toArray() { if (state.afterSearch) state.afterSearch(); return state.found; } };
  } } });
  const query = { status: "completed", accounting: "settled", receiptKey: identity.key, queryContextHash: identity.queryContextHash, vector };
  return { state, row, scope, query, search, run: patch => search.search({ scope, query, ...patch }) };
}

test("preparation may detect another species' approved library but actual search remains species-filtered", async () => {
  const f = fixture(); f.state.rows = [source(["dog"])];
  assert.equal(await f.search.hasEligibleSources(f.scope), false);
  assert.equal(await f.search.hasEligibleSources(f.scope, { anySpecies: true }), true);
  assert.deepEqual(await f.run(), []); assert.equal(f.state.queries, 0);
});

test("search pre-filters approved generations and emits only the bounded evidence contract", async () => {
  const f = fixture(), dog = source(["dog"]), unapproved = source(); unapproved.activation = undefined;
  f.state.rows.push(dog, unapproved);
  assert.equal(await f.search.hasEligibleSources(f.scope), true);
  f.state.indexReads = 0;
  const passages = await f.run(); assert.equal(passages.length, 1);
  assert.equal(passages[0].version, f.row.passageHash); assert.equal(passages[0].reviewed, true);
  assert.deepEqual(Object.keys(passages[0]).sort(), ["excerpt", "locator", "reviewed", "sourceId", "species", "title", "version"]);
  assert.doesNotMatch(JSON.stringify(passages), /batchKey|sourceHash|vector|score|indexVersion/);
});

test("a ready label without matching approval cannot supply evidence or cause a vector query", async () => {
  for (const mutate of [row => { row.activation = undefined; }, row => { row.activation.manifestHash = "e".repeat(64); },
    row => { row.searchVerification.passageCount = 2; }, row => { row.activation.reviewedVersion = row.version; },
    row => { row.indexingBlocked = true; }, row => { row.status = "disabled"; }]) {
    const f = fixture(); mutate(f.row); assert.equal(approvedReference(f.row), false);
    assert.equal(await f.search.hasEligibleSources(f.scope), false); assert.deepEqual(await f.run(), []); assert.equal(f.state.queries, 0);
  }
});

test("search refuses a foreign, unsettled or malformed query embedding before reading sources", async () => {
  for (const patch of [{ receiptKey: "wrong" }, { queryContextHash: "wrong" }, { accounting: "reserved" }, { status: "uncertain" },
    { vector: [] }, { vector: Array(1536).fill(0) }, { vector: [NaN] }]) {
    const f = fixture(); await assert.rejects(f.run({ query: { ...f.query, ...patch } }), { code: "reference_query_unavailable" });
    assert.equal(f.state.reads, 0); assert.equal(f.state.queries, 0);
  }
});

test("disable or generation changes during search are discarded by the final source read", async () => {
  for (const mutate of [row => { row.status = "disabled"; row.version++; }, row => { row.passageHash = "e".repeat(64); },
    row => { row.version++; }]) {
    const f = fixture(); f.state.beforeFresh = () => mutate(f.row);
    assert.deepEqual(await f.run(), []);
  }
});

test("malformed, foreign and stale candidates never become evidence; duplicates are removed", async () => {
  const mutations = [row => { row.manifestHash = "e".repeat(64); }, row => { row.sourceHash = "e".repeat(64); },
    row => { row.reference = "f".repeat(24); }, row => { row.model = "wrong"; }, row => { row._id = "wrong"; },
    row => { row.text = "x".repeat(2001); }, row => { row.locator = "bad\u0000location"; }, row => { row.score = NaN; }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.state.found[0]); assert.deepEqual(await f.run(), []);
  }
  const f = fixture(); f.state.found.push({ ...f.state.found[0] }, { ...f.state.found[0], locator: "Different locator" }); assert.equal((await f.run()).length, 1);
});

test("an index rebuilt or replaced after approval cannot reuse the old source coverage receipt", async () => {
  for (const change of [state => { state.indexVersion = 2; }, state => { state.indexId = "replacement-index"; }]) {
    const f = fixture(); change(f.state);
    assert.equal(await f.search.hasEligibleSources(f.scope), false); assert.deepEqual(await f.run(), []); assert.equal(f.state.queries, 0);
  }
});

test("multiple approved books retain their exact source/version pairs and ranking order", async () => {
  const f = fixture(), second = source(); second.passageHash = "e".repeat(64);
  second.activation.manifestHash = second.passageHash; second.searchVerification.manifestHash = second.passageHash;
  f.state.rows.push(second); f.state.found = [candidate(second), candidate(f.row)];
  f.state.expectedAllowed = f.state.rows.map(row => ({ reference: row._id, manifestHash: row.passageHash }));
  const result = await f.run(); assert.deepEqual(result.map(passage => passage.sourceId), [second._id, f.row._id]);
  assert.deepEqual(result.map(passage => passage.version), [second.passageHash, f.row.passageHash]);
});

test("rebuild, cancellation and oversized source sets fail closed", async () => {
  const rebuilt = fixture(); rebuilt.state.afterSearch = () => { rebuilt.state.indexVersion++; };
  await assert.rejects(rebuilt.run(), { code: "reference_search_changed" });
  const cancelled = fixture(); await assert.rejects(cancelled.run({ signal: AbortSignal.abort() }), { code: "reference_search_cancelled" });
  assert.equal(cancelled.state.queries, 0);
  const capacity = fixture(); capacity.state.rows = Array.from({ length: 1001 }, () => source());
  await assert.rejects(capacity.search.hasEligibleSources(capacity.scope), { code: "reference_retrieval_capacity" });
  assert.equal(capacity.state.queries, 0);
});
