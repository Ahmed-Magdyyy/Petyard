import { randomUUID } from "node:crypto";
import { requireAnalyticsActor } from "../admin/assistant.admin-access.js";
import { embeddingProfile, createOpenAIEmbeddingsAdapter } from "../providers/openaiEmbeddings.js";
import { reject } from "../shared/assistant.errors.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { assertEmbeddingBatchStore } from "./assistant.embedding-batch.model.js";
import { assertReferencePassageStore, assertReferenceVectorIndex } from "./assistant.reference-passage.model.js";
import { createReferenceEmbeddingService } from "./assistant.embedding-batches.js";
import { createReferenceProjectionService } from "./assistant.reference-projection.js";
import { createReferenceStorage } from "./assistant.reference-storage.js";
import { referenceActor } from "./assistant.reference-service.js";
import { createReferenceCoverageVerifier, referenceCanRefreshCoverage } from "./assistant.reference-coverage.js";

const permanent = new Set(["embedding_manifest_invalid", "reference_source_changed", "reference_projection_incomplete", "reference_projection_unavailable",
  "invalid_embedding_input", "reference_indexing_invalid"]);

// Reuse stored vectors and the existing coverage verifier; approval never authorizes another embedding request.
export function createReferenceCoverageRefresher({ model = AssistantReference, storage = createReferenceStorage,
  ensureStore = assertReferenceStore, ensureIndex = assertReferenceVectorIndex,
  verifyCoverage = createReferenceCoverageVerifier(), now = () => new Date() } = {}) {
  return async function refreshOne(config, shared, signal) {
    if (config?.enabled !== true || shared?.enabled !== true || signal.aborted) return;
    await ensureStore();
    const timestamp = now(), lease = randomUUID();
    const leaseUntil = new Date(timestamp.getTime() + 3 * config.storage.timeoutMs + 180_000);
    const row = await model.findOneAndUpdate({ status: "ready", stage: "ready", sourceStored: true, indexingBlocked: { $ne: true },
      $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: timestamp } }] },
        { $or: [{ indexingRetryAt: null }, { indexingRetryAt: { $lte: timestamp } }] }] },
      { $set: { lease, leaseUntil } }, { new: true, sort: { updatedAt: 1, _id: 1 }, maxTimeMS: 5000 }).lean();
    if (!row) return;
    const publish = (set, changed = false) => model.findOneAndUpdate({ _id: row._id, status: "ready", stage: "ready", version: row.version,
      passageHash: row.passageHash, lease, leaseUntil: { $gt: now() } },
      { $set: { ...set, lease: null, leaseUntil: null }, ...(changed ? { $inc: { version: 1 } } : {}) },
      { new: true, runValidators: true, maxTimeMS: 5000 }).lean();
    const retry = () => new Date(now().getTime() + 60_000);
    try {
      if (!referenceCanRefreshCoverage(row)) reject("reference_indexing_invalid");
      const index = await ensureIndex(), proof = row.searchVerification;
      if (signal.aborted) { await publish({ indexingRetryAt: retry() }); return; }
      if (!row.failureCode && proof.indexId === index.id && proof.indexName === index.name && proof.indexVersion === index.version) {
        await publish({ indexingRetryAt: retry() }); return;
      }
      const manifest = await storage(config).get(row.passageKey, 64 * 1024 * 1024);
      if (signal.aborted) { await publish({ indexingRetryAt: retry() }); return; }
      const searchVerification = await verifyCoverage(row, manifest, { signal });
      if (signal.aborted) { await publish({ indexingRetryAt: retry() }); return; }
      await publish({ searchVerification, failureCode: null, indexingRetryAt: retry() }, true);
    } catch (error) {
      if (signal.aborted) { await publish({ indexingRetryAt: retry() }); return; }
      const blocked = ["embedding_manifest_invalid", "reference_indexing_invalid", "reference_projection_incomplete"].includes(error.code);
      await publish({ indexingBlocked: blocked, failureCode: blocked ? "reference_indexing_invalid" : "reference_search_wait",
        indexingRetryAt: blocked ? null : retry() }, true);
    }
  };
}

