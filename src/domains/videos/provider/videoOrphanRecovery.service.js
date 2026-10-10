import { videoOrphanRecoveryStatusEnum } from "../../../shared/constants/enums.js";

export function createVideoOrphanRecovery({ productRepository, reelRepository,
  productVideos, reelDiscovery, now = Date.now, retryAfterMs = 300_000 }) {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 120_000 ||
      retryAfterMs > 3_600_000 || typeof now !== "function" ||
      [productRepository, reelRepository].some(repository =>
        typeof repository?.listOrphanRecoveryCandidates !== "function" ||
        typeof repository?.claimOrphanRecoveryCandidate !== "function") ||
      typeof productVideos?.recoverUncertainCreation !== "function" ||
      typeof reelDiscovery?.recover !== "function") {
    throw new TypeError("Orphan recovery requires bounded retries and owner recovery dependencies");
  }
  return Object.freeze({
    async sweep({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("limit must be between 1 and 100");
      }
      const before = new Date(now() - retryAfterMs);
      const [product, reel] = await Promise.all([
        productRepository.listOrphanRecoveryCandidates({ before, limit }),
        reelRepository.listOrphanRecoveryCandidates({ before, limit }),
      ]);
      const candidates = [
        ...product.map(candidate => ({ ...candidate, repository: productRepository,
          recover: () => productVideos.recoverUncertainCreation(candidate.target) })),
        ...reel.map(candidate => ({ ...candidate, repository: reelRepository,
          recover: () => reelDiscovery.recover(candidate.target.sessionId, candidate.target.recoveryId) })),
      ].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit);
      const summary = { found: candidates.length, examined: 0, cleanupRecorded: 0, deferred: 0, failed: 0 };
      for (const candidate of candidates) {
        try {
          if (!await candidate.repository.claimOrphanRecoveryCandidate({ target: candidate.target,
            updatedAt: candidate.updatedAt, claimedAt: new Date(now()) })) continue;
          summary.examined++;
          const result = await candidate.recover();
          if (result?.status === videoOrphanRecoveryStatusEnum.CLEANUP_RECORDED) summary.cleanupRecorded++;
          else summary.deferred++;
        } catch { summary.failed++; }
      }
      return summary;
    },
  });
}
