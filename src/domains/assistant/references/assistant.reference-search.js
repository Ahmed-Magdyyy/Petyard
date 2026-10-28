import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { reject } from "../shared/assistant.errors.js";
import { knowledgeBounds, validateKnowledge } from "../customer/assistant.knowledge.js";
import { queryEmbeddingIdentity } from "../customer/assistant.query-embedding.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { AssistantReferencePassage, assertReferencePassageStore, assertReferenceVectorIndex, referenceVectorIndex } from "./assistant.reference-passage.model.js";
import { referencePassageDocumentId } from "./assistant.reference-projection.js";
import { referencePassageVersion } from "./assistant.reference-passages.js";
import { objectId } from "../shared/assistant.validation.js";
import { REFERENCE_FLOW_VERSION } from "../shared/assistant.attempts.js";

const hash = value => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
export function approvedReference(source, index = null) {
  const approval = source?.activation, proof = source?.searchVerification;
  return source?.status === "ready" && source.stage === "ready" && source.sourceStored === true && !source.indexingBlocked && !source.failureCode &&
    source.passageVersion === referencePassageVersion && hash(source.sha256) && hash(source.passageHash) &&
    Number.isSafeInteger(source.passageCount) && source.passageCount > 0 && source.passageCount <= 10000 && source.storedPassageCount === source.passageCount &&
    approval?.sourceHash === source.sha256 && approval.manifestHash === source.passageHash && /^[a-f\d]{24}$/i.test(String(approval.actor ?? "")) &&
    approval.at instanceof Date && Number.isFinite(approval.at.getTime()) && Number.isSafeInteger(approval.reviewedVersion) && approval.reviewedVersion >= 1 &&
    Number.isSafeInteger(source.version) && source.version > approval.reviewedVersion &&
    proof?.manifestHash === source.passageHash && proof.passageCount === source.passageCount && proof.indexName === referenceVectorIndex.name &&
    proof.model === embeddingProfile.model && proof.dimensions === embeddingProfile.dimensions &&
    typeof proof.indexId === "string" && Boolean(proof.indexId.trim()) && Number.isSafeInteger(proof.indexVersion) && proof.indexVersion >= 0 &&
    proof.verifiedAt instanceof Date && Number.isFinite(proof.verifiedAt.getTime()) &&
    (!index || proof.indexId === index.id && proof.indexName === index.name && proof.indexVersion === index.version);
}

// A write on each source makes approval checks conflict with concurrent disabling in the caller's transaction.
export async function fenceReferenceSources(bindings = [], session, sources = AssistantReference) {
  if (!Array.isArray(bindings) || bindings.length > knowledgeBounds.passages) reject("reference_knowledge_changed", 409);
  const seen = new Set();
  for (const binding of bindings) {
    const id = String(binding?.sourceId ?? "");
    if (!/^[a-f\d]{24}$/.test(id) || !hash(binding.manifestHash) || seen.has(id)) reject("reference_knowledge_changed", 409);
    seen.add(id);
    const source = await sources.findOne({ _id: objectId(id) }).session(session).maxTimeMS(5000).lean();
    if (!approvedReference(source) || source.passageHash !== binding.manifestHash) reject("reference_knowledge_changed", 409);
    const guarded = await sources.updateOne({ _id: source._id, version: source.version, status: "ready", stage: "ready",
      passageHash: binding.manifestHash }, { $inc: { retrievalFence: 1 } }, { session, maxTimeMS: 5000 });
    if (guarded.modifiedCount !== 1) reject("reference_knowledge_changed", 409);
  }
}

