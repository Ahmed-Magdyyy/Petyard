import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { AssistantProviderError } from "../providers/providerContract.js";
import { reserveCost, settleCost, transaction } from "../shared/assistant.store.js";
import { reject } from "../shared/assistant.errors.js";
import { AssistantEmbeddingBatch } from "./assistant.embedding-batch.model.js";
import { embeddingBillingSnapshot } from "./assistant.embedding-billing.js";

const validUsage = (usage, maximum) => usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens > 0 &&
  usage.inputTokens <= maximum && usage.totalTokens === usage.inputTokens && usage.outputTokens === 0 &&
  usage.cachedInputTokens === 0 && usage.cacheWriteInputTokens === 0;

// Domain callers validate authority/input; this shared executor owns once-only dispatch and accounting.
export function createEmbeddingExecutor({ batches = AssistantEmbeddingBatch, atomic = transaction, reserve = reserveCost,
  settle = settleCost, now = () => new Date() } = {}) {
  return async function execute({ key, identity, input, shared, price, adapter, timeoutMs, signal, authorize }) {
    if (typeof authorize !== "function" || adapter?.model !== embeddingProfile.model || adapter.dimensions !== embeddingProfile.dimensions ||
        typeof adapter.embed !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || signal?.aborted) {
      reject("embedding_dispatch_unavailable", 503);
    }
    const saved = await batches.findOne({ key });
    if (saved) return saved;
    const snapshot = embeddingBillingSnapshot(shared, price, input, now());
    const claim = await atomic(async session => {
      const existing = await batches.findOne({ key }).session(session);
      if (existing) return { dispatch: false, row: existing };
      await authorize(session);
      if (signal?.aborted) reject("embedding_dispatch_cancelled", 409);
      const reservation = await reserve(identity.owner, snapshot.config, session, now());
      if (signal?.aborted) reject("embedding_dispatch_cancelled", 409);
      const [row] = await batches.create([{ ...identity, key, batchHash: snapshot.batchHash, model: snapshot.model, dimensions: snapshot.dimensions,
        config: snapshot.config, reservation, accounting: "reserved", status: "dispatching",
        dispatchDeadline: new Date(now().getTime() + timeoutMs + 30_000) }], { session });
      return { dispatch: true, row };
    });
    if (!claim.dispatch) return claim.row;
    let result, failure;
    try {
      if (signal?.aborted) throw new AssistantProviderError("cancelled", { chargeExposure: "none" });
      result = await adapter.embed({ input, timeoutMs, signal });
      if (!validUsage(result?.usage, snapshot.maximumTokens) || !Array.isArray(result?.vectors) || result.vectors.length !== input.length ||
          Array.from(result.vectors).some(vector => !Array.isArray(vector) || vector.length !== embeddingProfile.dimensions ||
            Array.from(vector).some(value => typeof value !== "number" || !Number.isFinite(value)) || !vector.some(value => value !== 0))) {
        throw new AssistantProviderError("invalid_embedding_response", { usage: result?.usage, chargeExposure: "unknown" });
      }
    } catch (error) { failure = error; }
    // A failed completion commit leaves dispatching/reserved; it never permits another HTTP attempt.
    return atomic(async session => {
      const row = await batches.findOne({ key, status: "dispatching", accounting: "reserved" }).session(session);
      if (!row) reject("embedding_batch_changed", 409);
      const usage = failure ? failure.usage : result.usage;
      const known = validUsage(usage, snapshot.maximumTokens);
      const free = failure instanceof AssistantProviderError && failure.chargeExposure === "none";
      if ((known || free) && !await settle(row, known ? usage : { inputTokens: 0, outputTokens: 0 }, session)) reject("assistant_accounting_unavailable", 503);
      row.status = failure ? known || free ? "failed" : "uncertain" : "completed";
      if (!failure) row.vectors = result.vectors;
      const requestId = (failure ?? result)?.providerRequestId;
      if (typeof requestId === "string" && requestId.length <= 200) row.providerRequestId = requestId;
      if (failure) row.failureCode = failure instanceof AssistantProviderError && /^[a-z_]{1,80}$/.test(failure.code ?? "")
        ? failure.code : "embedding_provider_failed";
      await row.save({ session }); return row;
    });
  };
}
