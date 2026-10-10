import assert from "node:assert/strict";
import test from "node:test";

import { getVideoProviderWorkerConfiguration } from "../../../../src/domains/videos/provider/videoProviderWorkerConfig.js";

test("Video Provider worker defaults to three bounded workers and a database sweep", () => {
  assert.deepEqual(getVideoProviderWorkerConfiguration({}), {
    orphanRecoveryEnabled: false,
    concurrency: 3,
    leaseMs: 300_000,
    sweepIntervalMs: 10_000,
    sweepBatchSize: 100,
  });
});

test("automatic orphan recovery is explicitly opt-in and rejects malformed settings", () => {
  assert.equal(getVideoProviderWorkerConfiguration({ VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED: " true " }).orphanRecoveryEnabled, true);
  assert.equal(getVideoProviderWorkerConfiguration({ VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED: false }).orphanRecoveryEnabled, false);
  for (const value of ["1", "yes", "enabled"]) {
    assert.throws(() => getVideoProviderWorkerConfiguration({ VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED: value }), /must be true or false/);
  }
});

test("Video Provider worker rejects invalid concurrency instead of silently widening it", () => {
  assert.throws(
    () => getVideoProviderWorkerConfiguration({ VIDEO_PROVIDER_WORKER_CONCURRENCY: "30" }),
    /VIDEO_PROVIDER_WORKER_CONCURRENCY/,
  );
});
