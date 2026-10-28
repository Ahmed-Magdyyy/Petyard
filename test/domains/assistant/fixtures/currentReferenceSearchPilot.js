import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { embeddingProfile } from "../../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { prepareReferencePassages } from "../../../../src/domains/assistant/references/assistant.reference-passages.js";
import { referenceEmbeddingBatchKey } from "../../../../src/domains/assistant/references/assistant.embedding-batches.js";
import { referencePassageDocumentId } from "../../../../src/domains/assistant/references/assistant.reference-projection.js";
import { queryEmbeddingIdentity } from "../../../../src/domains/assistant/customer/assistant.query-embedding.js";
import { REFERENCE_FLOW_VERSION } from "../../../../src/domains/assistant/shared/assistant.attempts.js";

export const currentSearchAssets = [
  ".scratch/assistant-retrieval/language-quality/cases.json",
  ".scratch/assistant-retrieval/embedding-comparison/vectors.jsonl",
  ".scratch/assistant-retrieval/query-normalization/results.jsonl",
  ".scratch/assistant-retrieval/query-normalization/owner-policy-20261026.json",
  ".scratch/assistant-retrieval/normalization-retrieval/vectors.jsonl",
  ".scratch/assistant-retrieval/normalization-retrieval/preparation.json",
  ".scratch/assistant-retrieval/normalization-retrieval/execution-verification.json",
  ".scratch/assistant-retrieval/normalization-retrieval/summary.json",
  ".scratch/assistant-retrieval/embedding-comparison/preparation.json",
  ".scratch/assistant-retrieval/embedding-comparison/execution-verification.json",
];
const json = async file => JSON.parse(await readFile(file, "utf8"));
const lines = async file => (await readFile(file, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const digest = value => createHash("sha256").update(value).digest("hex");
const vectorValid = vector => Array.isArray(vector) && vector.length === embeddingProfile.dimensions && vector.every(Number.isFinite) && vector.some(value => value !== 0);

// Reuse already paid fictional vectors; this fixture never invokes a provider.
export async function buildCurrentReferenceSearchFixtures(run) {
  assert.equal(embeddingProfile.model, "text-embedding-3-large"); assert.equal(embeddingProfile.dimensions, 1536);
  const data = await json(currentSearchAssets[0]), normalized = await lines(currentSearchAssets[2]);
  const policy = await json(currentSearchAssets[3]), saved = await json(currentSearchAssets[5]);
  assert.equal(saved.model, embeddingProfile.model);
  const comparison = await json(currentSearchAssets[8]); assert.equal(comparison.model, embeddingProfile.model);
  const documentBatches = await lines(currentSearchAssets[1]);
  assert.deepEqual(documentBatches.map(row => row.batchIndex), [0, 1, 2, 3]);
  assert.deepEqual(documentBatches.map(row => row.vectors.length), [16, 16, 16, 12]);
  for (const file of currentSearchAssets.slice(0, 4)) if (saved.pins[file]) {
    assert.equal(digest(await readFile(file)), saved.pins[file], `Saved retrieval input changed: ${file}`);
  }
  const documents = documentBatches.flatMap(row => row.vectors).slice(0, 12);
  const queryBatches = await lines(currentSearchAssets[4]);
  assert.deepEqual(queryBatches.map(row => row.batchIndex), [0, 1]);
  assert.deepEqual(queryBatches.map(row => row.vectors.length), [16, 7]);
  const queryVectors = queryBatches.flatMap(row => row.vectors);
  assert.equal(data.documents.length, 12); assert.equal(data.queries.length, 24); assert.equal(documents.length, 12);
  assert.ok([...documents, ...queryVectors].every(vectorValid));
  assert.equal(policy.decisions.bedding_arabizi.expectedStatus, "unclear");
  assert.equal(policy.decisions.bedding_arabizi.nextAction, "ask_for_clarification");
  assert.equal(normalized.filter(row => row.id === "bedding_arabizi").length, 1);
  assert.equal(normalized.find(row => row.id === "bedding_arabizi").result.structured.status, "unclear");
  const ready = data.queries.filter(row => row.id !== "bedding_arabizi");
  assert.deepEqual(ready.map(row => row.id), saved.readyCaseIds);
  const actor = new mongoose.Types.ObjectId(), references = [], passages = [], documentsById = new Map();
  for (const species of ["cat", "dog"]) {
    const source = { _id: new mongoose.Types.ObjectId(), sha256: digest(run + species), creator: actor,
      title: `Fictional ${species} Large reference`, species: [species], filename: "fictional.txt", format: "txt", bytes: 1,
      sourceStored: true, version: 1, status: "processing", stage: "awaiting_search" };
    const rows = data.documents.filter(row => row.species === species); assert.equal(rows.length, 6);
    const prepared = prepareReferencePassages(source, { sha256: source.sha256,
      units: rows.map(row => ({ locator: row.id, text: row.text })) }, { maxPages: 10, maxTextBytes: 10000 });
    assert.equal(prepared.passages.length, 6);
    const manifest = Buffer.from(JSON.stringify(prepared));
    Object.assign(source, { passageHash: digest(manifest), passageVersion: prepared.version, passageCount: 6, storedPassageCount: 6 });
    references.push({ source, manifest });
    for (const passage of prepared.passages) {
      const document = rows[passage.unitIndex]; assert.ok(document); assert.equal(passage.text, document.text);
      assert.equal(passage.locator, `${document.id}, excerpt 1`);
      const batchKey = referenceEmbeddingBatchKey(source._id, source.passageHash, 0);
      const row = { _id: referencePassageDocumentId(batchKey, passage.id), reference: source._id, sourceHash: source.sha256,
        manifestHash: source.passageHash, passageId: passage.id, batchKey, model: embeddingProfile.model,
        dimensions: embeddingProfile.dimensions, species: [species],
        text: passage.text, locator: passage.locator, unitIndex: passage.unitIndex, startOffset: passage.startOffset,
        endOffset: passage.endOffset, previousId: passage.previousId, nextId: passage.nextId,
        vector: documents[data.documents.findIndex(item => item.id === document.id)] };
      documentsById.set(document.id, row); passages.push(row);
    }
  }
  // A duplicate from an old manifest must stay excluded even when its vector is identical.
  const stale = { ...passages[0], manifestHash: digest(run + "old-manifest") };
  stale.batchKey = referenceEmbeddingBatchKey(stale.reference, stale.manifestHash, 0);
  stale._id = referencePassageDocumentId(stale.batchKey, stale.passageId); passages.push(stale);
  const queries = ready.map((row, index) => {
    const savedRows = normalized.filter(item => item.id === row.id); assert.equal(savedRows.length, 1);
    const prior = savedRows[0]; assert.equal(prior.original, row.text); assert.equal(prior.species, row.species);
    assert.equal(prior.result.structured.status, "ready"); assert.equal(prior.result.structured.query, prior.searchQuery);
    const scope = { audience: "customer", ownerId: String(actor), runId: String(new mongoose.Types.ObjectId()),
      subjectId: null, contextVersion: 1, generation: 2, phase: "answer", referenceFlowVersion: REFERENCE_FLOW_VERSION,
      referenceQueryState: "ready", species: row.species, profileFingerprint: null, query: row.text, searchQuery: prior.searchQuery };
    const identity = queryEmbeddingIdentity(scope);
    assert.deepEqual(identity.input, [`Species: ${row.species}\nQuestion: ${prior.searchQuery}`]);
    return { ...row, scope, expectedPassage: documentsById.get(row.expected), query: { status: "completed", accounting: "settled",
      receiptKey: identity.key, queryContextHash: identity.queryContextHash, vector: queryVectors[index] } };
  });
  assert.equal(1 + references.length + passages.length, 16);
  return { references, passages, queries, clarification: "bedding_arabizi" };
}
