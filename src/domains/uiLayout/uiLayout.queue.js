import { Queue } from "bullmq";
import { bullMqConfig, createBullMqConnection, isBullMqConfigured } from "../../config/bullmq.js";

export const UI_LAYOUT_QUEUE_NAME = "ui-layout-publish";
export const UI_LAYOUT_JOB_RECONCILE = "reconcile";
export const UI_LAYOUT_JOB_PUBLISH = "publish-scheduled";
let queue = null;
let queueConnection = null;

export function isUiLayoutSchedulingConfigured() {
  return isBullMqConfigured();
}

export function getUiLayoutQueue() {
  if (!queue) {
    queueConnection = createBullMqConnection("ui-layout-publish-queue");
    try {
      queue = new Queue(UI_LAYOUT_QUEUE_NAME, {
        connection: queueConnection,
        prefix: bullMqConfig.prefix,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
          removeOnComplete: { age: 86400, count: 500 },
          removeOnFail: { age: 7 * 86400, count: 500 },
        },
      });
    } catch (error) {
      queueConnection.disconnect();
      queueConnection = null;
      throw error;
    }
    queue.on("error", (error) => console.error("[UI Layout Queue]", error.message));
  }
  return queue;
}

export async function enqueueUiLayoutSchedule(draft, { reconcile = false } = {}) {
  const id = draft.draft_id ?? draft.id;
  const jobId = `ui-layout-${id}-${draft.revision}` +
    (reconcile ? `-reconcile-${Math.floor(Date.now() / 60_000)}` : "");
  return getUiLayoutQueue().add(UI_LAYOUT_JOB_PUBLISH,
    { draftId: id, revision: draft.revision },
    { jobId,
      delay: Math.max(0, new Date(draft.scheduled_for ?? draft.scheduledFor).getTime() - Date.now()) });
}

export async function startUiLayoutReconciliation() {
  const queue = getUiLayoutQueue();
  await queue.upsertJobScheduler("ui-layout-schedule-reconcile",
    { every: 60_000 },
    { name: UI_LAYOUT_JOB_RECONCILE, data: {} });
  await queue.add(UI_LAYOUT_JOB_RECONCILE, {}, { jobId: `ui-layout-reconcile-start-${Date.now()}` });
}

export async function closeUiLayoutQueue() {
  try {
    await queue?.close();
  } finally {
    queueConnection?.disconnect();
    queueConnection = null;
    queue = null;
  }
}
