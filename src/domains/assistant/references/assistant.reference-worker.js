import { randomUUID } from "node:crypto";
import { AssistantError } from "../shared/assistant.errors.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { createReferenceStorage, sourceObjectKey } from "./assistant.reference-storage.js";
import { extractReferenceFile } from "./assistant.reference-extract.js";
import { sourceHash, referenceFailure } from "./assistant.reference-service.js";
import { prepareReferencePassages } from "./assistant.reference-passages.js";
import { createReferenceIndexer, createReferenceCoverageRefresher } from "./assistant.reference-indexer.js";

export function createReferenceWorker({ model = AssistantReference, ensureStore = assertReferenceStore,
  storage = createReferenceStorage, extract = extractReferenceFile, now = () => new Date(), indexOne = createReferenceIndexer(),
  refreshCoverage = createReferenceCoverageRefresher({ model, ensureStore, storage, now }) } = {}) {
  let running = null, controller = null, stopping = false;
  async function processOne(config, signal, options) {
    await ensureStore();
    const timestamp = now();
    // Interrupted upload/extraction needs explicit retry; never retry an unknown paid step here.
    for (const stage of ["uploading", "extracting"]) await model.updateMany({ status: "processing", stage, leaseUntil: { $lte: timestamp } },
      { $set: { status: "failed", stage: "failed", lease: null, leaseUntil: null,
        failureCode: stage === "uploading" ? "reference_reupload_required" : "reference_processing_interrupted" }, $inc: { version: 1 } });
    if (signal.aborted) return;
    await refreshCoverage(config, options.shared, signal);
    if (signal.aborted) return;
    const lease = randomUUID();
    const leaseUntil = new Date(timestamp.getTime() + config.limits.timeoutMs + 9 * config.storage.timeoutMs + 30_000);
    const row = await model.findOneAndUpdate({ status: "processing", stage: "queued", sourceStored: true },
      { $set: { stage: "extracting", lease, leaseUntil }, $inc: { version: 1 } }, { new: true, sort: { _id: 1 } }).lean();
    if (!row) {
      await indexOne(config, options.shared, options.indexing, signal); return;
    }
    const claim = () => ({ _id: row._id, status: "processing", stage: "extracting", lease, leaseUntil: { $gt: now() } });
    try {
      const bucket = storage(config);
      let buffer;
      try { buffer = await bucket.get(sourceObjectKey(row), config.limits.maxFileBytes); }
      catch { throw new AssistantError("reference_source_unavailable", 503); }
      if (buffer.length !== row.bytes || sourceHash(buffer) !== row.sha256) throw new AssistantError("reference_source_changed", 409);
      const result = await extract({ originalname: row.filename, buffer }, config.limits, { signal });
      const manifest = Buffer.from(JSON.stringify(result));
      if (manifest.length > config.limits.maxTextBytes * 6 + config.limits.maxPages * 1024 + 16384) {
        throw new AssistantError("reference_text_too_large", 413);
      }
      const extractionHash = sourceHash(manifest);
      const prepared = prepareReferencePassages(row, result, config.limits);
      const passageManifest = Buffer.from(JSON.stringify({ ...prepared, extractionHash }));
      if (signal.aborted) throw new AssistantError("reference_processing_cancelled", 409);
      const extractionKey = `assistant-references/${row.sha256}/extraction-${lease}.json`;
      const passageKey = `assistant-references/${row.sha256}/passages-${lease}.json`;
      await bucket.put(extractionKey, manifest, "application/json");
      await bucket.put(passageKey, passageManifest, "application/json");
      const preview = Array.from(result.units.map(unit => unit.text).find(value => value.trim()) ?? "").slice(0, 2000).join("");
      await model.findOneAndUpdate(claim(), { $set: { stage: "awaiting_index", lease: null, leaseUntil: null,
        extractionKey, extractionHash, passageKey, passageHash: sourceHash(passageManifest), passageVersion: prepared.version,
        passageCount: prepared.passages.length, preview, unitCount: result.units.length,
        textBytes: result.units.reduce((sum, unit) => sum + Buffer.byteLength(unit.text), 0),
        warnings: [...result.warnings, ...prepared.warnings], failureCode: null },
        $inc: { version: 1 } }, { new: true }).lean();
    } catch (error) {
      const failureCode = error.code === "reference_processing_cancelled" ? "reference_processing_interrupted" : referenceFailure(error).code;
      await model.findOneAndUpdate(claim(), { $set: { status: "failed", stage: "failed", failureCode, lease: null, leaseUntil: null },
        $inc: { version: 1 } }, { new: true }).lean();
    }
  }
  return {
    start(config, options = {}) {
      if (config?.enabled !== true || stopping) return { enabled: false };
      if (running) return { enabled: true, scheduled: false };
      controller = new AbortController();
      running = processOne(config, controller.signal, options).catch(() => {
        console.error("[Assistant Reference Worker] Processing unavailable; saved work requires recovery");
      }).finally(() => { running = null; controller = null; });
      return { enabled: true, scheduled: true };
    },
    async stop() { stopping = true; controller?.abort(); await running; },
    async idle() { await running; },
  };
}
export const referenceWorker = createReferenceWorker();
