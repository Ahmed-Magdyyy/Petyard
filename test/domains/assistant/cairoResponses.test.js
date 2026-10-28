import test from "node:test";
import assert from "node:assert/strict";
import { cairoTimestampReplacer, egyptTimezoneReplacer } from "../../../src/shared/utils/egyptTimezone.js";

test("assistant response timestamps use the existing Cairo conversion in winter and summer", () => {
  const source = { createdAt: "2026-01-15T10:00:00.000Z", generatedAt: "2026-07-15T10:00:00.000Z",
    period: { start: "2026-01-15T10:00:00.000Z", endExclusive: "2026-07-15T10:00:00.000Z" },
    batch: { dispatchDeadline: "2026-07-15T10:00:00.000Z", reconciliation: { at: "2026-07-15T10:00:00.000Z" } } };
  const value = JSON.parse(JSON.stringify(source, cairoTimestampReplacer));
  assert.equal(value.createdAt, "2026-01-15T12:00:00.000");
  assert.equal(value.generatedAt, "2026-07-15T13:00:00.000");
  assert.equal(value.period.start, value.createdAt); assert.equal(value.period.endExclusive, value.generatedAt);
  assert.equal(value.batch.dispatchDeadline, value.generatedAt); assert.equal(value.batch.reconciliation.at, value.generatedAt);
  assert.equal(source.createdAt, "2026-01-15T10:00:00.000Z");
});

test("all private response timestamp keys convert once while literal text, dates and nulls stay intact", () => {
  const utc = "2026-07-15T10:00:00.000Z", cairo = "2026-07-15T13:00:00.000";
  const keys = ["createdAt", "updatedAt", "expiresAt", "resetsAt", "retryAt", "generatedAt", "start", "endExclusive",
    "observedThroughExclusive", "observedThrough", "dispatchDeadline", "nextAttemptAt", "searchVerifiedAt", "activatedAt", "at"];
  const source = { ...Object.fromEntries(keys.map(key => [key,utc])), text: utc, title: utc, preview: utc, name: utc,
    reason: utc, date: "2026-07-15", month: "2026-07", missing: null, invalid: "not-a-date" };
  const value = JSON.parse(JSON.stringify(source, cairoTimestampReplacer));
  for (const key of keys) assert.equal(value[key], cairo, key);
  for (const key of ["text","title","preview","name","reason","date","month","missing","invalid"]) assert.equal(value[key],source[key],key);
  assert.deepEqual(JSON.parse(JSON.stringify(value,cairoTimestampReplacer)),value);
  assert.equal(egyptTimezoneReplacer("createdAt",utc),cairo);
});
