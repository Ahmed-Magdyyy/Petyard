import test from "node:test";
import assert from "node:assert/strict";
import { UnrecoverableError } from "bullmq";
import { createUiLayoutJobProcessor } from "../../../src/domains/uiLayout/uiLayout.jobs.js";
import { UiLayoutError } from "../../../src/domains/uiLayout/uiLayout.error.js";
import {
  UI_LAYOUT_JOB_PUBLISH, UI_LAYOUT_JOB_RECONCILE,
} from "../../../src/domains/uiLayout/uiLayout.queue.js";

function fixture({ publish = async () => ({ version_id: "new-version" }) } = {}) {
  const draft = { id: "draft-1", layoutId: "layout-1", revision: 2, status: "scheduled",
    scheduleFailure: null, scheduledFor: new Date("2026-09-24T00:03:00Z"), updatedBy: "admin-1" };
  const notifications = [];
  const audits = [];
  const queued = [];
  const draftModel = {
    async findOne(filter) {
      return draft.id === filter.id && draft.revision === filter.revision &&
        draft.status === filter.status && draft.scheduleFailure === null &&
        draft.scheduledFor <= filter.scheduledFor.$lte ? draft : null;
    },
    async findOneAndUpdate(filter, update) {
      if (draft.id !== filter.id || draft.revision !== filter.revision ||
        draft.status !== filter.status || draft.scheduleFailure !== null) return null;
      draft.scheduleFailure = update.$set.scheduleFailure;
      return draft;
    },
  };
  const service = { dueSchedules: async () => [draft], publishScheduledDraft: publish };
  const processor = createUiLayoutJobProcessor({ draftModel, service,
    auditModel: { create: async (entry) => { audits.push(entry); } },
    enqueue: async (item, options) => { queued.push({ item, options }); },
    notify: async (item) => { notifications.push(item.id); return { inApp: { success: true } }; },
    now: () => new Date("2026-09-24T00:03:01Z"),
  });
  return { processor, draft, notifications, queued, audits };
}

const publishJob = { name: UI_LAYOUT_JOB_PUBLISH,
  data: { draftId: "draft-1", revision: 2 }, attemptsMade: 1, opts: { attempts: 3 } };

test("scheduled worker reconciles due drafts and skips stale jobs", async () => {
  const { processor, draft, queued } = fixture();
  assert.deepEqual(await processor.process({ name: UI_LAYOUT_JOB_RECONCILE }), { queued: 1 });
  assert.equal(queued[0].item, draft);
  assert.deepEqual(queued[0].options, { reconcile: true });
  assert.deepEqual(await processor.process(publishJob), { version_id: "new-version" });
  draft.scheduleFailure = "REFERENCE_NOT_PUBLIC";
  assert.deepEqual(await processor.process(publishJob), { skipped: true });
});

test("scheduled worker rejects invalid jobs without retrying", async () => {
  const { processor } = fixture();
  await assert.rejects(processor.process({ name: UI_LAYOUT_JOB_PUBLISH,
    data: { draftId: "draft-1", revision: 2, unexpected: true } }),
  (error) => error instanceof UnrecoverableError && error.message === "UI_LAYOUT_JOB_INVALID");
  assert.equal(await processor.handleFailed({ name: UI_LAYOUT_JOB_PUBLISH,
    data: {}, attemptsMade: 3, opts: { attempts: 3 } }), false);
});

test("publish validation failure records one failure and alerts the admin", async () => {
  const { processor, draft, notifications, audits } = fixture({ publish: async () => {
    throw new UiLayoutError("UI_LAYOUT_VALIDATION_FAILED", "Invalid reference", 422);
  } });
  await assert.rejects(processor.process(publishJob),
    (error) => error instanceof UnrecoverableError &&
      error.message === "UI_LAYOUT_VALIDATION_FAILED");
  assert.equal(draft.scheduleFailure, "UI_LAYOUT_VALIDATION_FAILED");
  assert.deepEqual(notifications, [draft.id]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "schedule_failed");
  assert.deepEqual(audits[0].details, { revision: 2, code: "UI_LAYOUT_VALIDATION_FAILED" });
  assert.equal(await processor.handleFailed({ ...publishJob, attemptsMade: 3 }), false);
  assert.deepEqual(notifications, [draft.id]);
  assert.equal(audits.length, 1);
});

test("transient failure remains retryable until attempts are exhausted", async () => {
  const { processor, draft, notifications } = fixture({ publish: async () => {
    throw new Error("temporary database outage");
  } });
  await assert.rejects(processor.process(publishJob), /temporary database outage/);
  assert.equal(draft.scheduleFailure, null);
  assert.equal(await processor.handleFailed(publishJob), false);
  assert.equal(await processor.handleFailed({ ...publishJob, attemptsMade: 3 }), true);
  assert.equal(draft.scheduleFailure, "UI_SCHEDULE_RETRIES_EXHAUSTED");
  assert.deepEqual(notifications, [draft.id]);
});
