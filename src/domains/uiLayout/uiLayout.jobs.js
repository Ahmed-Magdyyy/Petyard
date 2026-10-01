import { UnrecoverableError } from "bullmq";
import { UiLayoutDraftModel, UiLayoutAuditModel } from "./uiLayout.model.js";
import { uiLayoutService } from "./uiLayout.service.js";
import { UiLayoutError } from "./uiLayout.error.js";
import {
  UI_LAYOUT_JOB_PUBLISH, UI_LAYOUT_JOB_RECONCILE, enqueueUiLayoutSchedule,
} from "./uiLayout.queue.js";

async function notifyScheduleFailure(draft) {
  const { dispatchNotificationToUsers } = await import(
    "../notification/notificationDispatcher.js"
  );
  return dispatchNotificationToUsers({
    userIds: [String(draft.updatedBy)],
    notification: {
      title_en: "Home layout schedule failed",
      title_ar: "فشل نشر تخطيط الصفحة الرئيسية",
      body_en: "The scheduled Home layout was not published. Review the draft in UI Builder.",
      body_ar: "لم يتم نشر تخطيط الصفحة الرئيسية المجدول. راجع المسودة في أداة التصميم.",
    },
    icon: "system",
    source: { domain: "ui_layout", event: "scheduled_publish_failed", referenceId: draft.id },
    channels: { push: false, inApp: true },
  });
}

export function createUiLayoutJobProcessor({
  draftModel = UiLayoutDraftModel,
  auditModel = UiLayoutAuditModel,
  service = uiLayoutService,
  enqueue = enqueueUiLayoutSchedule,
  notify = notifyScheduleFailure,
  now = () => new Date(),
} = {}) {
  async function recordFailure(draftId, revision, code) {
    const draft = await draftModel.findOneAndUpdate({
      id: draftId, revision, status: "scheduled", scheduleFailure: null,
    }, { $set: { scheduleFailure: code } }, { new: true });
    if (draft) {
      try {
        await auditModel.create({ action: "schedule_failed", layoutId: draft.layoutId,
          draftId: draft.id, actorId: null, requestId: null,
          details: { revision, code }, createdAt: now() });
      } catch (error) {
        console.error("[UI Layout Publish Worker] Could not audit schedule failure", error?.message);
      }
    }
    if (!draft?.updatedBy) return Boolean(draft);
    try {
      const result = await notify(draft);
      if (result?.inApp?.success === false) {
        console.error("[UI Layout Publish Worker] Could not notify admin", result.inApp.error);
      }
    } catch (error) {
      console.error("[UI Layout Publish Worker] Could not notify admin", error?.message);
    }
    return true;
  }

  async function process(job) {
    if (job.name === UI_LAYOUT_JOB_RECONCILE) {
      const due = await service.dueSchedules();
      await Promise.all(due.map((draft) => enqueue(draft, { reconcile: true })));
      return { queued: due.length };
    }
    if (job.name !== UI_LAYOUT_JOB_PUBLISH ||
      typeof job.data?.draftId !== "string" ||
      !Number.isSafeInteger(job.data?.revision) ||
      Object.keys(job.data).length !== 2) {
      throw new UnrecoverableError("UI_LAYOUT_JOB_INVALID");
    }
    const draft = await draftModel.findOne({
      id: job.data.draftId, revision: job.data.revision, status: "scheduled",
      scheduleFailure: null, scheduledFor: { $lte: now() },
    });
    if (!draft) return { skipped: true };
    try {
      return await service.publishScheduledDraft(draft);
    } catch (error) {
      if (error instanceof UiLayoutError && error.statusCode < 500) {
        await recordFailure(draft.id, draft.revision, error.code);
        throw new UnrecoverableError(error.code);
      }
      throw error;
    }
  }

  async function handleFailed(job) {
    if (job?.name !== UI_LAYOUT_JOB_PUBLISH ||
      typeof job.data?.draftId !== "string" ||
      !Number.isSafeInteger(job.data?.revision) ||
      !Number.isSafeInteger(job.attemptsMade) ||
      job.attemptsMade < (job.opts?.attempts ?? 1)) return false;
    return recordFailure(job.data.draftId, job.data.revision, "UI_SCHEDULE_RETRIES_EXHAUSTED");
  }

  return { process, handleFailed };
}
