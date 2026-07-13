import { Queue, QueueEvents } from "bullmq";
import crypto from "crypto";
import {
  bullMqConfig,
  createBullMqConnection,
  isBullMqConfigured,
} from "../../config/bullmq.js";
import {
  broadcastTopicConfig,
  getBroadcastBucketDelayMs,
  getBroadcastTopicBuckets,
} from "./notificationTopics.service.js";

export const NOTIFICATION_BROADCAST_QUEUE_NAME = "notification-broadcast";
export const NOTIFICATION_BROADCAST_JOB_NAME = "send-broadcast";
export const NOTIFICATION_BROADCAST_PREPARE_JOB_NAME = "prepare-broadcast";
export const NOTIFICATION_BROADCAST_TOPIC_BUCKET_JOB_NAME =
  "send-broadcast-topic-bucket";

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
    NOTIFICATION_BROADCAST_PREPARE_JOB_NAME,
    {
      ...payload,
      campaignId: payload?.campaignId || crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
    },
  );

  return job.waitUntilFinished(
    events,
    bullMqConfig.notificationBroadcast.waitTimeoutMs,
  );
}

export async function enqueueNotificationBroadcast(payload) {
  const job = await getNotificationBroadcastQueue().add(
    NOTIFICATION_BROADCAST_PREPARE_JOB_NAME,
    {
      ...payload,
      campaignId: payload?.campaignId || crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
    },
  );

  return {
    queued: true,
    jobId: job.id,
    campaignId: job.data.campaignId,
    queueName: NOTIFICATION_BROADCAST_QUEUE_NAME,
  };
}

export async function enqueueNotificationBroadcastTopicBucketJobs(payload) {
  const campaignId = payload?.campaignId || crypto.randomUUID();
  const buckets = getBroadcastTopicBuckets();
  const queue = getNotificationBroadcastQueue();

  const jobs = buckets.map((bucketInfo, index) => ({
    name: NOTIFICATION_BROADCAST_TOPIC_BUCKET_JOB_NAME,
    data: {
      ...payload,
      campaignId,
      bucket: bucketInfo.bucket,
      topic: bucketInfo.topic,
      queuedAt: new Date().toISOString(),
    },
    opts: {
      jobId: `notification-broadcast-${campaignId}-bucket-${bucketInfo.bucket}`,
      delay: getBroadcastBucketDelayMs(index),
    },
  }));

  await queue.addBulk(jobs);

  return {
    campaignId,
    bucketCount: buckets.length,
    spreadWindowMs: broadcastTopicConfig.spreadWindowMs,
    queuedBucketJobCount: jobs.length,
  };
}

export async function closeNotificationBroadcastQueue() {
  await Promise.allSettled([
    queueEvents?.close(),
    queue?.close(),
  ]);
  queueEvents = null;
  queue = null;
}
