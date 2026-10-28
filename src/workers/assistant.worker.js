import mongoose from "mongoose";
import { loadAssistantConfig } from "../domains/assistant/shared/assistant.config.js";
import { initializeAssistantStore } from "../domains/assistant/shared/assistant.store.js";
import { drainAssistantWork } from "../domains/assistant/assistant.runtime.js";
import { referenceWorker } from "../domains/assistant/references/assistant.reference-worker.js";
import { catalogIndexer } from "../domains/assistant/products/assistant.catalog-indexer.js";

let stopping = false;
let wake;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; wake?.(); });

async function start() {
  // A chat or retention flag must be present before any secret-file loader runs.
  if (process.env.ASSISTANT_ENABLED !== "true" && process.env.ASSISTANT_BOOKING_RETENTION_ENABLED !== "true" &&
      process.env.ASSISTANT_REFERENCES_ENABLED !== "true") { console.log("[Assistant Worker] Disabled"); return; }
  await import("@dotenvx/dotenvx/config");
  const config = loadAssistantConfig();
  if (!config.enabled && config.bookingRetentionEnabled !== true && config.referenceRetentionEnabled !== true) { console.log("[Assistant Worker] Disabled"); return; }
  if (!process.env.MONGO_URI) throw new Error("database_configuration_required");
  await mongoose.connect(process.env.MONGO_URI);
  if (config.enabled) await initializeAssistantStore();
  while (!stopping) {
    try {
      const result = await drainAssistantWork();
      if (result.failed) console.error("[Assistant Worker] Some requests require durable recovery");
    }
    catch { console.error("[Assistant Worker] Poll failed; durable requests require recovery"); }
    if (!stopping) await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.pollMs ?? 1000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
  await Promise.all([referenceWorker.stop(), catalogIndexer.stop()]);
  await mongoose.connection.close(false);
}

start().catch(async () => {
  console.error("[Assistant Worker] Startup failed; assistant remains unavailable");
  await Promise.all([referenceWorker.stop(), catalogIndexer.stop()]);
  await mongoose.connection.close(false);
  process.exitCode = 1;
});