// This is an internal search component. The caller supplies an authorized, paid query receipt; no provider call occurs here.
export function createApprovedReferenceSearch({ sources = AssistantReference, collection = AssistantReferencePassage.collection,
  ensureStore = async () => { await assertReferenceStore(); await assertReferencePassageStore(); }, ensureIndex = assertReferenceVectorIndex } = {}) {
  const readyFor = (scope, anySpecies = false) => ({ status: "ready", stage: "ready", sourceStored: true, indexingBlocked: { $ne: true },
    ...(!anySpecies ? { species: { $in: typeof scope.species === "string" ? [scope.species.trim().toLowerCase(), "*"] : ["*"] } } : {}) });
  async function loadSources(scope, anySpecies = false) {
    // shortcut: fail closed above 1000 eligible sources; revisit the metadata projection if a real library reaches this size.
    const rows = await sources.find(readyFor(scope, anySpecies)).sort({ _id: 1 }).limit(1001).maxTimeMS(5000).lean();
    if (rows.length > 1000) reject("reference_retrieval_capacity", 503);
    return rows.filter(source => approvedReference(source));
  }
  return {
    async hasEligibleSources(scope, { anySpecies = false } = {}) {
      // Normalize may check source metadata, but the paid embedding/search path still accepts only resolve/answer.
      queryEmbeddingIdentity(scope.phase === "normalize" && scope.referenceFlowVersion === REFERENCE_FLOW_VERSION
        ? { ...scope, phase: "resolve" } : scope);
      await ensureStore();
      const allowed = await loadSources(scope, anySpecies);
      if (!allowed.length) return false;
      const index = await ensureIndex(); return allowed.some(source => approvedReference(source, index));
    },
    async search({ scope, query, signal }) {
    const identity = queryEmbeddingIdentity(scope);
    if (signal?.aborted) reject("reference_search_cancelled", 409);
    if (query?.status !== "completed" || query.accounting !== "settled" || query.receiptKey !== identity.key || query.queryContextHash !== identity.queryContextHash ||
        !Array.isArray(query.vector) || query.vector.length !== embeddingProfile.dimensions || Array.from(query.vector).some(value => !Number.isFinite(value)) ||
        !query.vector.some(value => value !== 0)) reject("reference_query_unavailable", 503);
    const species = typeof scope.species === "string" ? scope.species.trim().toLowerCase() : null;
    const ready = readyFor(scope);
    await ensureStore();
    let allowed = await loadSources(scope);
    if (!allowed.length) return [];
    const index = await ensureIndex();
    allowed = allowed.filter(source => approvedReference(source, index));
    if (!allowed.length) return [];
    const limit = knowledgeBounds.passages * 4;
    const found = await collection.aggregate([
      { $vectorSearch: { index: referenceVectorIndex.name, path: "vector", queryVector: query.vector, limit, numCandidates: limit * 20,
        filter: { $and: [{ species: { $in: species ? [species, "*"] : ["*"] } },
          { $or: allowed.map(source => ({ reference: source._id, manifestHash: source.passageHash })) }] } } },
      { $project: { _id: 1, reference: 1, manifestHash: 1, sourceHash: 1, passageId: 1, batchKey: 1,
        model: 1, dimensions: 1, text: 1, locator: 1, score: { $meta: "vectorSearchScore" } } },
    ], { maxTimeMS: 5000, readPreference: "primary", ...(signal ? { signal } : {}) }).toArray();
    if (!Array.isArray(found) || found.length > limit) reject("reference_search_invalid", 503);
    const after = await ensureIndex();
    if (index.id !== after.id || index.name !== after.name || index.version !== after.version || signal?.aborted) reject("reference_search_changed", 503);
    const fresh = await sources.find({ ...ready, _id: { $in: allowed.map(source => source._id) } }).limit(1001).maxTimeMS(5000).lean();
    if (signal?.aborted) reject("reference_search_cancelled", 409);
    const current = new Map(fresh.filter(source => approvedReference(source, after)).map(source => [String(source._id), source]));
    const original = new Map(allowed.map(source => [String(source._id), source]));
    const seen = new Set(), seenIds = new Set(), passages = [];
    for (const row of found) {
      const source = current.get(String(row?.reference));
      if (!source || source.version !== original.get(String(source._id))?.version || row.manifestHash !== source.passageHash || row.sourceHash !== source.sha256 ||
          row.model !== embeddingProfile.model || row.dimensions !== embeddingProfile.dimensions || !hash(row.passageId) || !hash(row.batchKey) ||
          row._id !== referencePassageDocumentId(row.batchKey, row.passageId) || !Number.isFinite(row.score) ||
          typeof row.text !== "string" || !row.text.isWellFormed() || !row.text.trim() || row.text.includes("\u0000") || Buffer.byteLength(row.text) > knowledgeBounds.excerptBytes ||
          typeof row.locator !== "string" || !row.locator.isWellFormed() || !row.locator.trim() || row.locator.includes("\u0000") || row.locator.length > 200) continue;
      const key = JSON.stringify([String(source._id), source.passageHash, row.locator]);
      if (seen.has(key) || seenIds.has(row._id)) continue;
      seen.add(key); seenIds.add(row._id);
      passages.push({ sourceId: String(source._id), version: source.passageHash, title: source.title, locator: row.locator,
        excerpt: row.text, reviewed: true, species: [...source.species] });
      if (passages.length === knowledgeBounds.passages) break;
    }
    return validateKnowledge(passages, { ...scope, species });
    },
  };
}
