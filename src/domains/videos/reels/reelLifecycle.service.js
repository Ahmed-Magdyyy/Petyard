import {
  editorialVideoStatusEnum,
  editorialReviewStatusEnum,
  videoAssetOwnerTypeEnum,
  videoAssetApplicationResultEnum,
} from "../../../shared/constants/enums.js";
import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { createReelLifecycleRepository } from "./reelLifecycle.repository.js";
import { isVerifiedReelAssetReady } from "./reelAsset.policy.js";

export function createReelLifecycle({ repository = createReelLifecycleRepository(),
  verifyPreviewReady = async () => false, enqueue = enqueueVideoProviderOperation, now = () => new Date() } = {}) {
  if (typeof verifyPreviewReady !== "function") {
    throw new TypeError("Reel preview verifier is required");
  }
  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result;
  }

  return Object.freeze({
    async handleVerifiedAsset(asset) {
      if (asset?.ownerType !== videoAssetOwnerTypeEnum.REEL) return { status: videoAssetApplicationResultEnum.IGNORED };
      if (!isVerifiedReelAssetReady(asset)) return { status: videoAssetApplicationResultEnum.NOT_READY };
      const current = await repository.findCurrentForAsset(asset);
      if (!current) return { status: videoAssetApplicationResultEnum.STALE };
      if (current.replacement) {
        if (!current.session.autoApplyWhenReady || !current.video.pendingChange?.autoApplyWhenReady ||
            current.video.pendingChange.status !== editorialReviewStatusEnum.DRAFT) return { status: videoAssetApplicationResultEnum.AWAITING_REVIEW };
        if (!(await verifyPreviewReady(asset))) {
          await repository.deferReplacementProbe({ asset, sessionId: current.session._id,
            nextProbeAt: new Date(now().getTime() + 5 * 60_000) });
          return { status: videoAssetApplicationResultEnum.PREVIEW_PENDING };
        }
        const applied = await finishCommit(repository.applyReplacement({ videoId: asset.ownerId,
          expectedRevision: current.video.revision, sessionId: current.session._id,
          assetId: asset._id, automatic: true, now: now() }));
        return { status: applied ? videoAssetApplicationResultEnum.APPLIED : videoAssetApplicationResultEnum.STALE };
      }
      if (current.video.status === editorialVideoStatusEnum.PUBLISHED) return { status: videoAssetApplicationResultEnum.ALREADY_PUBLISHED };
      if (!current.video.autoPublishWhenReady || current.video.status !== editorialVideoStatusEnum.DRAFT) {
        return { status: videoAssetApplicationResultEnum.AWAITING_REVIEW };
      }
      // The ready Bunny metadata alone is insufficient evidence that staff can
      // actually preview the playback URL. The production verifier remains
      // fail-closed until a protected preview probe is implemented.
      if (!(await verifyPreviewReady(asset))) {
        await repository.deferPreviewProbe?.({ asset,
          sessionId: current.session._id,
          nextProbeAt: new Date(now().getTime() + 5 * 60_000) });
        return { status: videoAssetApplicationResultEnum.PREVIEW_PENDING };
      }
      const published = await repository.publishIfCurrent({ asset,
        sessionId: current.session._id, expectedProductIds: (current.video.productIds ?? []).map(String), now: now() });
      return { status: published ? videoAssetApplicationResultEnum.PUBLISHED : videoAssetApplicationResultEnum.STALE };
    },
    async recoverPreviewPending({ limit = 100 } = {}) {
      const initial = await repository.listDuePreviewProbes({ before: now(), limit });
      const replacements = initial.length < limit && repository.listDueReplacementProbes
        ? await repository.listDueReplacementProbes({ before: now(), limit: limit - initial.length }) : [];
      const candidates = [...initial, ...replacements];
      let attempted = 0;
      let published = 0;
      let applied = 0;
      for (const candidate of candidates) {
        const claimedAt = now();
        const claim = candidate.pendingChange?.autoApplyWhenReady
          ? repository.claimDueReplacementProbe : repository.claimDuePreviewProbe;
        const asset = await claim({ candidate, claimedAt,
          nextProbeAt: new Date(claimedAt.getTime() + 5 * 60_000) });
        if (!asset) continue;
        attempted += 1;
        const result = await this.handleVerifiedAsset(asset);
        if (result.status === videoAssetApplicationResultEnum.PUBLISHED) published += 1;
        if (result.status === videoAssetApplicationResultEnum.APPLIED) applied += 1;
      }
      return { examined: candidates.length, attempted, published, applied };
    },
  });
}
