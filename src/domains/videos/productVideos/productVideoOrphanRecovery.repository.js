import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoUploadBatchStatusEnum,
  productVideoReplacementStatusEnum,
  videoUploadRecoveryStatusEnum,
  videoProviderOperationTypeEnum,
} from "../../../shared/constants/enums.js";
const INITIAL_PLACEMENT = { activeSlot: false, lifecycleState: { $in: [productVideoLifecycleStateEnum.FAILED, productVideoLifecycleStateEnum.REMOVED] },
  activeAssetId: { $exists: false }, pendingAssetId: { $exists: false },
  replacementId: { $exists: false }, uploadSessionIssuedAt: { $exists: false } };
const FAILED_RESERVATION = { issuedAt: { $exists: false },
  failureCode: { $in: ["VIDEO_PROVIDER_UNAVAILABLE", "VIDEO_UPLOAD_SETUP_EXPIRED"] } };

// Internal persistence for unknown-GUID reservations. Owner rules are shared
// by read-only discovery and transactional cleanup adoption.
export function createProductVideoOrphanRecoveryPersistence({
  libraryId, batches, replacements, placements, recoveries, assets, withTransaction, recordOperation, now,
}) {
  async function loadReservation({ videoId, replacementId }, session = null) {
    if (replacementId) {
      const replacement = await replacements.findOne({ _id: replacementId, videoId,
        status: productVideoReplacementStatusEnum.FAILED, ...FAILED_RESERVATION, assetId: { $exists: false } }).session(session).lean();
      if (!replacement) return null;
      const placement = await placements.findOne({ _id: videoId, productId: replacement.productId }).session(session).lean();
      return placement ? { placement, replacement } : null;
    }
    const placement = await placements.findOne({ _id: videoId, ...INITIAL_PLACEMENT }).session(session).lean();
    if (!placement) return null;
    const batch = await batches.findOne({ _id: placement.uploadBatchId, productId: placement.productId,
      status: productVideoUploadBatchStatusEnum.FAILED, ...FAILED_RESERVATION }).session(session).lean();
    return batch ? { placement, batch } : null;
  }

  function searchContext({ placement, replacement, batch }) {
    return replacement ? {
      libraryId, providerTitle: `petyard-product-replacement:${String(replacement._id)}`,
      createdAt: replacement.createdAt, failedAt: replacement.finishedAt,
    } : {
      libraryId, providerTitle: `petyard-product-video:${String(placement._id)}`,
      createdAt: placement.createdAt, failedAt: batch.failedAt,
    };
  }

  return {
    async listOrphanRecoveryCandidates({ before, limit }) {
      const due = { updatedAt: { $lte: before } };
      const query = modelQuery => modelQuery.sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const [initial, replacement, recovery] = await Promise.all([
        query(placements.find({ ...INITIAL_PLACEMENT, ...due })),
        query(replacements.find({ status: productVideoReplacementStatusEnum.FAILED,
          ...FAILED_RESERVATION, assetId: { $exists: false }, ...due })),
        query(recoveries.find({ status: videoUploadRecoveryStatusEnum.FAILED,
          assetId: { $exists: false }, ...due })),
      ]);
      return [
        ...initial.map(row => ({ target: { videoId: String(row._id) }, updatedAt: row.updatedAt })),
        ...replacement.map(row => ({ target: { videoId: String(row.videoId), replacementId: String(row._id) }, updatedAt: row.updatedAt })),
        ...recovery.map(row => ({ target: { videoId: String(row.videoId), recoveryId: String(row._id) }, updatedAt: row.updatedAt })),
      ].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit);
    },
    async claimOrphanRecoveryCandidate({ target, updatedAt, claimedAt }) {
      const { videoId, replacementId, recoveryId } = target;
      const model = recoveryId ? recoveries : replacementId ? replacements : placements;
      const filter = recoveryId ? { _id: recoveryId, videoId, status: videoUploadRecoveryStatusEnum.FAILED,
        assetId: { $exists: false } } : replacementId ? { _id: replacementId, videoId,
        status: productVideoReplacementStatusEnum.FAILED, ...FAILED_RESERVATION, assetId: { $exists: false } } :
        { _id: videoId, ...INITIAL_PLACEMENT };
      // Advance only the probe timestamp; failure times and upload deadlines stay intact.
      const result = await model.updateOne({ ...filter, updatedAt },
        { $set: { updatedAt: claimedAt } }, { timestamps: false });
      return result.modifiedCount === 1;
    },
    async getOrphanSearchContext(target) {
      const reservation = await loadReservation(target);
      return reservation ? searchContext(reservation) : null;
    },
    async isOrphanGuidTracked(providerGuid) {
      return Boolean(await assets.exists({ libraryId, providerGuid }));
    },
    async commitOrphanCleanup({ videoId, replacementId, providerGuid, expectedContext }) {
      if (typeof providerGuid !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(providerGuid)) {
        throw new TypeError("Invalid Product Video orphan GUID");
      }
      return withTransaction(async (session) => {
        const reservation = await loadReservation({ videoId, replacementId }, session);
        if (!reservation) return false;
        const context = searchContext(reservation);
        if (!expectedContext || context.libraryId !== expectedContext.libraryId ||
            context.providerTitle !== expectedContext.providerTitle ||
            context.createdAt?.getTime() !== expectedContext.createdAt?.getTime() ||
            context.failedAt?.getTime() !== expectedContext.failedAt?.getTime()) return false;
        // The unique library/GUID index guards attachments racing this read.
        if (await assets.findOne({ libraryId, providerGuid }).session(session)) return false;
        const requestedAt = new Date(now());
        const { placement, batch, replacement } = reservation;
        const [asset] = await assets.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placement._id,
          libraryId, providerGuid, technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: requestedAt,
          safeFailureCode: (replacement ?? batch).failureCode }], { session });
        const attached = replacement ? await replacements.updateOne({ _id: replacement._id,
          productId: replacement.productId, videoId: placement._id, createdAt: replacement.createdAt,
          finishedAt: replacement.finishedAt, status: productVideoReplacementStatusEnum.FAILED,
          ...FAILED_RESERVATION, assetId: { $exists: false } },
        { $set: { assetId: asset._id } }, { session }) : await placements.updateOne({ _id: placement._id, productId: placement.productId,
          uploadBatchId: batch._id, createdAt: placement.createdAt, ...INITIAL_PLACEMENT },
        { $set: { activeAssetId: asset._id } }, { session });
        if (attached.modifiedCount !== 1) throw new Error("PRODUCT_VIDEO_ORPHAN_RESERVATION_CHANGED");
        const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
          libraryId, providerGuid, dedupeKey: replacement ? `replacement-setup:${replacement._id}` :
            `batch-failed:${batch._id}:${providerGuid}`, session });
        return { operationId: String(operation._id) };
      });
    },
  };
}
