import { editorialVideoStatusEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { createReelLifecycleRepository } from "../reels/reelLifecycle.repository.js";
import { isVerifiedReelAssetReady } from "../reels/reelAsset.policy.js";

function unavailable() {
  return new ApiError("Video not found", 404, [{ code: "VIDEO_NOT_AVAILABLE" }]);
}

let productionPlaybackService;

export async function getPublicReelPlaybackService() {
  if (!productionPlaybackService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Video not found", 404,
      [{ code: "VIDEO_NOT_AVAILABLE" }]);
    const { createBunnyStreamAdapter } = await import("../provider/bunnyStreamAdapter.js");
    productionPlaybackService = createPublicReelPlaybackService({
      provider: createBunnyStreamAdapter(stream),
      playbackTtlSeconds: stream.playbackTtlSeconds,
      isEnabled: () => String(process.env.VIDEOS_PUBLIC_ENABLED).trim().toLowerCase() === "true",
    });
  }
  return productionPlaybackService;
}

export function createPublicReelPlaybackService({
  repository = createReelLifecycleRepository(), provider, isEnabled = () => false,
  playbackTtlSeconds = 900, now = Date.now,
} = {}) {
  if (typeof repository?.findCurrentForVideoId !== "function" ||
      typeof provider?.createSignedHlsUrl !== "function" ||
      typeof isEnabled !== "function" || typeof now !== "function" ||
      !Number.isSafeInteger(playbackTtlSeconds) || playbackTtlSeconds < 60 ||
      playbackTtlSeconds > 900) {
    throw new TypeError("Public Reel playback dependencies are required");
  }

  async function eligible(id) {
    const current = await repository.findCurrentForVideoId(id);
    if (!current || current.video.status !== editorialVideoStatusEnum.PUBLISHED ||
        !isVerifiedReelAssetReady(current.asset) ||
        String(current.video.activeAssetId) !== String(current.asset._id) ||
        String(current.video.activeUploadSessionId) !== String(current.session._id)) {
      return null;
    }
    return current;
  }

  return Object.freeze({
    async grant({ id }) {
      if (!isEnabled()) throw unavailable();
      const current = await eligible(id);
      if (!current) throw unavailable();
      const grant = provider.createSignedHlsUrl({ videoId: current.asset.providerGuid,
        expiresAt: Math.floor(now() / 1000) + playbackTtlSeconds });
      // An unpublish or asset switch during signing must not receive a new URL.
      const latest = await eligible(id);
      if (!latest || String(latest.asset._id) !== String(current.asset._id) ||
          String(latest.session._id) !== String(current.session._id) || !isEnabled()) {
        throw unavailable();
      }
      return { url: grant.href, expiresAt: new Date(grant.expiresAt * 1000).toISOString() };
    },
  });
}
