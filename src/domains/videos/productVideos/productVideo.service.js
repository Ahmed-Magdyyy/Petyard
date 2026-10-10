import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoUploadBatchStatusEnum,
  productVideoReplacementStatusEnum,
  videoUploadRecoveryStatusEnum,
  videoUploadResponseStatusEnum,
  videoAssetApplicationResultEnum,
  videoOrphanRecoveryStatusEnum,
} from "../../../shared/constants/enums.js";
import { invalidateProductCaches } from "../../product/productCache.service.js";
import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { validateBatch, validateOrphanTarget, invalidMedia } from "./productVideo.validators.js";
import { getVideosStreamConfiguration } from "../provider/streamConfig.js";
import { createBunnyStreamAdapter, isBunnyTusUploadUrl } from "../provider/bunnyStreamAdapter.js";
import { createProductVideoRepository } from "./productVideo.repository.js";
import { inspectBunnyOrphan } from "../provider/bunnyOrphanInspection.service.js";

let productionService;

export function getProductVideoService() {
  if (!productionService) {
    const { stream } = getVideosStreamConfiguration();
    if (!stream) throw new ApiError("Video upload is unavailable", 503, [{ code: "VIDEO_UPLOAD_DISABLED" }]);
    productionService = createProductVideoService({
      repository: createProductVideoRepository({ libraryId: stream.libraryId }),
      provider: createBunnyStreamAdapter(stream),
      uploadAuthorizationTtlSeconds: stream.uploadAuthorizationTtlSeconds,
    });
  }
  return productionService;
}


