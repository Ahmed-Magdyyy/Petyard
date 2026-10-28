import { Worker } from "node:worker_threads";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { inspectReferenceFile } from "./assistant.reference-file.js";

function extractionLimits(limits) {
  if (![limits?.maxPages, limits?.maxArchiveEntries, limits?.maxExpandedBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      !Number.isSafeInteger(limits?.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 60_000) {
    reject("reference_configuration_required", 503);
  }
}

export async function extractReferenceFile(file, limits, { signal } = {}) {
  const inspected = inspectReferenceFile(file, limits);
  extractionLimits(limits);
  if (signal?.aborted) reject("reference_processing_cancelled", 409);
  const { text, ...source } = inspected;
  if (text !== null) return { ...source, units: [{ locator: "Document text", text }], warnings: [] };
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) reject("reference_runtime_unsupported", 503);

  return new Promise((resolve, rejectPromise) => {
    const worker = new Worker(new URL("./assistant.reference-extract.worker.js", import.meta.url), {
      workerData: { buffer: file.buffer, format: source.format, limits },
      env: {}, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    // Parser diagnostics can contain document content; expose only stable error codes.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { await worker.terminate(); }
      catch { error ??= new AssistantError("reference_processing_failed", 503); }
      if (error) rejectPromise(error);
      else resolve({ ...source, ...result });
    };
    const abort = () => { void finish(new AssistantError("reference_processing_cancelled", 409)); };
    const timer = setTimeout(() => { void finish(new AssistantError("reference_processing_timeout", 504)); }, limits.timeoutMs);
    worker.once("message", message => {
      if (message.error) void finish(new AssistantError(message.error.code, message.error.status));
      else void finish(null, message.result);
    });
    worker.once("error", error => { void finish(new AssistantError(error.code === "ERR_WORKER_OUT_OF_MEMORY"
      ? "reference_processing_limit" : "reference_processing_failed", error.code === "ERR_WORKER_OUT_OF_MEMORY" ? 413 : 503)); });
    worker.once("exit", () => { void finish(new AssistantError("reference_processing_failed", 503)); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
