import { createHash } from "node:crypto";
import { createOpenAIEmbeddingsAdapter, embeddingProfile } from "../providers/openaiEmbeddings.js";
import { createEmbeddingExecutor } from "../references/assistant.embedding-executor.js";
import { AssistantEmbeddingBatch, assertQueryEmbeddingStore } from "../references/assistant.embedding-batch.model.js";
import { loadEmbeddingConfig } from "../references/assistant.reference-config.js";
import { loadAssistantConfig, expiry } from "../shared/assistant.config.js";
import { AssistantRun } from "../shared/assistant.models.js";
import { customerRunFilter } from "../shared/assistant.purpose.js";
import { objectId, text } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { externalWorkScope, assertRunSource } from "../customer/assistant.worker.service.js";
import { AssistantCatalogVector, assertCatalogVectorStore, assertCatalogVectorIndex, catalogVectorIndex } from "./assistant.catalog-vector.model.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const catalogOfferEmbeddingKey = offer => hash(["catalog_offer", offer._id, offer.textHash, embeddingProfile.model, embeddingProfile.dimensions]);
export function catalogQueryIdentity(run, request) {
  if (!run || !/^[a-f\d]{64}$/.test(request.binding ?? "") || !/^[a-f\d]{24}$/.test(String(run.owner)) ||
      !/^[a-f\d]{24}$/.test(String(run._id)) || typeof run.attempt !== "string" || !run.attempt ||
      !(request.species === null || typeof request.species === "string" && request.species.length <= 80 && request.species.isWellFormed())) reject("invalid_catalog_context");
  const warehouse = String(objectId(request.warehouseId)), query = text(request.query, 120);
  const input = [`${request.species ? `Species: ${request.species}\n` : ""}Shopping request: ${query}`];
  const queryContextHash = hash([String(run.owner), String(run._id), run.attempt, run.contextVersion, run.subjectId ?? null,
    run.subjectFingerprint ?? null, run.config.signature, request.binding, warehouse, input]);
  return { key: hash(["catalog_query", queryContextHash, embeddingProfile.model, embeddingProfile.dimensions]), queryContextHash, input, warehouse };
}

