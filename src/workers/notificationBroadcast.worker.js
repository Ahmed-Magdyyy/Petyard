import "@dotenvx/dotenvx/config";
import mongoose from "mongoose";
import { Worker } from "bullmq";
import {
  bullMqConfig,
  createBullMqConnection,
} from "../config/bullmq.js";
import { getFirebaseAdmin } from "../config/firebase.js";
import {
  dispatchBroadcastNotification,
  dispatchBroadcastTopicBucket,
  prepareBroadcastNotificationCampaign,
} from "../domains/notification/notificationDispatcher.js";
import {
  NOTIFICATION_BROADCAST_JOB_NAME,
  NOTIFICATION_BROADCAST_PREPARE_JOB_NAME,
  NOTIFICATION_BROADCAST_QUEUE_NAME,
  NOTIFICATION_BROADCAST_TOPIC_BUCKET_JOB_NAME,
} from "../domains/notification/notificationBroadcast.queue.js";

let worker = null;
let workerConnection = null;
let shuttingDown = false;

async function connectDatabase() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required for notification broadcast worker");
  }

  const conn = await mongoose.connect(process.env.MONGO_URI);
  console.log(
    `[Notification Broadcast Worker] Connected to DB: ${conn.connection.host}`,
  );
}

async function startWorker() {
  await connectDatabase();
  getFirebaseAdmin();

  workerConnection = createBullMqConnection("notification-broadcast-worker");

  worker = new Worker(
    NOTIFICATION_BROADCAST_QUEUE_NAME,
    async (job) => {
      console.log(`[Notification Broadcast Worker] Started job ${job.id}`);

      let result;
      if (job.name === NOTIFICATION_BROADCAST_PREPARE_JOB_NAME) {
        result = await prepareBroadcastNotificationCampaign(job.data);
      } else if (job.name === NOTIFICATION_BROADCAST_TOPIC_BUCKET_JOB_NAME) {
        result = await dispatchBroadcastTopicBucket(job.data);
      } else if (job.name === NOTIFICATION_BROADCAST_JOB_NAME) {
        result = await dispatchBroadcastNotification(job.data);
      } else {
        throw new Error(`Unsupported notification job: ${job.name}`);
      }

      console.log(`[Notification Broadcast Worker] Completed job ${job.id}`);
      return result;
    },
    {
      connection: workerConnection,
      prefix: bullMqConfig.prefix,
      concurrency: bullMqConfig.notificationBroadcast.workerConcurrency,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[Notification Broadcast Worker] Job ${job?.id || "unknown"} failed:`,
      err?.message || err,
    );
  });

  worker.on("error", (err) => {
    console.error("[Notification Broadcast Worker] Error:", err.message);
  });

  console.log("[Notification Broadcast Worker] Started");
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[Notification Broadcast Worker] ${signal} received`);

  await Promise.allSettled([
    worker?.close(),
    workerConnection?.quit(),
    mongoose.connection.close(false),
  ]);

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error(
    "[Notification Broadcast Worker] Unhandled rejection:",
    err?.message || err,
  );
  shutdown("unhandledRejection");
});

startWorker().catch((err) => {
  console.error(
    "[Notification Broadcast Worker] Failed to start:",
    err?.message || err,
  );
  process.exit(1);
});
