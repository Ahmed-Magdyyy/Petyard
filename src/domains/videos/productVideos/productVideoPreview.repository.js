import { videoAssetOwnerTypeEnum, productVideoReplacementStatusEnum, videoPreviewSelectionEnum } from "../../../shared/constants/enums.js";
import { ProductModel } from "../../product/product.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { ProductVideoModel } from "./productVideo.model.js";
import { ProductVideoReplacementModel } from "./productVideoReplacement.model.js";

export function createProductVideoPreviewRepository({ libraryId, products = ProductModel,
  placements = ProductVideoModel, assets = VideoAssetModel,
  replacements = ProductVideoReplacementModel } = {}) {
  if (typeof libraryId !== "string" || !/^\d+$/.test(libraryId)) {
    throw new TypeError("Preview libraryId must be numeric");
  }
  return Object.freeze({
    async findCandidate({ productId, videoId, asset = videoPreviewSelectionEnum.ACTIVE }) {
      if (![productId, videoId].every((id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id)) ||
          !Object.values(videoPreviewSelectionEnum).includes(asset)) return null;
      // Staff can inspect inactive products; a deleted product cannot grant
      // a preview, even if placement/asset cleanup has not completed yet.
      if (!await products.exists({ _id: productId })) return null;
      const placement = await placements.findOne({ _id: videoId, productId,
        activeSlot: true, removedAt: { $exists: false },
      }).lean();
      if (!placement) return null;
      const assetId = asset === videoPreviewSelectionEnum.PENDING ? placement.pendingAssetId : placement.activeAssetId;
      if (!assetId) return null;
      const media = await assets.findOne({ _id: assetId, libraryId,
        ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: placement._id }).lean();
      if (!media) return null;
      let replacement = null;
      if (asset === videoPreviewSelectionEnum.PENDING) {
        if (!placement.replacementId) return null;
        replacement = await replacements.findOne({ _id: placement.replacementId,
          productId, videoId, assetId, status: productVideoReplacementStatusEnum.ISSUED }).lean();
        if (!replacement) return null;
      }
      return { placement, asset: media, replacement };
    },
  });
}