export function createCatalogSemanticSearch({ vectors = AssistantCatalogVector, batches = AssistantEmbeddingBatch, runs = AssistantRun,
  ensureStore = assertCatalogVectorStore, ensureIndex = assertCatalogVectorIndex, ensureReceipts = assertQueryEmbeddingStore,
  getConfig = loadAssistantConfig, getEmbeddingConfig = loadEmbeddingConfig, getScope = externalWorkScope, checkSource = assertRunSource,
  adapterFactory = () => createOpenAIEmbeddingsAdapter({ apiKey: process.env.OPENAI_API_KEY }), now = () => new Date(), ...execution } = {}) {
  const execute = createEmbeddingExecutor({ batches, now, ...execution });
  return async function retrieve({ run, config, request, signal }) {
    if (config?.enabled !== true || config.catalogSemanticEnabled !== true || signal?.aborted) return [];
    if (!Number.isFinite(config.catalogSemanticMinimumScore) || config.catalogSemanticMinimumScore < 0 || config.catalogSemanticMinimumScore > 1) reject("catalog_configuration_required", 503);
    const identity = catalogQueryIdentity(run, request), kinds = config.bundleCartEnabled === true ? ["product", "bundle"] : ["product"];
    const filter = { warehouseIds: objectId(identity.warehouse), kind: { $in: kinds }, model: embeddingProfile.model, dimensions: embeddingProfile.dimensions };
    const authorize = async session => {
      const current = getConfig();
      if (current.catalogSemanticEnabled !== true || current.signature !== config.signature) reject("configuration_changed", 409);
      const scope = await getScope(run, current, "dispatching", false, session);
      if (scope.ownerId !== String(run.owner) || scope.runId !== String(run._id) || scope.contextVersion !== run.contextVersion ||
          scope.species !== request.species || scope.profileFingerprint !== (run.subjectFingerprint ?? null)) reject("context_changed", 409);
      await checkSource(run, session);
    };
    await authorize(null); await ensureStore();
    // Do not pay to query an empty/unprovisioned index. Final card reads still revalidate every source.
    if (!await vectors.findOne(filter).select("_id").maxTimeMS(5000).lean() || signal?.aborted) return [];
    const index = await ensureIndex(); await ensureReceipts();
    const retrieval = getEmbeddingConfig(config);
    const row = await execute({ key: identity.key, identity: { kind: "catalog_query", owner: objectId(String(run.owner)), run: objectId(String(run._id)),
      queryContextHash: identity.queryContextHash, vectorsExpireAt: expiry(config.runDays, now()) }, input: identity.input,
      shared: config, price: retrieval.price, timeoutMs: retrieval.timeoutMs, adapter: adapterFactory(), signal,
      authorize: async session => {
        await authorize(session);
        const guarded = await runs.updateOne(customerRunFilter({ _id: run._id, status: "dispatching", attempt: run.attempt,
          contextVersion: run.contextVersion, generation: run.generation, phase: run.phase }), { $inc: { queryEmbeddingFence: 1 } }, { session });
        if (guarded.modifiedCount !== 1) reject("context_changed", 409);
      } });
    if (row.kind !== "catalog_query" || String(row.owner) !== String(run.owner) || String(row.run) !== String(run._id) ||
        row.queryContextHash !== identity.queryContextHash || row.model !== embeddingProfile.model || row.dimensions !== embeddingProfile.dimensions) reject("catalog_query_conflict", 409);
    if (signal?.aborted || row.status !== "completed" || row.accounting !== "settled" || !(row.vectorsExpireAt > now()) ||
        !Array.isArray(row.vectors?.[0]) || row.vectors[0].length !== embeddingProfile.dimensions ||
        row.vectors[0].some(value => !Number.isFinite(value)) || !row.vectors[0].some(value => value !== 0)) return [];
    await authorize(null);
    const found = await vectors.collection.aggregate([
      { $vectorSearch: { index: catalogVectorIndex.name, path: "vector", queryVector: row.vectors[0], limit: 20, numCandidates: 400,
        filter: { $and: [{ warehouseIds: objectId(identity.warehouse) }, { kind: { $in: kinds } }] } } },
      { $project: { _id: 1, kind: 1, sourceId: 1, variantId: 1, textHash: 1, model: 1, dimensions: 1, score: { $meta: "vectorSearchScore" } } },
    ], { maxTimeMS: 5000, readPreference: "primary", ...(signal ? { signal } : {}) }).toArray();
    const after = await ensureIndex(); await authorize(null);
    if (signal?.aborted || index.id !== after.id || index.version !== after.version || index.name !== after.name) return [];
    if (!Array.isArray(found) || found.length > 20) reject("catalog_search_invalid", 503);
    const seen = new Set();
    return found.filter(item => {
      const source = String(item?.sourceId ?? ""), variant = item?.variantId == null ? null : String(item.variantId);
      const key = item?.kind === "product" ? `product:${source}:${variant ?? "simple"}` : `bundle:${source}`;
      if (!kinds.includes(item?.kind) || !/^[a-f\d]{24}$/.test(source) || variant !== null && !/^[a-f\d]{24}$/.test(variant) ||
          item.kind === "bundle" && variant !== null || item._id !== key || seen.has(key) || !/^[a-f\d]{64}$/.test(item.textHash ?? "") ||
          item.model !== embeddingProfile.model || item.dimensions !== embeddingProfile.dimensions || !Number.isFinite(item.score) ||
          item.score < config.catalogSemanticMinimumScore || item.score > 1) return false;
      seen.add(key); return true;
    }).map(item => ({ _id: item._id, kind: item.kind, sourceId: String(item.sourceId),
      variantId: item.variantId == null ? null : String(item.variantId), textHash: item.textHash }));
  };
}
export const retrieveCatalogSemanticCandidates = createCatalogSemanticSearch();
