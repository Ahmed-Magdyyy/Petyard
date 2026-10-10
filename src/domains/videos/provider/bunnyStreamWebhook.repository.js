import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum, videoProviderOperationTypeEnum } from "../../../shared/constants/enums.js";
import { VideoAssetModel } from "./videoAsset.model.js";
import { recordVideoProviderOperation } from "./videoProviderOperation.service.js";

export function createBunnyStreamWebhookRepository({ assets = VideoAssetModel,
  recordOperation = recordVideoProviderOperation } = {}) {
  return Object.freeze({
    async recordHint({ libraryId, providerGuid, bodyHash }) {
      const asset = await assets.findOne({ libraryId, providerGuid,
        ownerType: { $in: Object.values(videoAssetOwnerTypeEnum) },
        technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.PROCESSING, videoAssetTechnicalStateEnum.READY, videoAssetTechnicalStateEnum.FAILED] },
        deletionRequestedAt: { $exists: false } }).select({ _id: 1 }).lean();
      if (!asset) return null;
      // The immutable target is only a reconciliation hint. A concurrent delete
      // remains authoritative; the worker's guarded observation cannot revive it.
      return recordOperation({ type: videoProviderOperationTypeEnum.RECONCILE, assetId: asset._id, libraryId, providerGuid,
        dedupeKey: `bunny-webhook:${libraryId}:${bodyHash}` });
    },
  });
}
