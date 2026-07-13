import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { getFirebaseAdmin } from "../src/config/firebase.js";
import { syncBroadcastTopicsForDevices } from "../src/domains/notification/notificationTopics.service.js";

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  const conn = await mongoose.connect(process.env.MONGO_URI);
  console.log(`[Notification Topics Sync] Connected to DB: ${conn.connection.host}`);

  getFirebaseAdmin();

  const result = await syncBroadcastTopicsForDevices();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error("[Notification Topics Sync] Failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close(false);
  });
