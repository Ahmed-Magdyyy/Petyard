import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  videoProviderOperationTypeEnum,
} from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

import { ProductModel } from "../../product/product.model.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { ProductVideoModel } from "./productVideo.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { recordVideoProviderOperation } from "../provider/videoProviderOperation.service.js";

// The Product domain calls this interface after its existing image cleanup.
// Product removal, placement tombstones, and provider obligations commit together.
export function createProductVideoProductDeletionRepository({
  productId,
  connection = mongoose,
  products = ProductModel,
  placements = ProductVideoModel,
  assets = VideoAssetModel,
  recordOperation = recordVideoProviderOperation,
  now = Date.now,
}) {
  return Object.freeze({
    hasPlacements: () => placements.exists({ productId }),
    deleteImageOnly: () => products.deleteOne({ _id: productId }),
    async deleteWithVideos() {
      const session = await connection.startSession();
      let operationIds;
      try {
        await session.withTransaction(async () => {
          const deletedProduct = await products.findOneAndDelete(
            { _id: productId }, { session },
          );
          if (!deletedProduct) {
            throw new ApiError("Product not found", 404, [{ code: "VIDEO_NOT_AVAILABLE" }]);
          }

          const rows = await placements.find({ productId, activeSlot: true })
            .session(session).lean();
          const removedAt = new Date(now());
          const ids = [];
          for (const row of rows) {
            const assetIds = new Set([row.activeAssetId, row.pendingAssetId]
              .filter(Boolean).map(String));
            for (const assetId of assetIds) {
              const asset = await assets.findOne({
                _id: assetId, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id,
              }).session(session);
              if (!asset) throw new Error("PRODUCT_VIDEO_ASSET_MISSING");
              if (asset.technicalState === videoAssetTechnicalStateEnum.DELETED) continue;
              await assets.updateOne(
                { _id: asset._id, ownerType: videoAssetOwnerTypeEnum.PRODUCT_VIDEO, ownerId: row._id },
                { $set: { technicalState: videoAssetTechnicalStateEnum.DELETING, deletionRequestedAt: removedAt } },
                { session },
              );
              const operation = await recordOperation({
                type: videoProviderOperationTypeEnum.DELETE, assetId: asset._id,
                libraryId: asset.libraryId, providerGuid: asset.providerGuid,
                dedupeKey: `product-cascade:${productId}:${asset._id}`,
                session,
              });
              ids.push(String(operation._id));
            }
          }
          await placements.updateMany(
            { productId, activeSlot: true },
            { $set: { activeSlot: false, lifecycleState: productVideoLifecycleStateEnum.REMOVED, removedAt } },
            { session },
          );
          operationIds = ids;
        });
      } finally {
        await session.endSession();
      }

      return operationIds;
    },
  });
}
