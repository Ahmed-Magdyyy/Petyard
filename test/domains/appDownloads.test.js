import assert from "node:assert/strict";
import test from "node:test";
import { resolveAndroidSyncFrom } from "../../src/domains/appDownloads/appDownloads.service.js";

test("Android sync expands behind a stale latest stored date", () => {
  assert.equal(
    resolveAndroidSyncFrom({
      defaultFrom: "2026-07-24",
      latestDateKey: "2026-07-23",
      overlapDays: 7,
    }),
    "2026-07-16",
  );
});

test("Android sync retains the normal lookback when data is fresh", () => {
  assert.equal(
    resolveAndroidSyncFrom({
      defaultFrom: "2026-07-24",
      latestDateKey: "2026-08-06",
      overlapDays: 7,
    }),
    "2026-07-24",
  );
});

test("Android sync continues reconciling an old watermark after a long outage", () => {
  assert.equal(
    resolveAndroidSyncFrom({
      defaultFrom: "2026-08-18",
      latestDateKey: "2026-07-23",
      overlapDays: 7,
    }),
    "2026-07-16",
  );
});

test("an explicit Android backfill range takes precedence", () => {
  assert.equal(
    resolveAndroidSyncFrom({
      requestedFrom: "2026-06-01",
      defaultFrom: "2026-07-24",
      latestDateKey: "2026-07-23",
      overlapDays: 7,
    }),
    "2026-06-01",
  );
});

test("Android sync falls back to the normal lookback without stored data", () => {
  assert.equal(
    resolveAndroidSyncFrom({
      defaultFrom: "2026-07-24",
      latestDateKey: null,
      overlapDays: 7,
    }),
    "2026-07-24",
  );
});
