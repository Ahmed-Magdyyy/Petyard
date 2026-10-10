import { Queue } from "bullmq";

import { bullMqConfig, createBullMqConnection } from "../../../config/bullmq.js";

export const VIDEO_PROVIDER_QUEUE_NAME = "video-provider";
export const VIDEO_PROVIDER_JOB_NAME = "process-operation";

let queue;
let connection;

export function getVideoProviderQueue() {
  if (!queue) {
    connection = createBullMqConnection("video-provider-queue", { failFast: true });
    queue = new Queue(VIDEO_PROVIDER_QUEUE_NAME, {
      connection,
      prefix: bullMqConfig.prefix,
    });
    queue.on("error", (error) => {
      console.error("[Video Provider Queue] Error:", error?.code || "REDIS_ERROR");
    });
  }
  return queue;
}

export async function enqueueVideoProviderOperation(operationId, {
  queue: targetQueue = getVideoProviderQueue(),
} = {}) {
  const id = String(operationId);
  if (!/^[a-f\d]{24}$/i.test(id)) {
    throw new TypeError("operationId must be a MongoDB ObjectId");
  }

  return targetQueue.add(
    VIDEO_PROVIDER_JOB_NAME,
    { operationId: id },
    {
      jobId: id,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function closeVideoProviderQueue() {
  await Promise.allSettled([queue?.close(), connection?.quit()]);
  queue = null;
  connection = null;
}

// Mongo has already committed these obligations. Redis failure must not undo
// the write: the provider sweep will rediscover every unqueued operation.
export async function enqueueVideoProviderOperations(operationIds, enqueue = enqueueVideoProviderOperation) {
  for (const operationId of operationIds.filter(Boolean)) {
    try { await enqueue(String(operationId)); } catch { /* Durable Mongo work remains due. */ }
  }
}
