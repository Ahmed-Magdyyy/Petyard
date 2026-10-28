import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createReferenceProjectionService } from "../../../src/domains/assistant/references/assistant.reference-projection.js";
import { AssistantReferencePassage, assertReferencePassageStore, assertReferenceVectorIndex, referenceVectorIndex }
  from "../../../src/domains/assistant/references/assistant.reference-passage.model.js";
import { prepareReferencePassages } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { referenceBatchInput, referenceEmbeddingBatchKey } from "../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { embeddingInputHash } from "../../../src/domains/assistant/references/assistant.embedding-billing.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";
import { referenceActor, referenceTestConfig } from "./fixtures/referenceMemory.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

function fixture(start = 0) {
  const actor = referenceActor(), id = String(new mongoose.Types.ObjectId()), config = referenceTestConfig();
  const source = { _id: id, creator: String(actor._id), sha256: "b".repeat(64), title: "Fictional mixed-species reference", species: ["cat", "dog"],
    status: "processing", stage: "awaiting_index", sourceStored: true, version: 3 };
  const units = Array.from({ length: 17 }, (_, index) => ({ locator: `PDF page ${index + 1}`, text: `Fictional excerpt ${index}. قطط وكلاب.` }));
  const prepared = prepareReferencePassages(source, { sha256: source.sha256, units }, { ...config.limits, maxPages: 20 });
  const manifest = Buffer.from(JSON.stringify(prepared));
  Object.assign(source, { passageHash: sourceHash(manifest), passageCount: prepared.passages.length, passageVersion: prepared.version });
  const selected = referenceBatchInput(source, manifest, start);
  const key = referenceEmbeddingBatchKey(id, source.passageHash, start);
  const state = { source, rows: [], writes: 0, setups: 0, batch: { key, reference: id, owner: String(actor._id), sourceHash: source.sha256,
    manifestHash: source.passageHash, start, batchHash: embeddingInputHash(selected.input), passageIds: selected.passageIds,
    model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, status: "completed", accounting: "settled",
    reservation: { amount: 1234 }, chargedMicroUsd: 2,
    vectors: selected.input.map((_, index) => Array.from({ length: embeddingProfile.dimensions }, (__, component) => component === index ? 0.5 : 0)) } };
  const query = get => ({ session() { return this; }, async lean() { return get(); }, then(resolve, reject) { return Promise.resolve(get()).then(resolve, reject); } });
  const references = { findById: () => query(() => structuredClone(state.source)), async updateOne(filter, update) {
    if (state.disableAtFence) state.source.status = "disabled";
    if (!matchesQuery(state.source, filter)) return { modifiedCount: 0 };
    state.source.embeddingFence = (state.source.embeddingFence ?? 0) + update.$inc.embeddingFence; return { modifiedCount: 1 };
  } };
  const batches = { findOne: filter => query(() => matchesQuery(state.batch, filter) ? structuredClone(state.batch) : null),
    async updateOne(filter, update) {
      if (state.failReceipt) throw new Error("fictional receipt failure");
      if (!matchesQuery(state.batch, filter)) return { modifiedCount: 0 };
      Object.assign(state.batch, update.$set); for (const key of Object.keys(update.$unset)) delete state.batch[key];
      return { modifiedCount: 1 };
    } };
  const passages = { countDocuments: filter => query(() => state.rows.filter(row => matchesQuery(row, filter)).length),
    async insertMany(documents, options) {
      assert.equal(options.ordered, true); assert.ok(options.session);
      for (const document of documents) {
        const model = new AssistantReferencePassage(document);
        await model.validate();
        assert.equal(state.rows.some(row => row._id === document._id), false);
        state.rows.push({ ...structuredClone(document), reference: String(document.reference) }); state.writes++;
        if (state.failInsert && state.rows.length === 3) throw new Error("fictional insert failure");
      }
    } };
  let tail = Promise.resolve();
  const service = createReferenceProjectionService({ references, batches, passages, ensureStore: async () => {},
    now: () => new Date("2026-10-25T12:00:00Z"), atomic(callback) {
      const task = tail.then(async () => {
        const before = structuredClone({ source: state.source, batch: state.batch, rows: state.rows, writes: state.writes });
        try { return await callback({ fictional: true }); } catch (error) { Object.assign(state, before); throw error; }
      }); tail = task.catch(() => {}); return task;
    } });
  const args = { actor, referenceId: id, manifest, start, referenceConfig: config };
  return { state, args, prepared, service, run: patch => service.projectBatch({ ...args, ...patch }) };
}

