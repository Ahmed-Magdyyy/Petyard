import IORedis from "ioredis";
import { parseBoundedInt } from "../shared/utils/env.js";

const DEFAULT_QUEUE_PREFIX = "petyard";

export const bullMqConfig = {
  redisUrl: process.env.REDIS_URL || "",
  prefix: process.env.BULLMQ_QUEUE_PREFIX || DEFAULT_QUEUE_PREFIX,
  notificationBroadcast: {
    waitTimeoutMs: parseBoundedInt(
      process.env.NOTIFICATION_BROADCAST_WAIT_TIMEOUT_MS,
      10 * 60 * 1000,
      30 * 1000,
      30 * 60 * 1000,
    ),
    attempts: parseBoundedInt(
      process.env.NOTIFICATION_BROADCAST_JOB_ATTEMPTS,
      1,
      1,
      5,
    ),
    backoffMs: parseBoundedInt(
      process.env.NOTIFICATION_BROADCAST_JOB_BACKOFF_MS,
      30 * 1000,
      1000,
      5 * 60 * 1000,
    ),
    workerConcurrency: parseBoundedInt(
      process.env.NOTIFICATION_BROADCAST_WORKER_CONCURRENCY,
      1,
      1,
      3,
    ),
  },
};

export function isBullMqConfigured() {
  return Boolean(bullMqConfig.redisUrl);
}

export function createBullMqConnection(connectionName) {
  if (!bullMqConfig.redisUrl) {
    throw new Error("REDIS_URL is required for BullMQ queues");
  }

  return new IORedis(bullMqConfig.redisUrl, {
    connectionName,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}
