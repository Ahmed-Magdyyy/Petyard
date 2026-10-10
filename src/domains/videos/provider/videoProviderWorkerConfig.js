function boundedInteger(environment, name, fallback, min, max) {
  const raw = environment[name];
  if (raw == null || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(String(raw))) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function getVideoProviderWorkerConfiguration(environment = process.env) {
  const rawOrphanRecovery = environment.VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED;
  const normalized = rawOrphanRecovery == null ? "" : String(rawOrphanRecovery).trim().toLowerCase();
  if (!["", "true", "false"].includes(normalized)) {
    throw new TypeError("VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED must be true or false");
  }
  return {
    orphanRecoveryEnabled: normalized === "true",
    concurrency: boundedInteger(
      environment,
      "VIDEO_PROVIDER_WORKER_CONCURRENCY",
      3,
      1,
      5,
    ),
    leaseMs: boundedInteger(
      environment,
      "VIDEO_PROVIDER_OPERATION_LEASE_MS",
      300_000,
      120_000,
      3_600_000,
    ),
    sweepIntervalMs: boundedInteger(
      environment,
      "VIDEO_PROVIDER_SWEEP_INTERVAL_MS",
      10_000,
      1_000,
      60_000,
    ),
    sweepBatchSize: boundedInteger(
      environment,
      "VIDEO_PROVIDER_SWEEP_BATCH_SIZE",
      100,
      1,
      500,
    ),
  };
}
