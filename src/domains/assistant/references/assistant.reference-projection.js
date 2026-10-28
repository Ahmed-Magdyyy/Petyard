import { createHash } from "node:crypto";
import { embeddingBatchBounds, embeddingProfile } from "../providers/openaiEmbeddings.js";
import { transaction } from "../shared/assistant.store.js";
import { reject } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { AssistantEmbeddingBatch, assertEmbeddingBatchStore } from "./assistant.embedding-batch.model.js";
import { AssistantReferencePassage, assertReferencePassageStore } from "./assistant.reference-passage.model.js";
import { referenceBatchInput, referenceEmbeddingBatchKey } from "./assistant.embedding-batches.js";
import { embeddingInputHash } from "./assistant.embedding-billing.js";
import { referenceActor } from "./assistant.reference-service.js";
import { requireReferences } from "./assistant.reference-config.js";
import { referencePassageVersion } from "./assistant.reference-passages.js";

const neighbour = value => value === null || typeof value === "string" && /^[a-f\d]{64}$/.test(value);
export const referencePassageDocumentId = (batchKey, passageId) => createHash("sha256").update(JSON.stringify([batchKey, passageId])).digest("hex");

export function createReferenceProjectionService({ references = AssistantReference, batches = AssistantEmbeddingBatch, passages = AssistantReferencePassage,
  ensureStore = async () => { await assertReferenceStore(); await assertEmbeddingBatchStore(); await assertReferencePassageStore(); },
  atomic = transaction, now = () => new Date() } = {}) {
  return {
    async projectBatch({ actor, referenceId, manifest, start, referenceConfig }) {
      const owner = referenceActor(actor), id = objectId(String(referenceId));
      requireReferences(referenceConfig);
      await ensureStore();
      return atomic(async session => {
        const source = await references.findById(id).session(session).lean();
        if (!source || String(source.creator) !== String(owner) || source.status !== "processing" || source.stage !== "awaiting_index" ||
            !source.sourceStored || source.passageVersion !== referencePassageVersion) reject("embedding_source_unavailable", 409);
        const prepared = referenceBatchInput(source, manifest, start);
        embeddingBatchBounds(prepared.input);
        const key = referenceEmbeddingBatchKey(id, source.passageHash, start);
        const batch = await batches.findOne({ key }).session(session).lean();
        if (!batch || batch.status !== "completed" || batch.accounting !== "settled" || String(batch.reference) !== String(id) ||
            String(batch.owner) !== String(owner) || batch.sourceHash !== source.sha256 || batch.manifestHash !== source.passageHash ||
            batch.batchHash !== embeddingInputHash(prepared.input) || batch.model !== embeddingProfile.model || batch.dimensions !== embeddingProfile.dimensions ||
            batch.start !== start || JSON.stringify(batch.passageIds) !== JSON.stringify(prepared.passageIds)) reject("reference_projection_unavailable", 409);
        const receipt = alreadyProjected => ({ batchKey: key, passageCount: prepared.passages.length, alreadyProjected });
        if (batch.projectedAt) {
          if (await passages.countDocuments({ batchKey: key }).session(session) !== prepared.passages.length) reject("reference_projection_incomplete", 503);
          return receipt(true);
        }
        if (!Array.isArray(batch.vectors) || batch.vectors.length !== prepared.passages.length || Array.from(batch.vectors).some(vector =>
          !Array.isArray(vector) || vector.length !== embeddingProfile.dimensions || Array.from(vector).some(value => !Number.isFinite(value)) ||
          !vector.some(value => value !== 0))) reject("reference_projection_unavailable", 409);
        const documents = prepared.passages.map((passage, index) => {
          if (typeof passage.locator !== "string" || !passage.locator.trim() || !passage.locator.isWellFormed() || passage.locator.includes("\u0000") || passage.locator.length > 200 ||
              !Number.isSafeInteger(passage.unitIndex) || passage.unitIndex < 0 || passage.unitIndex > 1999 ||
              !Number.isSafeInteger(passage.startOffset) || passage.startOffset < 0 || !Number.isSafeInteger(passage.endOffset) ||
              passage.endOffset - passage.startOffset !== passage.text.length || !neighbour(passage.previousId) || !neighbour(passage.nextId)) {
            reject("embedding_manifest_invalid");
          }
          return { _id: referencePassageDocumentId(key, passage.id),
            reference: id, sourceHash: source.sha256, manifestHash: source.passageHash, passageId: passage.id, batchKey: key,
            model: batch.model, dimensions: batch.dimensions, species: [...source.species], text: passage.text, locator: passage.locator,
            unitIndex: passage.unitIndex, startOffset: passage.startOffset, endOffset: passage.endOffset,
            previousId: passage.previousId, nextId: passage.nextId, vector: batch.vectors[index] };
        });
        const guarded = await references.updateOne({ _id: id, creator: owner, version: source.version, status: "processing", stage: "awaiting_index",
          passageHash: source.passageHash, sourceStored: true }, { $inc: { embeddingFence: 1 } }, { session });
        if (guarded.modifiedCount !== 1) reject("embedding_source_unavailable", 409);
        await passages.insertMany(documents, { session, ordered: true });
        // Move vectors only in the same transaction as the complete projection; Atlas Free need not keep two copies.
        const updated = await batches.updateOne({ key, status: "completed", accounting: "settled", projectedAt: { $exists: false } },
          { $set: { projectedAt: now() }, $unset: { vectors: 1 } }, { session, runValidators: true });
        if (updated.modifiedCount !== 1) reject("reference_projection_changed", 409);
        return receipt(false);
      });
    },
  };
}
