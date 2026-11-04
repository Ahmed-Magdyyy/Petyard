import test from "node:test";
import assert from "node:assert/strict";
import { assistantWakeChannel, createAssistantWake } from "../../../src/domains/assistant/shared/assistant.wake.js";

test("assistant wake requires an explicit environment prefix and can be disabled", () => {
  const env = { REDIS_URL: "redis://localhost:6379/1", BULLMQ_QUEUE_PREFIX: "petyard-test" };
  assert.equal(assistantWakeChannel(env), "petyard-test:assistant:queued");
  assert.equal(assistantWakeChannel({ ...env, BULLMQ_QUEUE_PREFIX: "petyard" }), "petyard:assistant:queued");
  assert.equal(assistantWakeChannel({ ...env, BULLMQ_QUEUE_PREFIX: "" }), null);
  assert.equal(assistantWakeChannel({ ...env, REDIS_URL: "" }), null);
  assert.equal(assistantWakeChannel({ ...env, ASSISTANT_REDIS_WAKE_ENABLED: "false" }), null);
});

test("wake interrupts an idle wait and coalesces signals received during work", async () => {
  const wake = createAssistantWake();
  const idle = wake.wait(1000);
  wake.signal();
  assert.equal(await idle, "redis");
  wake.signal();
  wake.signal();
  assert.equal(await wake.wait(1000), "redis");
  assert.equal(await wake.wait(1), "poll");
});

test("a missed signal still polls and shutdown releases the current wait", async () => {
  const wake = createAssistantWake();
  assert.equal(await wake.wait(1), "poll");
  const idle = wake.wait(1000);
  wake.stop();
  assert.equal(await idle, "shutdown");
});
