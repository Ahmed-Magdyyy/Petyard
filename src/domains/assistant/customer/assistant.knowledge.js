import { reject } from "../shared/assistant.errors.js";

// Load the optional paid component only for a worker-owned run; an empty batch never implies a completed search.
export async function retrieveReviewedPassages(scope, options) {
  if (!options?.run || !options?.config) return [];
  return (await import("./assistant.reference-retrieval.js")).retrieveCustomerReferences(scope, options);
}

export const knowledgeBounds = Object.freeze({ passages: 3, excerptBytes: 2000, batchBytes: 8000 });
const keys = ["sourceId", "version", "title", "locator", "excerpt", "reviewed", "species"];
const string = (value, max) => typeof value === "string" && value.trim() && value.length <= max && !value.includes("\u0000");

// This is a server-adapter contract, never a client request schema or permission to execute excerpt instructions.
export function validateKnowledge(passages, scope) {
  if (!Array.isArray(passages) || passages.length > knowledgeBounds.passages ||
      Buffer.byteLength(JSON.stringify(passages)) > knowledgeBounds.batchBytes) reject("invalid_reviewed_knowledge", 503);
  const seen = new Set();
  for (const passage of passages) {
    if (!passage || typeof passage !== "object" || Array.isArray(passage) || Object.keys(passage).length !== keys.length ||
        Object.keys(passage).some((key) => !keys.includes(key)) || passage.reviewed !== true ||
        !string(passage.sourceId, 80) || !string(passage.version, 80) || !string(passage.title, 200) ||
        !string(passage.locator, 200) || !string(passage.excerpt, knowledgeBounds.excerptBytes) ||
        Buffer.byteLength(passage.excerpt) > knowledgeBounds.excerptBytes ||
        !Array.isArray(passage.species) || passage.species.length < 1 || passage.species.length > 10 ||
        passage.species.some((species) => !string(species, 40)) ||
        !passage.species.some((species) => species === "*" || species.toLocaleLowerCase() === scope.species?.toLocaleLowerCase())) {
      reject("invalid_reviewed_knowledge", 503);
    }
    const identity = JSON.stringify([passage.sourceId, passage.version, passage.locator]);
    if (seen.has(identity)) reject("invalid_reviewed_knowledge", 503);
    seen.add(identity);
  }
  return structuredClone(passages);
}

export async function retrieveKnowledgeBatch(scope, retrieve = retrieveReviewedPassages, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_resolve, rejectPromise) => {
      timer = setTimeout(() => { controller.abort(); rejectPromise(new Error("knowledge_timeout")); }, timeoutMs);
    });
    const result = await Promise.race([Promise.resolve().then(() => retrieve(Object.freeze({ ...scope,
      bounds: knowledgeBounds, signal: controller.signal }))), timeout]);
    const preparation = !Array.isArray(result);
    if (preparation && (!result || Object.keys(result).length !== 2 || result.prepareQuery !== true || !Array.isArray(result.passages) || result.passages.length)) {
      reject("invalid_reviewed_knowledge", 503);
    }
    return { ownerId: scope.ownerId, runId: scope.runId, subjectId: scope.subjectId, contextVersion: scope.contextVersion,
      ...(scope.referenceFlowVersion === undefined ? {} : { referenceFlowVersion: scope.referenceFlowVersion }),
      generation: scope.generation ?? 0, phase: scope.phase ?? "resolve", profileFingerprint: scope.profileFingerprint ?? null,
      passages: validateKnowledge(preparation ? result.passages : result, scope), ...(preparation ? { prepareQuery: true } : {}) };
  } finally { clearTimeout(timer); }
}
