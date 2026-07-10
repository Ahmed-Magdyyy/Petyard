import { Queue, QueueEvents } from "bullmq";
import {
  bullMqConfig,
  createBullMqConnection,
  isBullMqConfigured,
} from "../../config/bullmq.js";

export const NOTIFICATION_BROADCAST_QUEUE_NAME = "notification:broadcast";
export const NOTIFICATION_BROADCAST_JOB_NAME = "send-broadcast";

let queue = null;
let queueEvents = null;

function createDefaultJobOptions() {
  const config = bullMqConfig.notificationBroadcast;

  return {
    attempts: config.attempts,
    backoff: {
      type: "fixed",
      delay: config.backoffMs,
    },
    removeOnComplete: {
      age: 60 * 60,
      count: 100,
    },
    removeOnFail: {
      age: 24 * 60 * 60,
      count: 1000,
    },
  };
}

export function isNotificationBroadcastQueueConfigured() {
  return isBullMqConfigured();
}

export function getNotificationBroadcastQueue() {
  if (!queue) {
    queue = new Queue(NOTIFICATION_BROADCAST_QUEUE_NAME, {
      connection: createBullMqConnection("notification-broadcast-queue"),
      prefix: bullMqConfig.prefix,
      defaultJobOptions: createDefaultJobOptions(),
    });

    queue.on("error", (err) => {
      console.error("[Notification Broadcast Queue] Error:", err.message);
    });
  }

  return queue;
}

export function getNotificationBroadcastQueueEvents() {
  if (!queueEvents) {
    queueEvents = new QueueEvents(NOTIFICATION_BROADCAST_QUEUE_NAME, {
      connection: createBullMqConnection("notification-broadcast-events"),
      prefix: bullMqConfig.prefix,
    });

    queueEvents.on("error", (err) => {
      console.error("[Notification Broadcast QueueEvents] Error:", err.message);
    });
  }

  return queueEvents;
}

export async function enqueueNotificationBroadcastAndWait(payload) {
  const events = getNotificationBroadcastQueueEvents();
  await events.waitUntilReady();

  const job = await getNotificationBroadcastQueue().add(
    NOTIFICATION_BROADCAST_JOB_NAME,
    payload,
  );

  return job.waitUntilFinished(
    events,
    bullMqConfig.notificationBroadcast.waitTimeoutMs,
  );
}

export async function closeNotificationBroadcastQueue() {
  await Promise.allSettled([
    queueEvents?.close(),
    queue?.close(),
  ]);
  queueEvents = null;
  queue = null;
}
