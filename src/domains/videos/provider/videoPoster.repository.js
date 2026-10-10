import { videoAssetTechnicalStateEnum } from "../../../shared/constants/enums.js";
import { VideoAssetModel } from "./videoAsset.model.js";

function target(operation) {
  return { _id: operation.assetId, libraryId: operation.libraryId,
    providerGuid: operation.providerGuid };
}

export function createVideoPosterRepository({ model = VideoAssetModel } = {}) {
  return Object.freeze({
    findForOperation(operation) { return model.findOne(target(operation)); },
    attachIfEligible(operation, poster, thumbnailFileName, copiedAt) {
      return model.findOneAndUpdate({ ...target(operation),
        technicalState: videoAssetTechnicalStateEnum.READY, providerStatus: 4,
        deletionRequestedAt: { $exists: false }, deleteAcceptedAt: { $exists: false },
        "poster.url": { $exists: false },
      }, { $set: { poster, thumbnailFileName,
        posterCopiedAt: copiedAt } }, { new: true, runValidators: true });
    },
  });
}
