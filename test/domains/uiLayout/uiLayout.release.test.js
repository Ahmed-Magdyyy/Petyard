import test from "node:test";
import assert from "node:assert/strict";
import { createUiLayoutReleaseService } from "../../../src/domains/uiLayout/uiLayout.release.service.js";

const input = { id: "draft", revision: 8, changeNote: "Release", idempotencyKey: "key",
  actorId: "admin", requestId: "request" };

test("release operation passes immediate publication to the transactional service", async () => {
  const publication = { version_id: "version" };
  const release = createUiLayoutReleaseService({
    service: { async publish(value) { assert.deepEqual(value, input); return publication; } },
    enqueue() { assert.fail("Immediate publication must not enqueue a schedule"); },
  });
  assert.equal(await release.publishDraft({ ...input, mode: "now" }), publication);
  for (const invalid of [{ mode: "other" }, { mode: "now", scheduledFor: null }]) {
    await assert.rejects(release.publishDraft({ ...input, ...invalid }),
      (error) => error.code === "UI_PUBLISH_INVALID_MODE" && error.statusCode === 400);
  }
});

test("schedule is persisted before enqueue and queue failure remains an accepted pending result", async () => {
  const scheduledFor = "2026-10-02T12:00:00Z";
  const events = [];
  const result = { draft_id: "draft", revision: 8, status: "scheduled", scheduled_for: scheduledFor };
  const release = createUiLayoutReleaseService({
    isSchedulingConfigured: () => true,
    service: { async schedule(value) {
      assert.deepEqual(value, { ...input, scheduledFor });
      events.push("persisted");
      return result;
    } },
    async enqueue(value) {
      assert.deepEqual(events, ["persisted"]);
      assert.equal(value, result);
      events.push("enqueue");
      throw Object.assign(new Error("queue unavailable"), { code: "TEST_QUEUE_DOWN" });
    },
    logError(_message, details) {
      assert.deepEqual(details, { draftId: "draft", requestId: "request", code: "TEST_QUEUE_DOWN" });
      events.push("logged");
    },
  });
  assert.deepEqual(await release.publishDraft({ ...input, mode: "schedule", scheduledFor }),
    { ...result, queue_pending: true });
  assert.deepEqual(events, ["persisted", "enqueue", "logged"]);
});

test("unconfigured scheduling and persistence failures never enqueue", async () => {
  const unavailable = createUiLayoutReleaseService({
    isSchedulingConfigured: () => false,
    service: { schedule() { assert.fail("Unavailable schedule must not be persisted"); } },
    enqueue() { assert.fail("Unavailable schedule must not be enqueued"); },
  });
  await assert.rejects(unavailable.publishDraft({ ...input, mode: "schedule" }),
    (error) => error.code === "UI_SCHEDULE_UNAVAILABLE" && error.statusCode === 503);
  const failure = new Error("transaction rejected");
  const rejected = createUiLayoutReleaseService({
    isSchedulingConfigured: () => true,
    service: { async schedule() { throw failure; } },
    enqueue() { assert.fail("Rejected schedule must not be enqueued"); },
  });
  await assert.rejects(rejected.publishDraft({ ...input, mode: "schedule" }), (error) => error === failure);
});

test("successful schedule enqueue preserves the accepted response without pending metadata", async () => {
  const result = { draft_id: "draft", status: "scheduled", revision: 8 };
  let enqueued = false;
  const release = createUiLayoutReleaseService({
    isSchedulingConfigured: () => true,
    service: { async schedule() { return result; } },
    async enqueue(value) { assert.equal(value, result); enqueued = true; },
  });
  assert.equal(await release.publishDraft({ ...input, mode: "schedule" }), result);
  assert.equal(enqueued, true);
  assert.equal(result.queue_pending, undefined);
});
