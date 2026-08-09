import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { getFirebaseAdmin } from "../config/firebase.js";
import { drainNotificationOutbox } from "../domains/notification/notificationOutbox.worker.service.js";

const POLL_MS = Math.max(1_000, Number(process.env.NOTIFICATION_OUTBOX_POLL_MS) || 5_000);
const MAX_RECORDS = Math.max(1, Math.min(500, Number(process.env.NOTIFICATION_OUTBOX_MAX_RECORDS) || 50));
const CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.NOTIFICATION_OUTBOX_CONCURRENCY) || 3));

let stopping = false;
let polling = false;
let timer = null;

async function poll() {
  if (stopping || polling) return;
  polling = true;
  try {
    const summary = await drainNotificationOutbox({
      maxRecords: MAX_RECORDS,
      concurrency: CONCURRENCY,
    });
    if (summary.claimed) console.log("[Notification Outbox Worker]", summary);
  } catch (error) {
    console.error("[Notification Outbox Worker] Poll failed:", error?.message || error);
  } finally {
    polling = false;
  }
}

async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required for notification outbox worker");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  console.log(`[Notification Outbox Worker] Connected to DB: ${connection.connection.host}`);
  getFirebaseAdmin();
  await poll();
  timer = setInterval(poll, POLL_MS);
  console.log("[Notification Outbox Worker] Started");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  console.log(`[Notification Outbox Worker] ${signal} received`);
  while (polling) await new Promise((resolve) => setTimeout(resolve, 100));
  await mongoose.connection.close(false);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("[Notification Outbox Worker] Unhandled rejection:", error?.message || error);
  shutdown("unhandledRejection");
});

start().catch((error) => {
  console.error("[Notification Outbox Worker] Failed to start:", error?.message || error);
  process.exit(1);
});
