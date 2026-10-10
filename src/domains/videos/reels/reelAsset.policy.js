import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
export function isVerifiedReelAssetReady(asset) {
  return asset?.ownerType === videoAssetOwnerTypeEnum.REEL && asset._id && asset.ownerId &&
    asset.technicalState === videoAssetTechnicalStateEnum.READY && asset.providerStatus === 4 &&
    asset.readyAt instanceof Date && !asset.deletionRequestedAt &&
    Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0 &&
    asset.durationSeconds <= 90 && Number.isInteger(asset.width) && asset.width > 0 &&
    Number.isInteger(asset.height) && asset.height > 0 &&
    Array.isArray(asset.availableResolutions) && asset.availableResolutions.length > 0;
}
