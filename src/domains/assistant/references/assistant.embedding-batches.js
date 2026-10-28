import { createHash } from "node:crypto";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { reserveCost, settleCost, transaction } from "../shared/assistant.store.js";
import { reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { AssistantEmbeddingBatch, assertEmbeddingBatchStore } from "./assistant.embedding-batch.model.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { createEmbeddingExecutor } from "./assistant.embedding-executor.js";
import { referenceActor, sourceHash } from "./assistant.reference-service.js";
import { referencePassageVersion } from "./assistant.reference-passages.js";
import { requireReferences } from "./assistant.reference-config.js";

export const referenceEmbeddingBatchKey = (id, manifestHash, start) => createHash("sha256")
  .update(JSON.stringify([id, manifestHash, start, embeddingProfile.model, embeddingProfile.dimensions])).digest("hex");

export function readReferenceManifest(row, manifest) {
  // The saved checksum binds the entire ordered manifest; a caller cannot substitute its own texts.
  if (!Buffer.isBuffer(manifest) || manifest.length > 64 * 1024 * 1024 || sourceHash(manifest) !== row.passageHash) reject("embedding_manifest_invalid");
  let prepared;
  try { prepared = JSON.parse(manifest.toString("utf8")); } catch { reject("embedding_manifest_invalid"); }
  if (prepared?.version !== referencePassageVersion || prepared.sourceId !== String(row._id) || prepared.sourceVersion !== row.sha256 ||
      !Array.isArray(prepared.passages) || !prepared.passages.length || prepared.passages.length !== row.passageCount || prepared.passages.length > 10000) {
    reject("embedding_manifest_invalid");
  }
  return prepared;
}

export function referenceBatchInput(row, manifest, start) {
  const prepared = readReferenceManifest(row, manifest);
  if (!Number.isSafeInteger(start) || start < 0 || start % embeddingProfile.maxItems !== 0 || start >= prepared.passages.length) reject("embedding_manifest_invalid");
  const passages = prepared.passages.slice(start, start + embeddingProfile.maxItems);
  if (passages.some(passage => !/^[a-f\d]{64}$/.test(passage?.id ?? "")) ||
      new Set(passages.map(passage => passage.id)).size !== passages.length) reject("embedding_manifest_invalid");
  return { input: passages.map(passage => passage.text), passageIds: passages.map(passage => passage.id), passages };
}

// Invoked through the reference indexer; no paid retry, activation or customer-facing route.
export function createReferenceEmbeddingService({ batches = AssistantEmbeddingBatch, references = AssistantReference,
  ensureStore = async () => { await assertReferenceStore(); await assertEmbeddingBatchStore(); },
  atomic = transaction, reserve = reserveCost, settle = settleCost, now = () => new Date() } = {}) {
  const execute = createEmbeddingExecutor({ batches, atomic, reserve, settle, now });
  return {
    async processBatch({ actor, referenceId, manifest, start, referenceConfig, shared, price, adapter, timeoutMs, signal }) {
      const owner = referenceActor(actor), id = objectId(String(referenceId));
      requireReferences(referenceConfig);
      if (shared?.enabled !== true) reject("assistant_disabled", 503);
      if (adapter?.model !== embeddingProfile.model || adapter.dimensions !== embeddingProfile.dimensions || typeof adapter.embed !== "function" ||
          !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || signal?.aborted) reject("embedding_dispatch_unavailable", 503);
      await ensureStore();
      const source = await references.findById(id).lean();
      if (!source || String(source.creator) !== String(owner) || source.status !== "processing" || source.stage !== "awaiting_index" ||
          !source.sourceStored || source.passageVersion !== referencePassageVersion) reject("embedding_source_unavailable", 409);
      const { input, passageIds } = referenceBatchInput(source, manifest, start);
      const key = referenceEmbeddingBatchKey(id, source.passageHash, start);
      return execute({ key, identity: { kind: "reference", reference: id, owner, sourceHash: source.sha256, manifestHash: source.passageHash, start, passageIds },
        input, shared, price, adapter, timeoutMs, signal, authorize: async session => {
        // Write the source too, so disable/retry cannot race admission through a snapshot-only read.
        const guarded = await references.updateOne({ _id: id, creator: owner, version: source.version, status: "processing", stage: "awaiting_index",
          passageHash: source.passageHash, sourceStored: true }, { $inc: { embeddingFence: 1 } }, { session });
        if (guarded.modifiedCount !== 1) reject("embedding_source_unavailable", 409);
      } });
    },
  };
}
