import { createOpenAIEmbeddingsAdapter } from "../providers/openaiEmbeddings.js";
import { loadReferenceRetrievalConfig } from "../references/assistant.reference-config.js";
import { createApprovedReferenceSearch } from "../references/assistant.reference-search.js";
import { createCustomerQueryEmbedder } from "./assistant.query-embedding.js";
import { isFocusedReferenceRun } from "../shared/assistant.attempts.js";
import { reject } from "../shared/assistant.errors.js";

// Optional reference failures leave general education available; authority/context failures must stop the run.
const authorityErrors = new Set(["access_denied", "ai_restricted", "context_changed", "active_request_changed", "subject_not_found",
  "queue_expired", "run_not_found", "configuration_changed", "assistant_disabled"]);
export function createCustomerReferenceRetrieval({ getConfig = loadReferenceRetrievalConfig, search = createApprovedReferenceSearch(),
  embed = createCustomerQueryEmbedder(), adapterFactory = () => createOpenAIEmbeddingsAdapter({ apiKey: process.env.OPENAI_API_KEY }) } = {}) {
  return async function retrieve(scope, { run, config }) {
    const referenceInProgress = scope.phase === "normalize" || scope.referenceQueryState !== undefined;
    let retrieval;
    try { retrieval = getConfig(config); } catch (error) { if (referenceInProgress) throw error; return []; }
    if (!retrieval.enabled) { if (referenceInProgress) reject("reference_retrieval_unavailable", 503); return []; }
    if (scope.signal?.aborted) return [];
    if (scope.phase === "answer" && scope.referenceQueryState !== "ready") return [];
    // Do not pay for a question embedding when no currently approved source can be searched.
    try { if (!await search.hasEligibleSources(scope, { anySpecies: scope.phase === "resolve" }) || scope.signal?.aborted) return []; }
    catch (error) { if (authorityErrors.has(error.code)) throw error; return []; }
    if (["resolve", "normalize"].includes(scope.phase)) return isFocusedReferenceRun(run) && config.reasoningEffort === "low" ? { prepareQuery: true, passages: [] } : [];
    try {
      const query = await embed({ run, scope, shared: config, retrieval, adapter: adapterFactory(), signal: scope.signal });
      if (scope.signal?.aborted || query.status !== "completed" || query.accounting !== "settled" || !query.vector) return [];
      return await search.search({ scope, query, signal: scope.signal });
    } catch (error) {
      if (authorityErrors.has(error.code)) throw error;
      // Unknown embedding charges remain reserved in their receipt; this fallback never retries the paid call.
      return [];
    }
  };
}
export const retrieveCustomerReferences = createCustomerReferenceRetrieval();
