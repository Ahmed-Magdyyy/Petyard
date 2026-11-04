import mongoose from "mongoose";
import "../domains/brand/brand.model.js";
import "../domains/category/category.model.js";
import "../domains/subcategory/subcategory.model.js";
import { loadAssistantConfig } from "../domains/assistant/shared/assistant.config.js";
import { initializeAssistantStore } from "../domains/assistant/shared/assistant.store.js";
import { drainAssistantWork } from "../domains/assistant/assistant.runtime.js";
import { referenceWorker } from "../domains/assistant/references/assistant.reference-worker.js";
import { catalogIndexer } from "../domains/assistant/products/assistant.catalog-indexer.js";
import { createAssistantWake, subscribeAssistantWake } from "../domains/assistant/shared/assistant.wake.js";

let stopping = false;
let wakeSubscriber;
const wake = createAssistantWake();
let pickupTrigger = "startup";
const recordCustomerTiming = timing => console.info("[Assistant Timing]", JSON.stringify({ ...timing, pickupTrigger }));
const maintenanceIntervalMs = 10_000;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; wake.stop(); });

async function start() {
  // A chat or retention flag must be present before any secret-file loader runs.
  if (process.env.ASSISTANT_ENABLED !== "true" && process.env.ASSISTANT_BOOKING_RETENTION_ENABLED !== "true" &&
      process.env.ASSISTANT_REFERENCES_ENABLED !== "true") { console.log("[Assistant Worker] Disabled"); return; }
  await import("@dotenvx/dotenvx/config");
  const config = loadAssistantConfig();
  if (!config.enabled && config.bookingRetentionEnabled !== true && config.referenceRetentionEnabled !== true) { console.log("[Assistant Worker] Disabled"); return; }
  if (!process.env.MONGO_URI) throw new Error("database_configuration_required");
  await mongoose.connect(process.env.MONGO_URI);
  if (config.enabled) {
    await initializeAssistantStore();
    wakeSubscriber = subscribeAssistantWake(() => wake.signal());
  }
  let nextMaintenance = 0;
  while (!stopping) {
    const runMaintenance = performance.now() >= nextMaintenance;
    try {
      const result = await drainAssistantWork({ recordCustomerTiming, runMaintenance });
      if (result.failed) console.error("[Assistant Worker] Some requests require durable recovery");
    }
    catch { console.error("[Assistant Worker] Poll failed; durable requests require recovery"); }
    finally { if (runMaintenance) nextMaintenance = performance.now() + maintenanceIntervalMs; }
    if (!stopping) pickupTrigger = await wake.wait(config.pollMs ?? 1000);
  }
  wakeSubscriber?.disconnect();
  await Promise.all([referenceWorker.stop(), catalogIndexer.stop()]);
  await mongoose.connection.close(false);
}

start().catch(async () => {
  console.error("[Assistant Worker] Startup failed; assistant remains unavailable");
  wakeSubscriber?.disconnect();
  await Promise.all([referenceWorker.stop(), catalogIndexer.stop()]);
  await mongoose.connection.close(false);
  process.exitCode = 1;
});
