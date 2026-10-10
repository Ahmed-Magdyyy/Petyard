import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  productVideoUploadBatchStatusEnum,
  productVideoReplacementStatusEnum,
  videoProviderOperationTypeEnum,
  videoUploadAttemptStageEnum,
  videoUploadAttemptOutcomeEnum,
  productVideoSetupKindEnum,
} from "../../../shared/constants/enums.js";
// Internal persistence for unissued setup reservations, not upload abandonment.
// No provider or queue call is made inside a Mongo transaction.
export function createSetupRecoveryPersistence({
  libraryId, batches, replacements, placements, assets, attempts, withTransaction, recordOperation, now,
}) {
  async function recoverBatch(id, before) {
    return withTransaction(async (session) => {
      const finishedAt = new Date(now());
      const batch = await batches.findOneAndUpdate({ _id: id, status: productVideoUploadBatchStatusEnum.RESERVING, updatedAt: { $lte: before } },
        { $set: { status: productVideoUploadBatchStatusEnum.FAILED, failureCode: "VIDEO_UPLOAD_SETUP_EXPIRED", failedAt: finishedAt } },
        { session, new: true });
      if (!batch) return null;
      const rows = await placements.find({ uploadBatchId: batch._id }).session(session);
      if (rows.some((row) => (row.activeSlot && row.lifecycleState !== productVideoLifecycleStateEnum.RESERVING) || row.pendingAssetId)) {
        throw new Error("VIDEO_SETUP_STATE_CONFLICT");
      }
      const operationIds = [];
      for (const row of rows) {
        if (row.activeAssetId) {
          const asset = await assets.findOne({ _id: row.activeAssetId, libraryId,
            ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id }).session(session);
          if (!asset) throw new Error("VIDEO_SETUP_ASSET_MISSING");
          // Existing deletion intent already has its durable cleanup obligation.
          if (!asset.deletionRequestedAt) {
            await assets.updateOne({ _id: asset._id }, { $set: {
              technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: finishedAt,
            } }, { session });
            const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
              libraryId, providerGuid: asset.providerGuid,
              dedupeKey: `batch-failed:${batch._id}:${asset.providerGuid}`, session });
            operationIds.push(String(operation._id));
          }
        }
        await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id,
          actorId: batch.actorId, safeFilename: row.safeFilename,
          ...(row.activeAssetId ? { assetId: row.activeAssetId } : {}),
          stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: "VIDEO_UPLOAD_SETUP_EXPIRED", finishedAt }], { session });
      }
      await placements.updateMany({ uploadBatchId: batch._id, activeSlot: true, lifecycleState: productVideoLifecycleStateEnum.RESERVING },
        { $set: { activeSlot: false, lifecycleState: productVideoLifecycleStateEnum.FAILED, removedAt: finishedAt } }, { session });
      return operationIds;
    });
  }

  async function recoverReplacement(id, before) {
    return withTransaction(async (session) => {
      const finishedAt = new Date(now());
      const replacement = await replacements.findOneAndUpdate({ _id: id,
        status: productVideoReplacementStatusEnum.RESERVING, updatedAt: { $lte: before }, issuedAt: { $exists: false } },
      { $set: { status: productVideoReplacementStatusEnum.FAILED, failureCode: "VIDEO_UPLOAD_SETUP_EXPIRED", finishedAt } }, { session, new: true });
      if (!replacement) return null;
      const row = await placements.findOne({ _id: replacement.videoId,
        productId: replacement.productId, replacementId: id }).session(session);
      if (row?.pendingAssetId && String(row.pendingAssetId) !== String(replacement.assetId)) throw new Error("VIDEO_SETUP_STATE_CONFLICT");
      const operationIds = [];
      if (replacement.assetId) {
        const asset = await assets.findOne({ _id: replacement.assetId, libraryId,
          ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: replacement.videoId }).session(session);
        if (!asset) throw new Error("VIDEO_SETUP_ASSET_MISSING");
        if (!asset.deletionRequestedAt) {
          if (asset.technicalState !== videoAssetTechnicalStateEnum.AWAITING_UPLOAD) throw new Error("VIDEO_SETUP_STATE_CONFLICT");
          await assets.updateOne({ _id: asset._id }, { $set: {
            technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: finishedAt,
          } }, { session });
          const operation = await recordOperation({ type: videoProviderOperationTypeEnum.ABANDONED_UPLOAD_CLEANUP, assetId: asset._id,
            libraryId, providerGuid: asset.providerGuid, dedupeKey: `replacement-setup:${id}`, session });
          operationIds.push(String(operation._id));
        }
      }
      await placements.updateOne({ _id: replacement.videoId, productId: replacement.productId, replacementId: id },
        { $unset: { replacementId: "", pendingAssetId: "" }, $set: { replacementFailureCode: "VIDEO_UPLOAD_SETUP_EXPIRED" } }, { session });
      await attempts.create([{ ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: replacement.videoId,
        actorId: replacement.actorId, safeFilename: replacement.safeFilename,
        ...(replacement.assetId ? { assetId: replacement.assetId } : {}),
        stage: videoUploadAttemptStageEnum.SESSION, outcome: videoUploadAttemptOutcomeEnum.FAILED, errorCode: "VIDEO_UPLOAD_SETUP_EXPIRED", finishedAt }], { session });
      return operationIds;
    });
  }

  return {
    async recoverStaleSetups({ before, limit }) {
      const batchRows = await batches.find({ status: productVideoUploadBatchStatusEnum.RESERVING, updatedAt: { $lte: before } })
        .sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const replacementRows = await replacements.find({ status: productVideoReplacementStatusEnum.RESERVING, updatedAt: { $lte: before } })
        .sort({ updatedAt: 1, _id: 1 }).limit(limit).lean();
      const candidates = [
        ...batchRows.map((row) => ({ ...row, kind: productVideoSetupKindEnum.BATCH })),
        ...replacementRows.map((row) => ({ ...row, kind: productVideoSetupKindEnum.REPLACEMENT })),
      ].sort((a, b) => a.updatedAt - b.updatedAt || String(a._id).localeCompare(String(b._id))).slice(0, limit);
      const summary = { examined: candidates.length, recovered: 0, failed: 0, operationIds: [] };
      for (const candidate of candidates) {
        try {
          const operationIds = candidate.kind === productVideoSetupKindEnum.BATCH
            ? await recoverBatch(candidate._id, before)
            : await recoverReplacement(candidate._id, before);
          if (!operationIds) continue;
          summary.recovered += 1;
          summary.operationIds.push(...operationIds);
        } catch { summary.failed += 1; }
      }
      return summary;
    },
  };
}
