import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { validateSessionAccess, validateInput } from "./reelUpload.validators.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import {
  roles,
  editorialVideoStatusEnum,
  videoAssetTechnicalStateEnum,
  reelUploadSessionStatusEnum,
  videoUploadRecoveryStatusEnum,
  reelUploadPurposeEnum,
  videoUploadResponseStatusEnum,
} from "../../../shared/constants/enums.js";
import { isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";
import { isVerifiedReelAssetReady } from "./reelAsset.policy.js";


function uploadError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

let productionUploadService;

export async function getReelUploadService() {
  if (!productionUploadService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Reel uploads are unavailable", 503,
      [{ code: "VIDEO_UPLOAD_DISABLED" }]);
    const [{ createReelUploadRepository },
      { createBunnyStreamAdapter }] = await Promise.all([
      import("../reels/reelUpload.repository.js"),
      import("../provider/bunnyStreamAdapter.js"),
    ]);
    productionUploadService = createReelUploadService({
      repository: createReelUploadRepository({ libraryId: stream.libraryId }),
      provider: createBunnyStreamAdapter(stream),
      uploadAuthorizationTtlSeconds: stream.uploadAuthorizationTtlSeconds,
    });
  }
  return productionUploadService;
}



export function createReelUploadService({ repository, provider, now = Date.now, uploadAuthorizationTtlSeconds = 21600, enqueue = enqueueVideoProviderOperation }) {
  if (!repository?.reserve || !repository?.attachProviderVideo || !repository?.issue ||
      !repository?.failSetup || !provider?.createVideo || !provider?.createTusUpload ||
      !provider?.createTusUploadAuthorization) {
    throw new TypeError("Reel uploads require repository and Bunny adapter");
  }

  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result;
  }

  function grant(session) {
    const current = Math.floor(now() / 1000);
    const abandonAt = Math.floor(session.abandonAt?.getTime() / 1000);
    if (typeof session.providerGuid !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(session.providerGuid) ||
        !isBunnyTusUploadUrl(session.uploadUrl) ||
        !Number.isSafeInteger(session.resourceExpiresAt) ||
        !Number.isFinite(abandonAt) ||
        abandonAt <= current) {
      throw uploadError("Reel upload is no longer refreshable", 409, "VIDEO_UPLOAD_CONFLICT");
    }
    if (session.resourceExpiresAt <= current) {
      throw uploadError("Reel upload resource expired", 409, "VIDEO_UPLOAD_RESOURCE_EXPIRED");
    }
    return { ...provider.createTusUploadAuthorization({ videoId: session.providerGuid,
      expiresAt: Math.min(current + uploadAuthorizationTtlSeconds, session.resourceExpiresAt, abandonAt) }),
    uploadUrl: session.uploadUrl, resourceExpiresAt: session.resourceExpiresAt };
  }

  return Object.freeze({
    async recoverUploadSession({ videoId, sessionId, actor, idempotencyKey, file, purpose = reelUploadPurposeEnum.INITIAL }) {
      validateSessionAccess({ videoId, sessionId, actor, purpose });
      validateInput({ videoId, actor, idempotencyKey, file });
      if (!sessionId) throw uploadError("Upload session is required", 400, "VIDEO_INVALID_MEDIA");
      const input = { videoId, sessionId, actor, purpose, file, idempotencyKey: idempotencyKey.trim() };
      const response = row => ({ videoId: String(videoId), sessionId: String(sessionId), recoveryId: String(row.id),
        status: row.status === videoUploadRecoveryStatusEnum.ISSUED ? videoUploadResponseStatusEnum.AWAITING_UPLOAD : videoUploadResponseStatusEnum.RECOVERING,
        ...(row.status === videoUploadRecoveryStatusEnum.ISSUED ? { upload: grant(row) } : {}) });
      let recovery = await repository.getResourceRecoveryReplay(input);
      if (!recovery) {
        const { asset } = await repository.getResourceRecoveryTarget(input);
        let snapshot;
        let absent = false;
        try { snapshot = await provider.getVideo(asset.providerGuid); }
        catch (error) {
          if (error?.status === 404) absent = true;
          else throw uploadError("Video provider is unavailable", 503, "VIDEO_PROVIDER_UNAVAILABLE");
        }
        if (!absent) {
          if (snapshot?.guid !== asset.providerGuid || snapshot.status !== 0 ||
              (snapshot.videoLibraryId !== undefined && String(snapshot.videoLibraryId) !== asset.libraryId)) {
            throw uploadError("Video is not eligible for upload recovery", 409, "VIDEO_UPLOAD_CONFLICT");
          }
          let resource;
          try { resource = await provider.inspectTusUpload({ videoId: asset.providerGuid,
            uploadUrl: asset.tusUploadUrl, expiresAt: Math.floor(now() / 1000) + Math.min(uploadAuthorizationTtlSeconds, 60) }); }
          catch { throw uploadError("Video provider is unavailable", 503, "VIDEO_PROVIDER_UNAVAILABLE"); }
          if (resource?.state !== "not_found") throw uploadError("Existing resource may still resume", 409, "VIDEO_UPLOAD_CONFLICT");
        }
        recovery = await finishCommit(repository.reserveResourceRecovery({ ...input, expectedAsset: asset }));
        return response(recovery);
      }
      if (recovery.status === videoUploadRecoveryStatusEnum.ISSUED) return response(recovery);
      if (recovery.status !== videoUploadRecoveryStatusEnum.WAITING_CLEANUP) throw uploadError("Upload recovery is already being prepared", 409, "VIDEO_UPLOAD_CONFLICT");
      const preparing = await repository.beginResourceRecovery(recovery.id);
      if (!preparing) return response(recovery);
      const title = `petyard-reel-recovery:${recovery.id}`;
      let providerGuid;
      let resource;
      try {
        const created = await provider.createVideo({ title });
        if (typeof created?.guid !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(created.guid)) {
          throw new TypeError("Invalid Bunny Video GUID");
        }
        providerGuid = created.guid;
        await repository.attachResourceRecoveryVideo({ recoveryId: recovery.id, providerGuid });
        resource = await provider.createTusUpload({ videoId: providerGuid, title, sizeBytes: file.sizeBytes, mimeType: file.mimeType,
          expiresAt: Math.min(Math.floor(now() / 1000) + uploadAuthorizationTtlSeconds, Math.floor(preparing.abandonAt.getTime() / 1000)) });
        return response(await repository.issueResourceRecovery({ recoveryId: recovery.id, providerGuid, ...resource }));
      } catch {
        try { await finishCommit(repository.failResourceRecovery({ recoveryId: recovery.id, providerGuid, ...resource })); }
        catch { throw uploadError("Reel cleanup could not be persisted", 500, "VIDEO_CLEANUP_PERSISTENCE_FAILED"); }
        throw uploadError("Video provider is unavailable", 503, "VIDEO_PROVIDER_UNAVAILABLE");
      }
    },
    async getUploadStatus(input) {
      validateSessionAccess(input);
      const { video, row, asset, isCurrent, recovery } = await repository.getSessionContext(input);
      let status = videoUploadResponseStatusEnum.NONE;
      if (row?.purpose === reelUploadPurposeEnum.REPLACEMENT && row.appliedAt) {
        status = videoUploadResponseStatusEnum.APPLIED;
      } else if (row?.status === reelUploadSessionStatusEnum.FAILED) {
        status = row.failureCode === "VIDEO_UPLOAD_CANCELLED" ? videoUploadResponseStatusEnum.CANCELLED : videoUploadResponseStatusEnum.FAILED;
      } else if (row && isCurrent) {
        status = row.status === reelUploadSessionStatusEnum.RESERVING ? videoUploadResponseStatusEnum.RESERVING : asset?.technicalState;
        if (!status || (status === videoUploadResponseStatusEnum.READY && !isVerifiedReelAssetReady(asset))) status = videoUploadResponseStatusEnum.PROCESSING;
      }
      const deadline = row?.abandonAt?.getTime();
      const current = Math.floor(now() / 1000);
      return { videoId: String(video._id), sessionId: row ? String(row._id) : null,
        ...(recovery ? { recovery } : {}),
        status, videoStatus: video.status,
        failureCode: row?.failureCode || asset?.safeFailureCode || null,
        canRefresh: Boolean(isCurrent && row?.status === reelUploadSessionStatusEnum.ISSUED &&
          (input.purpose === reelUploadPurposeEnum.REPLACEMENT || video.status === editorialVideoStatusEnum.DRAFT) &&
          asset?.technicalState === videoAssetTechnicalStateEnum.AWAITING_UPLOAD && !asset.deletionRequestedAt &&
          typeof asset.providerGuid === "string" && /^[A-Za-z0-9-]{1,128}$/.test(asset.providerGuid) &&
          isBunnyTusUploadUrl(asset.tusUploadUrl) && Number.isSafeInteger(asset.tusResourceExpiresAt) &&
          asset.tusResourceExpiresAt > current && Math.floor(deadline / 1000) > current),
        abandonAt: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null };
    },
    async refreshUploadAuthorization(input) {
      validateSessionAccess(input);
      if (!input.sessionId) throw uploadError("Upload session is required", 400, "VIDEO_INVALID_MEDIA");
      const { video, row, asset, isCurrent } = await repository.getSessionContext(input);
      if (!isCurrent || row?.status !== reelUploadSessionStatusEnum.ISSUED || (input.purpose !== reelUploadPurposeEnum.REPLACEMENT && video.status !== editorialVideoStatusEnum.DRAFT) ||
          asset?.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD || asset.deletionRequestedAt) {
        throw uploadError("Reel upload is no longer refreshable", 409, "VIDEO_UPLOAD_CONFLICT");
      }
      return { videoId: String(video._id), sessionId: String(row._id), status: videoUploadResponseStatusEnum.AWAITING_UPLOAD,
        upload: grant({ providerGuid: asset.providerGuid, uploadUrl: asset.tusUploadUrl,
          resourceExpiresAt: asset.tusResourceExpiresAt, abandonAt: row.abandonAt }) };
    },
    async cancelUpload(input) {
      validateSessionAccess(input);
      if (!input.sessionId) throw uploadError("Upload session is required", 400, "VIDEO_INVALID_MEDIA");
      await finishCommit(repository.cancelUpload(input));
      return { videoId: String(input.videoId), sessionId: String(input.sessionId), status: videoUploadResponseStatusEnum.CANCELLED };
    },
    async createSession({ videoId, actor, idempotencyKey, file, purpose = reelUploadPurposeEnum.INITIAL }) {
      validateInput({ videoId, actor, idempotencyKey, file });
      validateSessionAccess({ videoId, actor, purpose });
      const key = idempotencyKey.trim();
      const reservation = await repository.reserve({ videoId, actor, idempotencyKey: key, file, purpose });
      if (reservation.status === reelUploadSessionStatusEnum.ISSUED) {
        return { videoId: String(videoId), sessionId: reservation.id,
          status: videoUploadResponseStatusEnum.AWAITING_UPLOAD, upload: grant(reservation) };
      }
      if (reservation.status === reelUploadSessionStatusEnum.RESERVING && !reservation.newlyCreated) {
        return { videoId: String(videoId), sessionId: reservation.id, status: videoUploadResponseStatusEnum.RESERVING };
      }
      let providerGuid;
      let issued;
      try {
        // This marker must have been persisted in the reservation transaction.
        if (reservation.providerTitle !== `petyard-reel-session:${reservation.id}`) {
          throw new TypeError("Reel provider marker was not persisted");
        }
        const created = await provider.createVideo({ title: reservation.providerTitle });
        providerGuid = created.guid;
        if (typeof providerGuid !== "string" || !/^[A-Za-z0-9-]+$/.test(providerGuid)) {
          throw new TypeError("Invalid Bunny Video GUID");
        }
        await repository.attachProviderVideo({ sessionId: reservation.id, videoId, providerGuid });
        const resource = await provider.createTusUpload({ videoId: providerGuid,
          title: reservation.providerTitle, sizeBytes: file.sizeBytes, mimeType: file.mimeType,
          expiresAt: Math.floor(now() / 1000) + uploadAuthorizationTtlSeconds });
        issued = await repository.issue({ sessionId: reservation.id, videoId,
          providerGuid, ...resource });
      } catch {
        try {
          await finishCommit(repository.failSetup({ sessionId: reservation.id, videoId, providerGuid }));
        } catch {
          throw uploadError("Reel cleanup could not be persisted", 500,
            "VIDEO_CLEANUP_PERSISTENCE_FAILED");
        }
        throw uploadError("Video provider is unavailable", 503, "VIDEO_PROVIDER_UNAVAILABLE");
      }
      return { videoId: String(videoId), sessionId: reservation.id,
        status: videoUploadResponseStatusEnum.AWAITING_UPLOAD, upload: grant(issued) };
    },
  });
}
