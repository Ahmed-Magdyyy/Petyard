import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum, videoAssetApplicationResultEnum } from "../../../shared/constants/enums.js";
export function createVideoAssetAppliedHandler({ productVideos, reelVideos, reelUploadRecovery }) {
  if (typeof productVideos?.handleVerifiedAsset !== "function" ||
      typeof reelVideos?.handleVerifiedAsset !== "function" ||
      (reelUploadRecovery && typeof reelUploadRecovery.handleVerifiedAsset !== "function")) {
    throw new TypeError("Product and Reel asset handlers are required");
  }
  return (asset) => {
    if (asset?.ownerType === videoAssetOwnerTypeEnum.PRODUCT_VIDEO) return productVideos.handleVerifiedAsset(asset);
    if (asset?.ownerType === videoAssetOwnerTypeEnum.REEL) return reelUploadRecovery && (asset.technicalState === videoAssetTechnicalStateEnum.FAILED ||
      (asset.technicalState === videoAssetTechnicalStateEnum.AWAITING_UPLOAD && asset.providerStatus === 0))
      ? reelUploadRecovery.handleVerifiedAsset(asset) : reelVideos.handleVerifiedAsset(asset);
    return { status: videoAssetApplicationResultEnum.IGNORED };
  };
}