test("projection moves exact vectors and citation text atomically, without changing source approval or accounting", async () => {
  const f = fixture(), before = structuredClone(f.state.batch);
  const result = await f.run();
  assert.equal(result.passageCount, 16); assert.equal(result.alreadyProjected, false);
  assert.equal(f.state.rows.length, 16); assert.equal(f.state.batch.vectors, undefined); assert.ok(f.state.batch.projectedAt);
  assert.deepEqual(f.state.batch.reservation, before.reservation); assert.equal(f.state.batch.chargedMicroUsd, before.chargedMicroUsd);
  assert.equal(f.state.batch.accounting, "settled"); assert.equal(f.state.source.status, "processing"); assert.equal(f.state.source.version, 3);
  for (const [index, row] of f.state.rows.entries()) {
    assert.deepEqual(row.vector, before.vectors[index]); assert.equal(row.text, f.prepared.passages[index].text);
    assert.equal(row.locator, `PDF page ${index + 1}, excerpt 1`); assert.equal(row.reference, f.args.referenceId);
    assert.equal(row.nextId, f.prepared.passages[index].nextId); assert.deepEqual(row.species, ["cat", "dog"]);
    assert.equal(Object.hasOwn(row, "reviewed"), false); assert.equal(Object.hasOwn(row, "active"), false);
  }
  assert.equal((await f.run()).alreadyProjected, true); assert.equal(f.state.writes, 16);
});

test("partial insert or receipt failure rolls back the entire move, retaining all saved vectors for an unpaid retry", async () => {
  for (const failure of ["failInsert", "failReceipt"]) {
    const f = fixture(), original = structuredClone(f.state.batch.vectors); f.state[failure] = true;
    await assert.rejects(f.run(), /fictional/);
    assert.equal(f.state.rows.length, 0); assert.equal(f.state.batch.projectedAt, undefined); assert.deepEqual(f.state.batch.vectors, original);
    f.state[failure] = false; assert.equal((await f.run()).passageCount, 16); assert.equal(f.state.rows.length, 16);
  }
});

test("a duplicate projection is idempotent in the serialized transaction fixture", async () => {
  const f = fixture(); const results = await Promise.all([f.run(), f.run()]);
  assert.deepEqual(results.map(result => result.alreadyProjected), [false, true]); assert.equal(f.state.rows.length, 16);
});

test("the final short batch retains its original page and neighbouring passage identity", async () => {
  const f = fixture(16); assert.equal((await f.run()).passageCount, 1);
  assert.equal(f.state.rows[0].locator, "PDF page 17, excerpt 1");
  assert.equal(f.state.rows[0].previousId, f.prepared.passages[15].id); assert.equal(f.state.rows[0].nextId, null);
  assert.equal(f.state.rows[0].text, f.prepared.passages[16].text); assert.equal((await f.run()).alreadyProjected, true);
});

test("missing projected rows fail closed without trying to regenerate or charge for embeddings", async () => {
  const f = fixture(); await f.run(); f.state.rows.pop();
  await assert.rejects(f.run(), { code: "reference_projection_incomplete" }); assert.equal(f.state.writes, 16);
});

test("permission, disable, changed manifest, unsettled/uncertain batch and mismatched vector identity cannot project", async () => {
  const cases = [f => ({ actor: { ...f.args.actor, role: "admin" } }), () => ({ actor: referenceActor() }),
    () => ({ referenceConfig: { enabled: false } }), () => ({ manifest: Buffer.from("changed") }), () => ({ start: 1 }),
    f => { f.state.source.status = "disabled"; return {}; }, f => { f.state.disableAtFence = true; return {}; },
    f => { f.state.batch.accounting = "reserved"; return {}; }, f => { f.state.batch.status = "uncertain"; return {}; },
    f => { f.state.batch.batchHash = "c".repeat(64); return {}; }, f => { f.state.batch.passageIds.reverse(); return {}; },
    f => { f.state.batch.vectors[0][0] = NaN; return {}; }, f => { f.state.batch.vectors[0].fill(0); return {}; },
    f => { f.state.batch.model = "wrong-model"; return {}; }];
  for (const patch of cases) {
    const f = fixture(); await assert.rejects(f.run(patch(f)));
    assert.equal(f.state.rows.length, 0); assert.equal(f.state.batch.projectedAt, undefined);
  }
});

