import { ApiError } from "../../../shared/utils/ApiError.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { createBunnyStreamAdapter } from "../provider/bunnyStreamAdapter.js";
import { createProductVideoPreviewRepository } from "./productVideoPreview.repository.js";
import {
  roles,
  enabledControls,
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoReplacementStatusEnum,
  videoPreviewSelectionEnum,
} from "../../../shared/constants/enums.js";

function previewError(message, status, code) {
  return new ApiError(message, status, [{ code }]);
}

let productionPreviewService;

export function getProductVideoPreviewService() {
  if (!productionPreviewService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Product Video preview is unavailable", 503,
      [{ code: "VIDEO_PREVIEW_UNAVAILABLE" }]);
    productionPreviewService = createProductVideoPreviewService({
      repository: createProductVideoPreviewRepository({ libraryId: stream.libraryId }),
      provider: createBunnyStreamAdapter(stream), playbackTtlSeconds: stream.playbackTtlSeconds,
    });
  }
  return productionPreviewService;
}

function candidateReady(candidate, { productId, videoId, asset }) {
  const row = candidate?.placement;
  const media = candidate?.asset;
  if (!row || !media || String(row._id) !== videoId || String(row.productId) !== productId ||
      !row.activeSlot || row.removedAt || ![productVideoLifecycleStateEnum.READY, productVideoLifecycleStateEnum.DELETING].includes(row.lifecycleState) ||
      String(asset === videoPreviewSelectionEnum.PENDING ? row.pendingAssetId : row.activeAssetId) !== String(media._id) ||
      media.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO || String(media.ownerId) !== videoId ||
      media.technicalState !== videoAssetTechnicalStateEnum.READY || media.providerStatus !== 4 || media.deleteAcceptedAt ||
      !(media.readyAt instanceof Date) || !Number.isFinite(media.readyAt.getTime()) ||
      !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0 || media.durationSeconds > 90 ||
      !Number.isInteger(media.width) || media.width < 1 || !Number.isInteger(media.height) || media.height < 1 ||
      !Array.isArray(media.availableResolutions) || !media.availableResolutions.length) return false;
  if (asset === videoPreviewSelectionEnum.ACTIVE) return true;
  const replacement = candidate.replacement;
  return row.lifecycleState === productVideoLifecycleStateEnum.READY && !row.deletionRequestedAt && !media.deletionRequestedAt &&
    replacement?.status === productVideoReplacementStatusEnum.ISSUED && String(replacement._id) === String(row.replacementId) &&
    String(replacement.assetId) === String(media._id) && String(replacement.productId) === productId &&
    String(replacement.videoId) === videoId;
}

export function createProductVideoPreviewService({ repository, provider,
  playbackTtlSeconds = 900, now = Date.now } = {}) {
  if (typeof repository?.findCandidate !== "function" || typeof provider?.probeSignedHls !== "function" ||
      typeof now !== "function" || !Number.isSafeInteger(playbackTtlSeconds) ||
      playbackTtlSeconds < 60 || playbackTtlSeconds > 900) {
    throw new TypeError("Product Video preview dependencies and bounded TTL are required");
  }
  return Object.freeze({
    async grant({ productId, videoId, actor, asset = videoPreviewSelectionEnum.ACTIVE }) {
      if (!actor?.id || ![roles.SUPER_ADMIN, roles.ADMIN].includes(actor.role) ||
          (actor.role === roles.ADMIN && !actor.enabledControls?.includes(enabledControls.PRODUCTS))) {
        throw previewError("Not allowed to preview Product Videos", 403, "VIDEO_FORBIDDEN");
      }
      if (![productId, videoId].every((id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id)) ||
          !Object.values(videoPreviewSelectionEnum).includes(asset)) {
        throw previewError("Invalid Product Video preview", 422, "VIDEO_INVALID_PREVIEW");
      }
      const input = { productId: productId.toLowerCase(), videoId: videoId.toLowerCase(), asset };
      const current = await repository.findCandidate(input);
      if (!candidateReady(current, input)) {
        throw previewError("Product Video preview is not available", 404, "VIDEO_PREVIEW_NOT_AVAILABLE");
      }
      const grant = await provider.probeSignedHls({ videoId: current.asset.providerGuid,
        expiresAt: Math.floor(now() / 1000) + playbackTtlSeconds });
      if (!grant) {
        throw previewError("Product Video preview is not ready", 409, "VIDEO_PREVIEW_NOT_READY");
      }
      const latest = await repository.findCandidate(input);
      if (!candidateReady(latest, input) || String(latest.asset._id) !== String(current.asset._id) ||
          latest.asset.providerGuid !== current.asset.providerGuid ||
          String(latest.replacement?._id) !== String(current.replacement?._id)) {
        throw previewError("Product Video preview changed", 409, "VIDEO_PREVIEW_CHANGED");
      }
      return { url: grant.href, expiresAt: new Date(grant.expiresAt * 1000).toISOString() };
    },
  });
}
