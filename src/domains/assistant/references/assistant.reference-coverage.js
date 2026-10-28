import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { readReferenceManifest, referenceEmbeddingBatchKey } from "./assistant.embedding-batches.js";
import { referencePassageDocumentId } from "./assistant.reference-projection.js";
import { AssistantReferencePassage, assertReferenceVectorIndex, referenceVectorIndex } from "./assistant.reference-passage.model.js";
import { approvedReference } from "./assistant.reference-search.js";

export function referenceCanRefreshCoverage(source) {
  return (!source?.failureCode || source.failureCode === "reference_search_wait") && approvedReference({ ...source, failureCode: null });
}

function matchesIds(rows, expected) {
  return Array.isArray(rows) && rows.length === expected.size && new Set(rows.map(row => row?._id)).size === expected.size &&
    rows.every(row => typeof row?._id === "string" && expected.has(row._id));
}

// Coverage is an observation on this search path, not a promise about every replica or future query.
export function createReferenceCoverageVerifier({ collection = AssistantReferencePassage.collection,
  ensureIndex = assertReferenceVectorIndex, now = () => new Date() } = {}) {
  return async function verify(source, manifest, { signal } = {}) {
    if (signal?.aborted) reject("reference_search_cancelled", 409);
    const eligible = source?.status === "processing" && source.stage === "awaiting_search" ||
      source?.status === "needs_review" && source.stage === "awaiting_approval" || referenceCanRefreshCoverage(source);
    if (!eligible || source.indexingBlocked ||
        !source.sourceStored || source.storedPassageCount !== source.passageCount) reject("reference_indexing_invalid");
    const prepared = readReferenceManifest(source, manifest), passageIds = new Set(), expected = new Set();
    for (const [index, passage] of prepared.passages.entries()) {
      if (!/^[a-f\d]{64}$/.test(passage?.id ?? "") || passageIds.has(passage.id)) reject("embedding_manifest_invalid");
      passageIds.add(passage.id);
      const start = Math.floor(index / embeddingProfile.maxItems) * embeddingProfile.maxItems;
      const key = referenceEmbeddingBatchKey(source._id, source.passageHash, start);
      expected.add(referencePassageDocumentId(key, passage.id));
    }
    const before = await ensureIndex();
    const filter = { reference: objectId(String(source._id)), manifestHash: source.passageHash };
    const canonical = { ...filter, model: embeddingProfile.model, dimensions: embeddingProfile.dimensions };
    const options = { maxTimeMS: 5000, readPreference: "primary", ...(signal ? { signal } : {}) };
    // Reuse the _id index instead of scanning every book on the shared Free-tier database.
    const stored = await collection.find({ ...canonical, _id: { $in: [...expected] } },
      { ...options, readConcern: { level: "majority" }, projection: { _id: 1 }, limit: expected.size + 1 }).toArray();
    if (!matchesIds(stored, expected)) reject("reference_projection_incomplete", 503);
    const seed = await collection.findOne({ ...canonical, _id: expected.values().next().value }, { ...options, readConcern: { level: "majority" }, projection: { vector: 1 } });
    const vector = seed?.vector;
    if (!Array.isArray(vector) || vector.length !== embeddingProfile.dimensions || Array.from(vector).some(value => !Number.isFinite(value)) ||
        !vector.some(value => value !== 0)) reject("reference_projection_incomplete", 503);
    if (signal?.aborted) reject("reference_search_cancelled", 409);
    const found = await collection.aggregate([
      { $vectorSearch: { index: referenceVectorIndex.name, path: "vector", queryVector: vector, exact: true, filter, limit: expected.size + 1 } },
      { $project: { _id: 1 } },
    ], options).toArray();
    if (!matchesIds(found, expected)) reject("reference_search_incomplete", 503);
    const after = await ensureIndex();
    if (before.id !== after.id || before.name !== after.name || before.version !== after.version) reject("reference_vector_index_unavailable", 503);
    if (signal?.aborted) reject("reference_search_cancelled", 409);
    return { model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
      manifestHash: source.passageHash, indexId: after.id, indexName: after.name, indexVersion: after.version,
      passageCount: expected.size, verifiedAt: now() };
  };
}
