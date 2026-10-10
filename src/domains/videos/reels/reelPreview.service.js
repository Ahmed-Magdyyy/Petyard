import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { roles, editorialVideoKindEnum, videoPreviewSelectionEnum } from "../../../shared/constants/enums.js";
import { createReelLifecycleRepository } from "./reelLifecycle.repository.js";
import { isVerifiedReelAssetReady } from "./reelAsset.policy.js";

export function createReelPreviewService({ repository = createReelLifecycleRepository(),
  provider, playbackTtlSeconds = 900, now = Date.now } = {}) {
  if (typeof provider?.probeSignedHls !== "function" ||
      !Number.isSafeInteger(playbackTtlSeconds) || playbackTtlSeconds < 60 ||
      playbackTtlSeconds > 900) {
    throw new TypeError("Reel preview requires a provider and bounded playback TTL");
  }
  async function previewCandidate(id, selection = videoPreviewSelectionEnum.ACTIVE) {
    const current = await repository.findCurrentForVideoId(id, selection);
    return current && isVerifiedReelAssetReady(current.asset) ? current : null;
  }
  async function probe(asset) {
    return provider.probeSignedHls({ videoId: asset.providerGuid,
      expiresAt: Math.floor(now() / 1000) + playbackTtlSeconds });
  }
  return Object.freeze({
    async verifyReady(video, selection = videoPreviewSelectionEnum.ACTIVE) {
      const assetId = selection === videoPreviewSelectionEnum.PENDING ? video?.pendingChange?.assetId : video?.activeAssetId;
      const sessionId = selection === videoPreviewSelectionEnum.PENDING ? video?.pendingChange?.uploadSessionId : video?.activeUploadSessionId;
      if (video?.kind !== editorialVideoKindEnum.REEL || !assetId) return false;
      const current = await previewCandidate(video._id ?? video.id, selection);
      if (!current || String(current.asset._id) !== String(assetId) ||
          (selection === videoPreviewSelectionEnum.PENDING && String(current.session._id) !== String(sessionId))) return false;
      return Boolean(await probe(current.asset));
    },
    async grant({ id, actor, asset = videoPreviewSelectionEnum.ACTIVE }) {
      if (![roles.ADMIN, roles.SUPER_ADMIN].includes(actor?.role) || !actor?.id) {
        throw new ApiError("Not allowed to preview Reels", 403, [{ code: "VIDEO_FORBIDDEN" }]);
      }
      if (!Object.values(videoPreviewSelectionEnum).includes(asset)) {
        throw new ApiError("Invalid Reel preview selection", 422, [{ code: "VIDEO_INVALID_PREVIEW" }]);
      }
      const current = await previewCandidate(id, asset);
      if (!current) {
        throw new ApiError("Reel preview is not available", 404,
          [{ code: "VIDEO_PREVIEW_NOT_AVAILABLE" }]);
      }
      const grant = await probe(current.asset);
      if (!grant) {
        throw new ApiError("Reel preview is not ready", 409,
          [{ code: "VIDEO_PREVIEW_NOT_READY" }]);
      }
      // Do not hand out a fresh signed URL if the Reel changed while the CDN
      // probe was in flight.
      const latest = await previewCandidate(id, asset);
      if (!latest || String(latest.asset._id) !== String(current.asset._id) ||
          String(latest.session._id) !== String(current.session._id)) {
        throw new ApiError("Reel preview changed", 409,
          [{ code: "VIDEO_PREVIEW_CHANGED" }]);
      }
      return { url: grant.href, expiresAt: new Date(grant.expiresAt * 1000).toISOString() };
    },
  });
}

let productionPreviewService;

export async function getReelPreviewService() {
  if (!productionPreviewService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Reel preview is unavailable", 503,
      [{ code: "VIDEO_PREVIEW_DISABLED" }]);
    const { createBunnyStreamAdapter } = await import("../provider/bunnyStreamAdapter.js");
    productionPreviewService = createReelPreviewService({
      repository: createReelLifecycleRepository({ libraryId: stream.libraryId }),
      provider: createBunnyStreamAdapter(stream),
      playbackTtlSeconds: stream.playbackTtlSeconds,
    });
  }
  return productionPreviewService;
}
