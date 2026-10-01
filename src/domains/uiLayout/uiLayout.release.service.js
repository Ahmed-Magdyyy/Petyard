import { UiLayoutError } from "./uiLayout.error.js";
import { uiLayoutService } from "./uiLayout.service.js";
import { enqueueUiLayoutSchedule, isUiLayoutSchedulingConfigured } from "./uiLayout.queue.js";

// Keep queue delivery separate from the transaction that durably accepts a schedule.
export function createUiLayoutReleaseService({
  service = uiLayoutService,
  enqueue = enqueueUiLayoutSchedule,
  isSchedulingConfigured = isUiLayoutSchedulingConfigured,
  logError = (...args) => console.error(...args),
} = {}) {
  async function publishDraft({ mode, scheduledFor, ...input }) {
    if (mode === "schedule") {
      if (!isSchedulingConfigured()) {
        throw new UiLayoutError("UI_SCHEDULE_UNAVAILABLE", "Scheduling is not configured.", 503);
      }
      const data = await service.schedule({ ...input, scheduledFor });
      try {
        await enqueue(data);
      } catch (error) {
        logError("[UI Layout] Schedule enqueue pending reconciliation", {
          draftId: input.id, requestId: input.requestId, code: error.code || "QUEUE_ERROR",
        });
        data.queue_pending = true;
      }
      return data;
    }
    if (mode !== "now" || scheduledFor !== undefined) {
      throw new UiLayoutError("UI_PUBLISH_INVALID_MODE", "mode must be now or schedule.", 400);
    }
    return service.publish(input);
  }

  return { publishDraft };
}

export const uiLayoutReleaseService = createUiLayoutReleaseService();
