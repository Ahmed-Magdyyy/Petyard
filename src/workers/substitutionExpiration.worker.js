import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { drainSubstitutionExpirations } from "../domains/substitution/substitution.expiration.worker.service.js";

const POLL_MS = Math.max(1_000, Number(process.env.SUBSTITUTION_EXPIRATION_POLL_MS) || 30_000);
const MAX_RECORDS = Math.max(1, Math.min(500, Number(process.env.SUBSTITUTION_EXPIRATION_MAX_RECORDS) || 50));
const CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.SUBSTITUTION_EXPIRATION_CONCURRENCY) || 3));
let stopping = false;
let polling = false;
let timer = null;

async function poll() {
  if (stopping || polling) return;
  polling = true;
  try {
    const result = await drainSubstitutionExpirations({ maxRecords: MAX_RECORDS, concurrency: CONCURRENCY });
    if (result.summary.claimed || result.summary.failures) {
      console.log("[Substitution Expiration Worker]", result.summary);
    }
  } catch (error) {
    console.error("[Substitution Expiration Worker] Poll failed:", error?.message || error);
  } finally {
    polling = false;
  }
}
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  console.log("[Substitution Expiration Worker] " + signal + " received");
  while (polling) await new Promise((resolve) => setTimeout(resolve, 100));
  await mongoose.connection.close(false);
  process.exit(0);
}
async function start() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  console.log("[Substitution Expiration Worker] Connected to DB: " + connection.connection.host);
  await poll();
  timer = setInterval(poll, POLL_MS);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("[Substitution Expiration Worker] Unhandled rejection:", error?.message || error);
  shutdown("unhandledRejection");
});
start().catch((error) => {
  console.error("[Substitution Expiration Worker] Failed to start:", error?.message || error);
  process.exit(1);
});
