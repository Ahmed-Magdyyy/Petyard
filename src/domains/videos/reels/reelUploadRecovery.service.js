import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum, videoAssetApplicationResultEnum } from "../../../shared/constants/enums.js";
import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
export function createReelUploadRecovery({ repository, now = Date.now, enqueue = enqueueVideoProviderOperation } = {}) {
  if (typeof repository?.recoverStaleSetups !== "function" ||
      typeof repository?.commitTerminalFailure !== "function" ||
      typeof repository?.commitMissingUpload !== "function") {
    throw new TypeError("Reel upload recovery repository is required");
  }
  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result;
  }

  return Object.freeze({
    async recoverRejectedChanges({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be between 1 and 100");
      const { operationIds, ...summary } = await finishCommit(repository.recoverRejectedChanges({ before: new Date(now()), limit }));
      return summary;
    },
    async recoverStaleSetups({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("limit must be between 1 and 100");
      }
      const before = new Date(now() - 60 * 60_000);
      const { operationIds, ...summary } = await finishCommit(repository.recoverStaleSetups({ before, limit }));
      if (repository.recoverStaleResourceRecoveries) {
        const recovered = await finishCommit(repository.recoverStaleResourceRecoveries({ before, limit }));
        for (const field of ["examined", "recovered", "failed"]) summary[field] += recovered[field];
      }
      return summary;
    },
    async handleVerifiedAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.REEL) return { status: videoAssetApplicationResultEnum.IGNORED };
      if (asset.technicalState === videoAssetTechnicalStateEnum.AWAITING_UPLOAD && asset.providerStatus === 0) {
        const committed = await finishCommit(repository.commitMissingUpload({
          assetId: String(asset._id), videoId: String(asset.ownerId),
          providerGuid: asset.providerGuid, requireStatusZero: true,
        }));
        return { status: committed ? videoAssetApplicationResultEnum.ABANDONED : videoAssetApplicationResultEnum.STALE };
      }
      if (asset.technicalState !== videoAssetTechnicalStateEnum.FAILED) {
        return { status: videoAssetApplicationResultEnum.IGNORED };
      }
      const committed = await finishCommit(repository.commitTerminalFailure({
        assetId: String(asset._id), videoId: String(asset.ownerId),
        failureCode: asset.safeFailureCode === "VIDEO_DURATION_EXCEEDED"
          ? "VIDEO_DURATION_EXCEEDED" : "BUNNY_TRANSCODE_FAILED",
      }));
      return { status: committed ? videoAssetApplicationResultEnum.FAILED : videoAssetApplicationResultEnum.STALE };
    },
    async handleMissingAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.REEL || asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD) return false;
      return Boolean(await finishCommit(repository.commitMissingUpload({ assetId: String(asset._id),
        videoId: String(asset.ownerId) })));
    },
  });
}