test("malformed citation offsets are refused even if their manifest checksum matches saved metadata", async () => {
  const f = fixture(), body = JSON.parse(f.args.manifest); body.passages[0].endOffset++;
  f.args.manifest = Buffer.from(JSON.stringify(body)); f.state.source.passageHash = sourceHash(f.args.manifest);
  f.state.batch.manifestHash = f.state.source.passageHash;
  f.state.batch.key = referenceEmbeddingBatchKey(f.args.referenceId, f.state.source.passageHash, 0);
  await assert.rejects(f.run(), { code: "embedding_manifest_invalid" }); assert.equal(f.state.rows.length, 0);
});

test("passage store checks existing indexes only and rejects missing, unique batch, partial and TTL indexes", async t => {
  const good = [{ key: { _id: 1 } }, { key: { batchKey: 1 } }]; let indexes = good;
  t.mock.method(AssistantReferencePassage.collection, "indexes", async () => indexes);
  t.mock.method(AssistantReferencePassage, "createCollection", () => assert.fail("setup forbidden"));
  t.mock.method(AssistantReferencePassage, "createIndexes", () => assert.fail("setup forbidden"));
  await assertReferencePassageStore();
  for (const bad of [[], [good[0]], [good[0], { key: { batchKey: 1 }, unique: true }],
    [good[0], { key: { batchKey: 1 }, sparse: true }], [good[0], { key: { batchKey: 1 }, partialFilterExpression: {} }],
    [...good, { key: { createdAt: 1 }, expireAfterSeconds: 10 }]]) {
    indexes = bad; await assert.rejects(assertReferencePassageStore(), { code: "reference_passage_store_unavailable" });
  }
});

function readyIndex() {
  const definition = structuredClone(referenceVectorIndex.definition);
  return { id: "fictional-index-id", name: referenceVectorIndex.name, type: "vectorSearch", status: "READY", queryable: true,
    latestDefinitionVersion: { version: 2 }, latestDefinition: definition,
    statusDetail: [{ status: "READY", queryable: true, mainIndex: { status: "READY", queryable: true,
      definitionVersion: { version: 2 }, definition: structuredClone(definition) } }] };
}

test("read-only vector readiness verifies the latest definition on every active search host", async () => {
  let row = readyIndex(), reads = 0;
  const collection = { aggregate(pipeline, options) {
    reads++; assert.deepEqual(pipeline, [{ $listSearchIndexes: { name: referenceVectorIndex.name } }, { $limit: 2 }]);
    assert.equal(options.maxTimeMS, 5000); return { async toArray() { return [row]; } };
  } };
  assert.deepEqual(await assertReferenceVectorIndex(collection), { id: "fictional-index-id", name: referenceVectorIndex.name, version: 2 });
  row.latestDefinition.fields.reverse(); assert.ok(await assertReferenceVectorIndex(collection));
  for (const mutate of [index => { index.status = "BUILDING"; }, index => { index.status = "STALE"; }, index => { index.queryable = false; },
    index => { index.type = "search"; }, index => { index.latestDefinition.fields[0].numDimensions = 3072; },
    index => { index.latestDefinition.fields.pop(); }, index => { index.statusDetail = []; },
    index => { index.statusDetail[0].mainIndex.definitionVersion.version = 1; },
    index => { index.statusDetail[0].mainIndex.definition.fields[0].similarity = "dotProduct"; },
    index => { index.statusDetail[0].queryable = false; }, index => { index.statusDetail[0].stagedIndex = {}; },
    index => { index.statusDetail.push({ status: "BUILDING", queryable: true }); }, index => { delete index.id; }]) {
    row = readyIndex(); mutate(row);
    await assert.rejects(assertReferenceVectorIndex(collection), { code: "reference_vector_index_unavailable" });
  }
  assert.equal(reads, 15);
  await assert.rejects(assertReferenceVectorIndex({ aggregate() { throw new Error("unsupported/denied"); } }), { code: "reference_vector_index_unavailable" });
});
