import { createHash } from "node:crypto";
import { embeddingBatchBounds, embeddingProfile } from "../providers/openaiEmbeddings.js";
import { expiry } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { AssistantRun } from "../shared/assistant.models.js";
import { queuedWorkFilter } from "../shared/assistant.attempts.js";
import { createEmbeddingExecutor } from "../references/assistant.embedding-executor.js";
import { AssistantEmbeddingBatch, assertQueryEmbeddingStore } from "../references/assistant.embedding-batch.model.js";
import { externalWorkScope, assertRunSource } from "./assistant.worker.service.js";

export function queryEmbeddingIdentity(scope) {
  if (scope?.audience !== "customer" || !/^[a-f\d]{24}$/.test(scope.ownerId ?? "") || !/^[a-f\d]{24}$/.test(scope.runId ?? "") ||
      !Number.isSafeInteger(scope.contextVersion) || scope.contextVersion < 0 || !Number.isSafeInteger(scope.generation ?? 0) || (scope.generation ?? 0) < 0 ||
      !["resolve", "answer"].includes(scope.phase ?? "resolve") ||
      !(scope.subjectId === null || typeof scope.subjectId === "string" && scope.subjectId.length <= 80) ||
      !(scope.species === null || typeof scope.species === "string" && scope.species.trim() && scope.species.length <= 80 && scope.species.isWellFormed()) ||
      !(scope.profileFingerprint === null || /^[a-f\d]{64}$/.test(scope.profileFingerprint ?? ""))) reject("invalid_query_embedding_scope");
  if (typeof scope.query !== "string" || !scope.query.trim()) reject("invalid_query_embedding_scope");
  if (scope.searchQuery !== undefined && (scope.phase !== "answer" || scope.referenceQueryState !== "ready" ||
      typeof scope.searchQuery !== "string" || !scope.searchQuery.trim())) reject("invalid_query_embedding_scope");
  const input = [`${scope.species === null ? "" : `Species: ${scope.species}\n`}Question: ${scope.searchQuery ?? scope.query}`];
  embeddingBatchBounds(input); // Never truncate a question or discard a trailing negation to meet the limit.
  const queryContextHash = createHash("sha256").update(JSON.stringify([scope.ownerId, scope.runId, scope.subjectId, scope.contextVersion,
    scope.generation ?? 0, scope.phase ?? "resolve", scope.species, scope.profileFingerprint, input,
    ...(scope.searchQuery !== undefined ? [["language-preserving-v1", scope.query]] : [])])).digest("hex");
  const key = createHash("sha256").update(JSON.stringify(["customer_query", queryContextHash, embeddingProfile.model, embeddingProfile.dimensions])).digest("hex");
  return { key, queryContextHash, input };
}

export async function scrubExpiredQueryVectors(now = new Date(), batches = AssistantEmbeddingBatch, kind = "customer_query") {
  if (!["customer_query", "catalog_query"].includes(kind)) reject("invalid_query_embedding_scope");
  return batches.updateMany({ kind, vectorsExpireAt: { $lte: now }, vectors: { $exists: true } },
    { $unset: { vectors: 1 } }, { maxTimeMS: 5000 });
}

export async function removeExpiredQueryVectors(config) {
  if (config?.referenceRetentionEnabled !== true && config?.catalogSemanticEnabled !== true) return { enabled: false };
  await assertQueryEmbeddingStore();
  let removed = 0;
  if (config.referenceRetentionEnabled === true) removed += (await scrubExpiredQueryVectors()).modifiedCount;
  if (config.catalogSemanticEnabled === true) removed += (await scrubExpiredQueryVectors(new Date(), AssistantEmbeddingBatch, "catalog_query")).modifiedCount;
  return { enabled: true, removed };
}

// Customer retrieval owns the opt-in and eligible-source preflight; this component owns the paid query receipt.
export function createCustomerQueryEmbedder({ batches = AssistantEmbeddingBatch, runs = AssistantRun,
  ensureStore = assertQueryEmbeddingStore, getScope = externalWorkScope, checkSource = assertRunSource,
  now = () => new Date(), ...execution } = {}) {
  const execute = createEmbeddingExecutor({ ...execution, batches, now });
  return async function embedQuery({ run, scope, shared, retrieval, adapter, signal }) {
    if (retrieval?.enabled !== true || shared?.enabled !== true || !Number.isSafeInteger(shared.runDays) || shared.runDays < 1 || shared.runDays > 3650) {
      reject("query_embeddings_disabled", 503);
    }
    const request = queryEmbeddingIdentity(scope);
    const authorize = async session => {
      const current = await getScope(run, shared, "queued", false, session);
      if (queryEmbeddingIdentity(current).key !== request.key) reject("context_changed", 409);
      await checkSource(run, session);
    };
    await authorize(null); await ensureStore();
    await scrubExpiredQueryVectors(now(), batches);
    const row = await execute({ key: request.key, identity: { kind: "customer_query", owner: objectId(scope.ownerId), run: objectId(scope.runId),
      queryContextHash: request.queryContextHash, vectorsExpireAt: expiry(shared.runDays, now()) }, input: request.input,
      shared, price: retrieval.price, timeoutMs: retrieval.timeoutMs, adapter, signal,
      authorize: async session => {
        await authorize(session);
        const guarded = await runs.updateOne(queuedWorkFilter(run._id, run), { $inc: { queryEmbeddingFence: 1 } }, { session });
        if (guarded.modifiedCount !== 1) reject("context_changed", 409);
      } });
    if (row.kind !== "customer_query" || String(row.owner) !== scope.ownerId || String(row.run) !== scope.runId || row.queryContextHash !== request.queryContextHash) {
      reject("query_embedding_conflict", 409);
    }
    if (!(row.vectorsExpireAt instanceof Date) || row.vectorsExpireAt <= now()) reject("query_embedding_expired", 409);
    return { status: row.status, accounting: row.accounting, vector: row.status === "completed" ? row.vectors?.[0] ?? null : null,
      queryContextHash: request.queryContextHash, receiptKey: request.key };
  };
}