export function createReferenceIndexer({ model = AssistantReference, storage = createReferenceStorage,
  ensureStore = async () => { await assertReferenceStore(); await assertEmbeddingBatchStore(); await assertReferencePassageStore(); },
  ensureIndex = assertReferenceVectorIndex, batches = createReferenceEmbeddingService(), projection = createReferenceProjectionService(),
  verifyCoverage = createReferenceCoverageVerifier(),
  getActor = async id => (await requireAnalyticsActor(id)).user,
  adapterFactory = () => createOpenAIEmbeddingsAdapter({ apiKey: process.env.OPENAI_API_KEY }), now = () => new Date() } = {}) {
  return async function indexOne(config, shared, indexing, signal) {
    if (config?.enabled !== true || shared?.enabled !== true || indexing?.enabled !== true || signal.aborted) return;
    const timestamp = now(), lease = randomUUID();
    // Includes three Bunny attempt timeouts, two maximum Retry-After waits and bounded provider/DB work.
    const leaseUntil = new Date(timestamp.getTime() + 3 * config.storage.timeoutMs + indexing.timeoutMs + 180_000);
    const row = await model.findOneAndUpdate({ status: "processing", stage: { $in: ["awaiting_index", "awaiting_search"] }, sourceStored: true, indexingBlocked: { $ne: true },
      $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lte: timestamp } }] },
        { $or: [{ indexingRetryAt: null }, { indexingRetryAt: { $lte: timestamp } }] }] },
      { $set: { lease, leaseUntil } }, { new: true, sort: { updatedAt: 1, _id: 1 } }).lean();
    if (!row) return;
    const claim = () => ({ _id: row._id, status: "processing", stage: row.stage, passageHash: row.passageHash,
      lease, leaseUntil: { $gt: now() } });
    const publish = set => model.findOneAndUpdate(claim(), { $set: { ...set, lease: null, leaseUntil: null }, $inc: { version: 1 } }, { new: true, runValidators: true }).lean();
    try {
      await ensureStore();
      if (row.stage !== "awaiting_search") await ensureIndex();
      if (signal.aborted) { await publish({}); return; }
      const start = row.storedPassageCount ?? 0;
      if (!Number.isSafeInteger(row.passageCount) || row.passageCount < 1 || row.passageCount > 10000 || !Number.isSafeInteger(start) ||
          start < 0 || start > row.passageCount || start !== row.passageCount && start % embeddingProfile.maxItems !== 0) reject("reference_indexing_invalid");
      if (start === row.passageCount && row.stage === "awaiting_index") { await publish({ stage: "awaiting_search", failureCode: null, indexingRetryAt: null }); return; }
      if (row.stage === "awaiting_search" && start !== row.passageCount) reject("reference_indexing_invalid");
      const manifest = await storage(config).get(row.passageKey, 64 * 1024 * 1024);
      if (signal.aborted) { await publish({}); return; }
      const actor = await getActor(row.creator); referenceActor(actor);
      if (String(actor._id) !== String(row.creator)) reject("access_denied", 403);
      if (row.stage === "awaiting_search") {
        const searchVerification = await verifyCoverage(row, manifest, { signal });
        await publish({ status: "needs_review", stage: "awaiting_approval", searchVerification, failureCode: null, indexingRetryAt: null }); return;
      }
      // Reclaiming a lease cannot redispatch an existing paid batch; its durable key owns that decision.
      const batch = await batches.processBatch({ actor, referenceId: row._id, manifest, start, referenceConfig: config,
        shared, price: indexing.price, adapter: adapterFactory(), timeoutMs: indexing.timeoutMs, signal });
      if (batch.status !== "completed" || batch.accounting !== "settled") {
        await publish({ indexingBlocked: true, indexingRetryAt: null,
          failureCode: batch.status === "failed" ? "reference_embedding_failed" : "reference_embedding_needs_review" }); return;
      }
      const projected = await projection.projectBatch({ actor, referenceId: row._id, manifest, start, referenceConfig: config });
      const storedPassageCount = start + projected.passageCount;
      await publish({ storedPassageCount, stage: storedPassageCount === row.passageCount ? "awaiting_search" : "awaiting_index",
        failureCode: null, indexingRetryAt: null });
    } catch (error) {
      const blocked = permanent.has(error.code) || ["access_denied", "ai_restricted"].includes(error.code);
      const budget = ["monthly_budget_limit", "daily_spending_limit"].includes(error.code);
      await publish({ indexingBlocked: blocked,
        indexingRetryAt: blocked ? null : budget && error.retryAt instanceof Date && error.retryAt > now() ? error.retryAt : new Date(now().getTime() + 60_000),
        failureCode: blocked ? ["access_denied", "ai_restricted"].includes(error.code) ? "reference_indexing_access" : "reference_indexing_invalid"
          : budget ? "reference_embedding_budget_wait" : row.stage === "awaiting_search" ? "reference_search_wait" : "reference_index_wait" });
    }
  };
}
