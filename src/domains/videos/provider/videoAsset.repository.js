import { videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
import { VideoAssetModel } from "./videoAsset.model.js";

export function createVideoAssetRepository({ model = VideoAssetModel } = {}) {
  return Object.freeze({
    listNeedingPoster({ libraryId, limit }) {
      return model.find({ libraryId, technicalState: videoAssetTechnicalStateEnum.READY, providerStatus: 4,
        deletionRequestedAt: { $exists: false }, deleteAcceptedAt: { $exists: false },
        "poster.url": { $exists: false }, posterRequestedAt: { $exists: false },
      }).sort({ readyAt: 1, _id: 1 }).limit(limit).lean();
    },
    markPosterRequested(asset, requestedAt) {
      return model.updateOne({ _id: asset._id, libraryId: asset.libraryId,
        providerGuid: asset.providerGuid, posterRequestedAt: { $exists: false },
      }, { $set: { posterRequestedAt: requestedAt } });
    },
    findForOperation(operation) {
      return model.findOne({ _id: operation.assetId,
        libraryId: operation.libraryId, providerGuid: operation.providerGuid });
    },
    listStuck({ before, limit }) {
      return model.find({
        technicalState: { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.PROCESSING] },
        updatedAt: { $lte: before },
      })
        .sort({ updatedAt: 1, _id: 1 })
        .limit(limit)
        .lean();
    },
    findDeletionIntent(operation) {
      return model.findOne({
        _id: operation.assetId,
        libraryId: operation.libraryId,
        providerGuid: operation.providerGuid,
        deletionRequestedAt: { $exists: true },
      });
    },
    markDeleteAccepted(operation, acceptedAt) {
      return model.findOneAndUpdate(
        {
          _id: operation.assetId,
          libraryId: operation.libraryId,
          providerGuid: operation.providerGuid,
          deletionRequestedAt: { $exists: true },
        },
        {
          $set: {
            technicalState: videoAssetTechnicalStateEnum.DELETED,
            deleteAcceptedAt: acceptedAt,
            deletedAt: acceptedAt,
          },
        },
        { new: true },
      );
    },
    applySnapshot(operation, initialStatus, fields) {
      return model.findOneAndUpdate(
        {
          _id: operation.assetId,
          libraryId: operation.libraryId,
          providerGuid: operation.providerGuid,
          // The empty-resource canary returned status 0 before any bytes.
          // It is not evidence that upload/encoding has started, and a late
          // status-0 response must never regress an already processing asset.
          technicalState: initialStatus ? videoAssetTechnicalStateEnum.AWAITING_UPLOAD : { $in: [videoAssetTechnicalStateEnum.AWAITING_UPLOAD, videoAssetTechnicalStateEnum.PROCESSING] },
        },
        { $set: fields },
        { new: true },
      );
    },
  });
}