export function createProductVideoService({ repository, provider, now = Date.now, uploadAuthorizationTtlSeconds = 21600,
  enqueue = enqueueVideoProviderOperation, invalidateCaches = invalidateProductCaches, allowOrphanCleanup = false }) {
  if (!repository || !provider) {
    throw new TypeError("repository and provider are required");
  }
  if (typeof allowOrphanCleanup !== "boolean") throw new TypeError("allowOrphanCleanup must be boolean");

  async function finishCommit(resultPromise) {
    const result = await resultPromise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? [])], enqueue);
    if (result?.productId) await invalidateCaches(result.productId);
    return result;
  }

  function uploadGrant(upload) {
    const seconds = Math.floor(now() / 1000);
    const abandonAt = Math.floor(upload?.abandonAt?.getTime() / 1000);
    if (!upload?.providerGuid || !isBunnyTusUploadUrl(upload.uploadUrl) ||
        !Number.isSafeInteger(upload.resourceExpiresAt) ||
        !Number.isFinite(abandonAt) || abandonAt <= seconds) {
      throw new ApiError("Product Video upload is no longer refreshable", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
    }
    if (upload.resourceExpiresAt <= seconds) {
      // Expired authorization cannot safely be exchanged for a new Bunny
      // video: a completed upload may still appear as provider status 0.
      throw new ApiError("Product Video upload resource expired", 409,
        [{ code: "VIDEO_UPLOAD_RESOURCE_EXPIRED" }]);
    }
    return { ...provider.createTusUploadAuthorization({ videoId: upload.providerGuid,
      expiresAt: Math.min(seconds + uploadAuthorizationTtlSeconds, abandonAt, upload.resourceExpiresAt) }),
    uploadUrl: upload.uploadUrl, resourceExpiresAt: upload.resourceExpiresAt };
  }

  async function inspectReservation(input) {
    const target = validateOrphanTarget(input);
    const { videoId, replacementId, recoveryId } = target;
    const context = recoveryId ? await repository.getUploadRecoveryOrphanContext(target) :
      await repository.getOrphanSearchContext(target);
    const marker = recoveryId ? `petyard-product-recovery:${recoveryId}` :
      replacementId ? `petyard-product-replacement:${replacementId}` : `petyard-product-video:${videoId}`;
    const result = context ? await inspectBunnyOrphan({ context, marker, libraryId: context.libraryId,
        search: (input) => provider.searchProductReservation(input),
        getVideo: (guid) => provider.getVideo(guid),
        isGuidTracked: (guid) => repository.isOrphanGuidTracked(guid) }) : { status: videoOrphanRecoveryStatusEnum.NOT_APPLICABLE };
    return { target, context, result };
  }

  return Object.freeze({
    // Internal read-only diagnostic. Not mounted on HTTP routes or scheduled by the worker.
    async inspectUncertainCreation(target) {
      return (await inspectReservation(target)).result;
    },
    // Explicit opt-in only. The HTTP getter leaves this disabled; worker configuration controls cleanup.
    async recoverUncertainCreation(input) {
      if (!allowOrphanCleanup) return { status: videoOrphanRecoveryStatusEnum.NOT_ENABLED };
      const { target, context, result } = await inspectReservation(input);
      if (result.status !== videoOrphanRecoveryStatusEnum.CANDIDATE) return result;
      const specification = { ...target, providerGuid: result.providerGuid, expectedContext: context };
      const committed = await finishCommit(target.recoveryId ? repository.commitUploadRecoveryOrphan(specification) :
        repository.commitOrphanCleanup(specification));
      return { status: committed ? videoOrphanRecoveryStatusEnum.CLEANUP_RECORDED : videoOrphanRecoveryStatusEnum.STALE };
    },
    // Worker-only recovery of setup that never issued upload credentials.
    async recoverUploadSetups({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be between 1 and 100");
      const before = new Date(now() - 60 * 60 * 1000);
      const { operationIds, ...summary } = await finishCommit(repository.recoverStaleSetups({ before, limit }));
      if (repository.recoverStaleUploadRecoveries) {
        const recovered = await finishCommit(repository.recoverStaleUploadRecoveries({ before, limit }));
        for (const field of ["examined", "recovered", "failed"]) summary[field] += recovered[field];
      }
      return summary;
    },
    async recoverUploadSession({ productId, videoId, replacementId, actorId, idempotencyKey, file }) {
      validateBatch({ productId, actorId, idempotencyKey, files: [file] });
      if (!/^[a-f\d]{24}$/i.test(String(videoId)) ||
          (replacementId !== undefined && !/^[a-f\d]{24}$/i.test(String(replacementId))) ||
          file.showInReelsFeed !== undefined) throw invalidMedia();
      const input = { productId, videoId, replacementId, actorId, idempotencyKey: idempotencyKey.trim(), file };
      const response = row => ({ productVideoId: String(videoId), ...(replacementId ? { replacementId: String(replacementId) } : {}),
        recoveryId: String(row.id), position: row.position,
        status: row.status === videoUploadRecoveryStatusEnum.ISSUED ? videoUploadResponseStatusEnum.AWAITING_UPLOAD : videoUploadResponseStatusEnum.RECOVERING,
        ...(row.status === videoUploadRecoveryStatusEnum.ISSUED ? { upload: uploadGrant(row) } : {}),
      });
      let recovery = await repository.getUploadRecoveryReplay(input);
      if (!recovery) {
        const context = await repository.getUploadRecoveryTarget(input);
        let snapshot;
        let absent = false;
        try { snapshot = await provider.getVideo(context.asset.providerGuid); }
        catch (error) {
          if (error?.status === 404) absent = true;
          else throw new ApiError("Video provider is unavailable", 503, [{ code: "VIDEO_PROVIDER_UNAVAILABLE" }]);
        }
        if (!absent) {
          if (snapshot?.guid !== context.asset.providerGuid || snapshot.status !== 0 ||
              (snapshot.videoLibraryId !== undefined && String(snapshot.videoLibraryId) !== context.asset.libraryId)) {
            throw new ApiError("Video is not eligible for upload recovery", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
          }
          let resource;
          try {
            resource = await provider.inspectTusUpload({ videoId: context.asset.providerGuid,
              uploadUrl: context.asset.tusUploadUrl,
              expiresAt: Math.floor(now() / 1000) + Math.min(uploadAuthorizationTtlSeconds, 60) });
          } catch {
            throw new ApiError("Video provider is unavailable", 503, [{ code: "VIDEO_PROVIDER_UNAVAILABLE" }]);
          }
          if (resource?.state !== "not_found") {
            throw new ApiError("Existing upload resource may still resume", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
          }
        }
        recovery = await finishCommit(repository.reserveUploadRecovery({ ...input, expectedAsset: context.asset }));
        return response(recovery);
      }
      if (recovery.status === videoUploadRecoveryStatusEnum.ISSUED) return response(recovery);
      if (recovery.status !== videoUploadRecoveryStatusEnum.WAITING_CLEANUP) {
        throw new ApiError("Upload recovery is already being prepared", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
      }
      const preparing = await repository.beginUploadRecovery(recovery.id);
      if (!preparing) return response(recovery);
      const providerTitle = `petyard-product-recovery:${recovery.id}`;
      let providerGuid;
      let resource;
      try {
        const created = await provider.createVideo({ title: providerTitle });
        providerGuid = created.guid;
        await repository.attachUploadRecoveryVideo({ recoveryId: recovery.id, providerGuid });
        resource = await provider.createTusUpload({ videoId: providerGuid, title: providerTitle,
          sizeBytes: file.sizeBytes, mimeType: file.mimeType,
          expiresAt: Math.min(Math.floor(now() / 1000) + uploadAuthorizationTtlSeconds,
            Math.floor(preparing.abandonAt.getTime() / 1000)) });
        const issued = await repository.issueUploadRecovery({ recoveryId: recovery.id, providerGuid, ...resource });
        return response(issued);
      } catch {
        try {
          await finishCommit(repository.failUploadRecovery({ recoveryId: recovery.id, providerGuid, ...resource }));
        } catch {
          throw new ApiError("Video cleanup could not be persisted", 500, [{ code: "VIDEO_CLEANUP_PERSISTENCE_FAILED" }]);
        }
        throw new ApiError("Video provider is unavailable", 503, [{ code: "VIDEO_PROVIDER_UNAVAILABLE" }]);
      }
    },
    // Worker-only interface: called after a provider GET confirms absence.
    async handleMissingAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO || asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD) return false;
      return Boolean(await finishCommit(repository.commitMissingUpload({ placementId: String(asset.ownerId), assetId: String(asset._id) })));
    },
    async refreshReplacementAuthorization({ productId, videoId, replacementId }) {
      if (![productId, videoId, replacementId].every((id) => /^[a-f\d]{24}$/i.test(String(id)))) throw invalidMedia();
      const upload = await repository.getRefreshableReplacement({ productId, videoId, replacementId });
      return { productVideoId: String(videoId), replacementId: String(replacementId),
        position: upload.position, status: videoUploadResponseStatusEnum.AWAITING_UPLOAD,
        upload: uploadGrant(upload) };
    },
    async cancelReplacementUpload({ productId, videoId, replacementId }) {
      if (![productId, videoId, replacementId].every((id) => /^[a-f\d]{24}$/i.test(String(id)))) throw invalidMedia();
      await finishCommit(repository.cancelReplacement({ productId, videoId, replacementId }));
      return { productVideoId: String(videoId), replacementId: String(replacementId), status: videoUploadResponseStatusEnum.CANCELLED };
    },
    async createReplacementUploadSession({ productId, videoId, actorId, idempotencyKey, file }) {
      validateBatch({ productId, actorId, idempotencyKey, files: [file] });
      if (!/^[a-f\d]{24}$/i.test(String(videoId)) || file.showInReelsFeed !== undefined) throw invalidMedia();
      const replacement = await repository.reserveReplacement({
        productId, videoId, actorId, idempotencyKey: idempotencyKey.trim(), file,
      });
      let issued = replacement;
      if (replacement.status === productVideoReplacementStatusEnum.RESERVING) {
        const providerTitle = `petyard-product-replacement:${replacement.id}`;
        let providerGuid;
        try {
          const created = await provider.createVideo({ title: providerTitle });
          providerGuid = created.guid;
          await repository.attachReplacementVideo({ productId, videoId,
            replacementId: replacement.id, providerGuid });
          const resource = await provider.createTusUpload({ videoId: providerGuid,
            title: providerTitle,
            sizeBytes: file.sizeBytes, mimeType: file.mimeType,
            expiresAt: Math.floor(now() / 1000) + uploadAuthorizationTtlSeconds });
          issued = await repository.issueReplacement({ productId, videoId,
            replacementId: replacement.id, providerGuid, ...resource });
        } catch {
          try { await finishCommit(repository.failReplacementSetup({ productId, videoId,
            replacementId: replacement.id, providerGuid })); }
          catch { throw new ApiError("Video cleanup could not be persisted", 500,
            [{ code: "VIDEO_CLEANUP_PERSISTENCE_FAILED" }]); }
          throw new ApiError("Video provider is unavailable", 503, [{ code: "VIDEO_PROVIDER_UNAVAILABLE" }]);
        }
      }
      if (issued.status !== productVideoReplacementStatusEnum.ISSUED) return {
        productVideoId: String(videoId), replacementId: issued.id,
        position: issued.position, clientId: issued.clientId, status: issued.status,
      };
      return { productVideoId: String(videoId), replacementId: issued.id,
        position: issued.position, clientId: issued.clientId, status: videoUploadResponseStatusEnum.AWAITING_UPLOAD,
        upload: uploadGrant(issued) };
    },
    async setReelsVisibility({ productId, videoId, showInReelsFeed }) {
      if (typeof showInReelsFeed !== "boolean") {
        throw new ApiError("Invalid Product Video visibility", 400, [
          { code: "VIDEO_INVALID_VISIBILITY" },
        ]);
      }
      const result = await finishCommit(repository.setReelsVisibility({
        productId, videoId, showInReelsFeed,
      }));
      return {
        productVideoId: String(result.id),
        showInReelsFeed: result.showInReelsFeed,
      };
    },
    async cancelPendingUpload({ productId, videoId }) {
      const result = await finishCommit(repository.cancelPendingUpload({ productId, videoId }));
      return { productVideoId: String(result.id), status: result.status };
    },
    async requestDeletion({ productId, videoId }) {
      const result = await finishCommit(repository.requestDeletion({ productId, videoId }));
      return { productVideoId: String(result.id), status: result.status };
    },
    async handleDeletedAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO) return { status: videoAssetApplicationResultEnum.IGNORED };
      const placement = await repository.findPlacementForAsset({ asset });
      if (!placement?.activeSlot ||
          String(placement.activeAssetId) !== String(asset._id) ||
          placement.lifecycleState !== productVideoLifecycleStateEnum.DELETING) {
        return { status: videoAssetApplicationResultEnum.STALE };
      }
      const committed = await finishCommit(repository.commitDeletionAccepted({
        placementId: placement.id, assetId: String(asset._id),
      }));
      return { status: committed ? videoAssetApplicationResultEnum.REMOVED : videoAssetApplicationResultEnum.STALE };
    },
    async handleVerifiedAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.PRODUCT_VIDEO) return { status: videoAssetApplicationResultEnum.IGNORED };
      if (asset.technicalState === videoAssetTechnicalStateEnum.AWAITING_UPLOAD && asset.providerStatus === 0) {
        const committed = await finishCommit(repository.commitMissingUpload({
          placementId: String(asset.ownerId), assetId: String(asset._id),
          providerGuid: asset.providerGuid, requireStatusZero: true,
        }));
        return { status: committed ? videoAssetApplicationResultEnum.ABANDONED : videoAssetApplicationResultEnum.STALE };
      }
      const placement = await repository.findPlacementForAsset({ asset });
      if (!placement?.activeSlot) return { status: videoAssetApplicationResultEnum.STALE };
      const assetId = String(asset._id);
      if (String(placement.pendingAssetId) === assetId && asset.technicalState === videoAssetTechnicalStateEnum.READY) {
        const committed = await finishCommit(repository.commitReplacementReady({ placementId: placement.id, assetId }));
        return { status: committed ? videoAssetApplicationResultEnum.READY : videoAssetApplicationResultEnum.STALE };
      }
      if (String(placement.pendingAssetId) === assetId && asset.technicalState === videoAssetTechnicalStateEnum.FAILED) {
        const committed = await finishCommit(repository.commitReplacementFailure({ placementId: placement.id,
          assetId, failureCode: asset.safeFailureCode || "VIDEO_PROVIDER_FAILED" }));
        return { status: committed ? videoAssetApplicationResultEnum.FAILED : videoAssetApplicationResultEnum.STALE };
      }
      if (String(placement.activeAssetId) === assetId &&
          asset.technicalState === videoAssetTechnicalStateEnum.READY) {
        const committed = await finishCommit(repository.commitActiveReady({
          placementId: placement.id, assetId,
        }));
        return { status: committed ? videoAssetApplicationResultEnum.READY : videoAssetApplicationResultEnum.STALE };
      }
      if (String(placement.activeAssetId) === assetId &&
          asset.technicalState === videoAssetTechnicalStateEnum.FAILED) {
        const committed = await finishCommit(repository.commitTerminalFailure({
          placementId: placement.id,
          assetId,
          failureCode: asset.safeFailureCode || "VIDEO_PROVIDER_FAILED",
        }));
        return { status: committed ? videoAssetApplicationResultEnum.FAILED : videoAssetApplicationResultEnum.STALE };
      }
      return { status: videoAssetApplicationResultEnum.IGNORED };
    },
    async listAdminStatus({ productId }) {
      const rows = await repository.listForProduct({ productId });
      return rows.map((row) => ({
        productVideoId: String(row.id),
        position: row.position,
        status: row.lifecycleState,
        showInReelsFeed: row.showInReelsFeed,
        failureCode: row.safeFailureCode || null,
        ...(row.replacement ? { replacement: row.replacement } : {}),
        ...(row.recovery ? { recovery: row.recovery } : {}),
      }));
    },
    async refreshUploadAuthorization({ productId, videoId }) {
      const upload = await repository.getRefreshableUpload({ productId, videoId });
      const nowMs = now();
      const deadline = upload?.abandonAt?.getTime();
      if (!upload || !upload.providerGuid || !Number.isFinite(deadline) ||
          deadline <= nowMs) {
        throw new ApiError("Product Video upload is no longer refreshable", 409, [
          { code: "VIDEO_UPLOAD_CONFLICT" },
        ]);
      }
      return {
        productVideoId: upload.productVideoId,
        position: upload.position,
        status: upload.status,
        upload: uploadGrant(upload),
      };
    },
    async createUploadSessions({ productId, actorId, idempotencyKey, files }) {
      validateBatch({ productId, actorId, idempotencyKey, files });
      idempotencyKey = idempotencyKey.trim();
      const batch = await repository.reserveBatch({
        productId, actorId, idempotencyKey, files,
      });
      if (batch.status === productVideoUploadBatchStatusEnum.ISSUED &&
          batch.placements.some((placement) => !placement.providerGuid)) {
        throw new ApiError("Upload batch is inconsistent", 409, [
          { code: "VIDEO_UPLOAD_CONFLICT" },
        ]);
      }
      if (batch.status === productVideoUploadBatchStatusEnum.ISSUED && batch.placements.some((placement) => {
        const deadline = placement.abandonAt?.getTime();
        return !Number.isFinite(deadline) || Math.floor(deadline / 1000) <= Math.floor(now() / 1000);
      })) throw new ApiError("Upload batch is no longer refreshable", 409, [{ code: "VIDEO_UPLOAD_CONFLICT" }]);
      // Replay never creates another TUS resource, including legacy unbound sessions.
      if (batch.status === productVideoUploadBatchStatusEnum.ISSUED) return batch.placements.map((placement) => ({
        clientId: placement.clientId, productVideoId: placement.id, position: placement.position,
        status: videoUploadResponseStatusEnum.AWAITING_UPLOAD, upload: uploadGrant(placement),
      }));
      const sessions = [];
      const createdVideos = batch.placements
        .filter((placement) => placement.providerGuid)
        .map((placement) => ({
          placementId: placement.id, providerGuid: placement.providerGuid,
        }));
      try {
        for (const placement of batch.placements) {
          // The reservation ID is committed before Bunny is called and retained after failure/removal.
          const providerTitle = `petyard-product-video:${placement.id}`;
          let providerGuid = placement.providerGuid;
          if (!providerGuid) {
            const created = await provider.createVideo({
              title: providerTitle,
            });
            providerGuid = created.guid;
            createdVideos.push({ placementId: placement.id, providerGuid });
            await repository.attachProviderVideo({
              placementId: placement.id,
              providerGuid,
            });
          }
          const resource = await provider.createTusUpload({
            videoId: providerGuid,
            title: providerTitle,
            sizeBytes: files.find((file) => file.clientId === placement.clientId).sizeBytes,
            mimeType: files.find((file) => file.clientId === placement.clientId).mimeType,
            expiresAt: Math.floor(now() / 1000) + uploadAuthorizationTtlSeconds,
          });
          await repository.attachTusUpload({ placementId: placement.id, providerGuid, ...resource });
          const upload = uploadGrant({ providerGuid, ...resource,
            abandonAt: new Date(now() + 24 * 60 * 60 * 1000) });
          sessions.push({
            clientId: placement.clientId,
            productVideoId: placement.id,
            position: placement.position,
            status: videoUploadResponseStatusEnum.AWAITING_UPLOAD,
            upload,
          });
        }
        if (batch.status !== productVideoUploadBatchStatusEnum.ISSUED) {
          await repository.markBatchIssued({ productId, idempotencyKey });
        }
      } catch {
        if (batch.status !== productVideoUploadBatchStatusEnum.ISSUED) {
          try {
            await finishCommit(repository.failBatch({ productId, idempotencyKey, createdVideos }));
          } catch {
            throw new ApiError("Video cleanup could not be persisted", 500, [
              { code: "VIDEO_CLEANUP_PERSISTENCE_FAILED" },
            ]);
          }
        }
        throw new ApiError("Video provider is unavailable", 503, [
          { code: "VIDEO_PROVIDER_UNAVAILABLE" },
        ]);
      }
      return sessions;
    },
  });
}
