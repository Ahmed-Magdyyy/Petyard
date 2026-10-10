import {
  videoAssetOwnerTypeEnum,
  videoAssetTechnicalStateEnum,
  productVideoLifecycleStateEnum,
  videoContentKindEnum,
} from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

import { ProductModel } from "../../product/product.model.js";
import { ProductVideoModel } from "../productVideos/productVideo.model.js";
import { VideoAssetModel } from "../provider/videoAsset.model.js";
import { PRODUCT_BATCH_MAX_IDS, PRODUCT_BATCH_QUERY_TIMEOUT_MS } from "../../product/productBatch.constants.js";

export function productEligibleStages({ products, assets, feedOnly = false }) {
  return [
    { $match: { activeSlot: true, lifecycleState: { $in: [productVideoLifecycleStateEnum.READY, productVideoLifecycleStateEnum.DELETING] },
      activeAssetId: { $exists: true }, removedAt: { $exists: false },
      ...(feedOnly ? { showInReelsFeed: true } : {}) } },
    { $lookup: { from: products.collection.name, localField: "productId",
      foreignField: "_id", as: "product" } },
    { $unwind: "$product" },
    { $match: { "product.isActive": true } },
    { $lookup: { from: assets.collection.name, localField: "activeAssetId",
      foreignField: "_id", as: "asset" } },
    { $unwind: "$asset" },
    { $match: {
      "asset.ownerType": videoAssetOwnerTypeEnum.PRODUCT_VIDEO, "asset.technicalState": videoAssetTechnicalStateEnum.READY,
      "asset.providerStatus": 4, "asset.readyAt": { $type: "date" },
      // A durable request alone does not remove the current video. Bunny's
      // acceptance (or confirmed absence) is the public visibility boundary.
      "asset.deleteAcceptedAt": { $exists: false },
      "asset.durationSeconds": { $gt: 0, $lte: 90 },
      "asset.width": { $gt: 0, $mod: [1, 0] }, "asset.height": { $gt: 0, $mod: [1, 0] },
      "asset.availableResolutions.0": { $exists: true },
      $expr: { $eq: ["$asset.ownerId", "$_id"] },
    } },
    { $addFields: { kind: videoContentKindEnum.PRODUCT, feedAt: "$asset.readyAt" } },
  ];
}

export function createPublicProductVideoRepository({ placements = ProductVideoModel,
  products = ProductModel, assets = VideoAssetModel } = {}) {
  return Object.freeze({
    async listForProducts(productIds) {
      if (!Array.isArray(productIds) || productIds.length > PRODUCT_BATCH_MAX_IDS ||
        productIds.some((id) => !mongoose.isValidObjectId(id))) throw new TypeError("Invalid product media batch IDs");
      if (!productIds.length) return [];
      return placements.aggregate([
        { $match: { productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
        ...productEligibleStages({ products, assets }),
        { $sort: { productId: 1, position: 1, _id: 1 } },
      ]).option({ maxTimeMS: PRODUCT_BATCH_QUERY_TIMEOUT_MS });
    },
    async listForProduct(productId) {
      if (!mongoose.isValidObjectId(productId)) return [];
      return placements.aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(productId) } },
        ...productEligibleStages({ products, assets }),
        { $sort: { position: 1, _id: 1 } },
      ]);
    },
    async getPlayable(id, { session } = {}) {
      if (!mongoose.isValidObjectId(id)) return null;
      const query = placements.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(id) } },
        ...productEligibleStages({ products, assets }),
        { $limit: 1 },
      ]);
      if (session) query.session(session);
      const rows = await query;
      return rows[0] ?? null;
    },
  });
}
