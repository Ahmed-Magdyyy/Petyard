import { videoAssetOwnerTypeEnum, videoAssetTechnicalStateEnum, productVideoLifecycleStateEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { createPublicProductVideoRepository } from "./publicProductVideo.repository.js";

function unavailable() {
  return new ApiError("Product Video not found", 404, [{ code: "VIDEO_NOT_AVAILABLE" }]);
}

let productionService;

export async function getPublicProductPlaybackService() {
  if (!productionService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Product Video not found", 404,
      [{ code: "VIDEO_NOT_AVAILABLE" }]);
    const { createBunnyStreamAdapter } = await import("../provider/bunnyStreamAdapter.js");
    productionService = createPublicProductPlaybackService({
      provider: createBunnyStreamAdapter(stream),
      playbackTtlSeconds: stream.playbackTtlSeconds,
      isEnabled: () => String(process.env.PRODUCT_VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
    });
  }
  return productionService;
}

export function createPublicProductPlaybackService({
  repository = createPublicProductVideoRepository(), provider,
  isEnabled = () => false, playbackTtlSeconds = 900, now = Date.now,
} = {}) {
  if (typeof repository?.getPlayable !== "function" ||
      typeof provider?.createSignedHlsUrl !== "function" ||
      typeof isEnabled !== "function" || typeof now !== "function" ||
      !Number.isSafeInteger(playbackTtlSeconds) || playbackTtlSeconds < 60 ||
      playbackTtlSeconds > 900) {
    throw new TypeError("Public Product Video playback dependencies are required");
  }

  async function eligible(id) {
    const current = await repository.getPlayable(id);
    if (!current || !current.product?.isActive || !current.activeSlot ||
        ![productVideoLifecycleStateEnum.READY, productVideoLifecycleStateEnum.DELETING].includes(current.lifecycleState) || current.removedAt || !current.asset ||
        String(current.activeAssetId) !== String(current.asset._id) ||
        String(current.productId) !== String(current.product._id) ||
        String(current.asset.ownerId) !== String(current._id) ||
        current.asset.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO ||
        current.asset.technicalState !== videoAssetTechnicalStateEnum.READY || current.asset.providerStatus !== 4 ||
        current.asset.deleteAcceptedAt) return null;
    return current;
  }

  return Object.freeze({
    async grant({ id }) {
      if (!isEnabled()) throw unavailable();
      const current = await eligible(id);
      if (!current) throw unavailable();
      const grant = provider.createSignedHlsUrl({ videoId: current.asset.providerGuid,
        expiresAt: Math.floor(now() / 1000) + playbackTtlSeconds });
      const latest = await eligible(id);
      if (!latest || String(latest.asset._id) !== String(current.asset._id) || !isEnabled()) {
        throw unavailable();
      }
      return { url: grant.href, expiresAt: new Date(grant.expiresAt * 1000).toISOString() };
    },
  });
}
