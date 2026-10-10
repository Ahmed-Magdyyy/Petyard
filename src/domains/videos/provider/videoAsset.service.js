import { videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
import { createVideoAssetRepository } from "./videoAsset.repository.js";

export function createVideoAssetObserver({
  model, repository = createVideoAssetRepository({ model }), now = Date.now, onApplied, onDeleted, onMissing,
} = {}) {
  return Object.freeze({
    async listNeedingPoster({ libraryId, limit }) {
      if (typeof libraryId !== "string" || !/^\d+$/.test(libraryId) ||
          !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError("Valid poster library and bounded limit are required");
      }
      return repository.listNeedingPoster({ libraryId, limit });
    },
    async markPosterRequested({ asset }) {
      await repository.markPosterRequested(asset, new Date(now()));
    },
    async observeMissing({ operation }) {
      const asset = await repository.findForOperation(operation);
      // Cleanup already owns this resource. An older reconcile job must not
      // create a second obligation or retry forever after a committed recovery.
      if (asset?.deletionRequestedAt) return true;
      return asset?.technicalState === videoAssetTechnicalStateEnum.AWAITING_UPLOAD && onMissing
        ? Boolean(await onMissing(asset)) : false;
    },
    async listStuck({ before, limit }) {
      if (!(before instanceof Date) || !Number.isFinite(before.getTime())) {
        throw new TypeError("before must be a valid Date");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError("limit must be between 1 and 500");
      }
      return repository.listStuck({ before, limit });
    },
    async getDeletionTarget({ operation }) {
      return repository.findDeletionIntent(operation);
    },
    async markDeleteAccepted({ operation }) {
      const acceptedAt = new Date(now());
      const asset = await repository.markDeleteAccepted(operation, acceptedAt);
      if (!asset) throw new Error("VIDEO_ASSET_DELETE_INTENT_MISSING");
      if (onDeleted) await onDeleted(asset);
      return asset;
    },
    async applySnapshot({ operation, snapshot }) {
      if (snapshot?.guid !== operation.providerGuid) {
        throw new TypeError("Provider GUID does not match the Video Asset");
      }
      const resolutions = (Array.isArray(snapshot.availableResolutions)
        ? snapshot.availableResolutions
        : String(snapshot.availableResolutions || "").split(","))
        .map((value) => String(value).trim())
        .filter((value) => /^\d{3,4}p$/.test(value));
      const playable =
        snapshot.status === 4 &&
        Number.isFinite(snapshot.length) &&
        snapshot.length > 0 &&
        snapshot.length <= 90 &&
        Number.isInteger(snapshot.width) &&
        snapshot.width > 0 &&
        Number.isInteger(snapshot.height) &&
        snapshot.height > 0 &&
        resolutions.length > 0;
      const verifiedAt = new Date(now());
      const durationExceeded =
        snapshot.status === 4 &&
        Number.isFinite(snapshot.length) &&
        snapshot.length > 90;
      const failed = [5, 6].includes(snapshot.status) || durationExceeded;
      const fields = {
        technicalState: failed ? videoAssetTechnicalStateEnum.FAILED : playable ? videoAssetTechnicalStateEnum.READY : snapshot.status === 0 ? videoAssetTechnicalStateEnum.AWAITING_UPLOAD : videoAssetTechnicalStateEnum.PROCESSING,
        providerStatus: snapshot.status,
        lastVerifiedAt: verifiedAt,
        ...(failed ? {
          safeFailureCode: durationExceeded ? "VIDEO_DURATION_EXCEEDED" : "BUNNY_TRANSCODE_FAILED",
        } : {}),
        ...(playable ? {
          durationSeconds: snapshot.length,
          width: snapshot.width,
          height: snapshot.height,
          availableResolutions: resolutions,
          readyAt: verifiedAt,
        } : {}),
      };
      const updated = await repository.applySnapshot(operation, snapshot.status === 0, fields);
      if (onApplied) {
        const asset = updated || await repository.findForOperation(operation);
        if (asset) await onApplied(asset);
      }
      return updated;
    },
  });
}
