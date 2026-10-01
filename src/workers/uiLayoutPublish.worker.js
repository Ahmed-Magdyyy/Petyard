import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { Worker } from "bullmq";
import { bullMqConfig, createBullMqConnection, isBullMqConfigured } from "../config/bullmq.js";
import { UiLayoutDraftModel, UiLayoutActiveModel, UiLayoutPublicationModel,
  UiLayoutOperationModel } from "../domains/uiLayout/uiLayout.model.js";
import { createUiLayoutJobProcessor } from "../domains/uiLayout/uiLayout.jobs.js";
import {
  UI_LAYOUT_QUEUE_NAME, getUiLayoutQueue, startUiLayoutReconciliation,
  closeUiLayoutQueue,
} from "../domains/uiLayout/uiLayout.queue.js";

let worker;
let connection;
let stopping = false;

async function start() {
  if (process.env.UI_BUILDER_PUBLISH_ENABLED !== "true") {
    throw new Error("UI_BUILDER_PUBLISH_ENABLED_REQUIRED");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  if (!isBullMqConfigured()) throw new Error("REDIS_URL_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI);
  await Promise.all([
    UiLayoutDraftModel.createIndexes(), UiLayoutActiveModel.createIndexes(),
    UiLayoutPublicationModel.createIndexes(), UiLayoutOperationModel.createIndexes(),
  ]);
  connection = createBullMqConnection("ui-layout-publish-worker");
  const processor = createUiLayoutJobProcessor();
  worker = new Worker(UI_LAYOUT_QUEUE_NAME, processor.process,
    { connection, prefix: bullMqConfig.prefix, concurrency: 1 });
  worker.on("failed", async (job, error) => {
    console.error("[UI Layout Publish Worker] Job failed", {
      jobId: job?.id, code: error?.message || "UNKNOWN",
    });
    try {
      await processor.handleFailed(job);
    } catch (recordError) {
      console.error("[UI Layout Publish Worker] Could not record final failure", recordError?.message);
    }
  });
  worker.on("error", (error) => {
    console.error("[UI Layout Publish Worker] Worker error", error?.message || "UNKNOWN");
  });
  await getUiLayoutQueue().waitUntilReady();
  await startUiLayoutReconciliation();
  console.log("[UI Layout Publish Worker] Started");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log("[UI Layout Publish Worker] Stopping", signal);
  await Promise.allSettled([worker?.close(), closeUiLayoutQueue(), connection?.quit()]);
  await mongoose.connection.close(false);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("[UI Layout Publish Worker] Unhandled rejection", error?.message || "UNKNOWN");
  shutdown("unhandledRejection");
});

start().catch((error) => {
  console.error("[UI Layout Publish Worker] Failed to start", error?.message || "UNKNOWN");
  process.exit(1);
});
