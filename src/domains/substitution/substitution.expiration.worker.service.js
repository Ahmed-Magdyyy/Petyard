import {
  expireSubstitutionRequest,
  findDueSubstitutionExpirationCandidates,
  reconcileExpiredSubstitutionRefundOperations,
} from "./substitution.expiration.service.js";

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

async function pool(items, concurrency, callback) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await callback(items[current]);
      } catch (error) {
        results[current] = { error };
      }
    }
  }));
  return results;
}

export async function drainSubstitutionExpirations({
  maxRecords = 25,
  concurrency = 3,
  now = new Date(),
  findCandidates = findDueSubstitutionExpirationCandidates,
  expire = expireSubstitutionRequest,
  reconcileRefunds = reconcileExpiredSubstitutionRefundOperations,
  dependencies,
} = {}) {
  const limit = bounded(maxRecords, 25, 1, 500);
  const workerConcurrency = bounded(concurrency, 3, 1, 20);
  const candidates = await findCandidates({ now, limit, dependencies });
  const results = await pool(Array.isArray(candidates) ? candidates : [], workerConcurrency, (candidate) =>
    expire({
      requestId: candidate._id || candidate.id,
      expectedStatus: candidate.status,
      now,
      dependencies,
    }),
  );
  const summary = {
    candidates: results.length,
    claimed: 0,
    offeredExpired: 0,
    cardPaymentExpired: 0,
    skipped: 0,
    failures: 0,
    refundReconciliations: 0,
  };
  for (const result of results) {
    if (result?.error) summary.failures += 1;
    else if (!result?.claimed) summary.skipped += 1;
    else {
      summary.claimed += 1;
      if (result.expectedStatus === "offered") summary.offeredExpired += 1;
      if (result.expectedStatus === "awaiting_card_payment") summary.cardPaymentExpired += 1;
    }
  }
  const reconciliation = await reconcileRefunds({ limit, dependencies });
  summary.refundReconciliations = Array.isArray(reconciliation)
    ? reconciliation.filter((item) => item?.operation).length
    : 0;
  return { summary, results, reconciliation };
}

export const substitutionExpirationWorkerInternals = Object.freeze({ bounded, pool });
