import { RestockSubscriptionModel, restockSubscriptionStatus } from "./restockSubscription.model.js";
import { ProductModel } from "../product/product.model.js";
import { UserModel } from "../user/user.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";

// User identity intentionally wins if both values are provided. This mirrors
// the rest of the guest-aware domains and avoids cross-identity data access.
export function buildRestockSubscriptionIdentityFilter({ userId, guestId } = {}) {
  if (userId) return { user: userId };

  const normalizedGuestId =
    typeof guestId === "string" ? guestId.trim() : "";
  if (normalizedGuestId) return { guestId: normalizedGuestId };

  return null;
}

function identityFilterOrNoMatch(identity) {
  return buildRestockSubscriptionIdentityFilter(identity) || { _id: null };
}

export function findSubscription({ userId, guestId, productId, warehouseId }) {
  return RestockSubscriptionModel.findOne({
    ...identityFilterOrNoMatch({ userId, guestId }),
    product: productId,
    warehouse: warehouseId,
  }).lean();
}

export function activateSubscription({ userId, guestId, productId, warehouseId }) {
  const identity = identityFilterOrNoMatch({ userId, guestId });
  return RestockSubscriptionModel.findOneAndUpdate(
    { ...identity, product: productId, warehouse: warehouseId },
    {
      $set: {
        status: restockSubscriptionStatus.ACTIVE,
        claimToken: null,
        claimedAt: null,
        notifiedAt: null,
      },
      $setOnInsert: {
        ...identity,
        product: productId,
        warehouse: warehouseId,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

export function cancelSubscription({ userId, guestId, productId, warehouseId }) {
  return RestockSubscriptionModel.findOneAndUpdate(
    {
      ...identityFilterOrNoMatch({ userId, guestId }),
      product: productId,
      warehouse: warehouseId,
    },
    {
      $set: {
        status: restockSubscriptionStatus.CANCELLED,
        claimToken: null,
        claimedAt: null,
      },
    },
    { new: true }
  ).lean();
}

export function recoverStaleProcessingClaims({ productId, warehouseIds, before }) {
  const filter = {
    product: productId,
    status: restockSubscriptionStatus.PROCESSING,
    claimedAt: { $lt: before },
  };
  if (warehouseIds?.length) filter.warehouse = { $in: warehouseIds };

  return RestockSubscriptionModel.updateMany(filter, {
    $set: {
      status: restockSubscriptionStatus.ACTIVE,
      claimToken: null,
      claimedAt: null,
    },
  });
}

export function findActiveSubscriptions({ productId, warehouseIds }) {
  const filter = { product: productId, status: restockSubscriptionStatus.ACTIVE };
  if (warehouseIds?.length) filter.warehouse = { $in: warehouseIds };
  return RestockSubscriptionModel.find(filter).lean();
}

export function findActiveSubscriptionsForUser({
  userId,
  guestId,
  productIds,
  warehouseId,
}) {
  if (!Array.isArray(productIds) || productIds.length === 0) return [];

  return RestockSubscriptionModel.find({
    ...identityFilterOrNoMatch({ userId, guestId }),
    product: { $in: productIds },
    warehouse: warehouseId,
    status: {
      $in: [
        restockSubscriptionStatus.ACTIVE,
        restockSubscriptionStatus.PROCESSING,
      ],
    },
  })
    .select("product")
    .lean();
}

export function findPendingSubscriptionsForIdentity({ userId, guestId }) {
  return RestockSubscriptionModel.find({
    ...identityFilterOrNoMatch({ userId, guestId }),
    status: {
      $in: [
        restockSubscriptionStatus.ACTIVE,
        restockSubscriptionStatus.PROCESSING,
      ],
    },
  })
    .select("product warehouse status createdAt")
    .sort({ createdAt: -1 })
    .lean();
}

export function findPendingGuestSubscriptions(guestId) {
  return RestockSubscriptionModel.find({
    ...identityFilterOrNoMatch({ guestId }),
    status: {
      $in: [
        restockSubscriptionStatus.ACTIVE,
        restockSubscriptionStatus.PROCESSING,
      ],
    },
  }).lean();
}

export function claimActiveSubscription({ subscriptionId, claimToken, claimedAt }) {
  return RestockSubscriptionModel.findOneAndUpdate(
    { _id: subscriptionId, status: restockSubscriptionStatus.ACTIVE },
    {
      $set: {
        status: restockSubscriptionStatus.PROCESSING,
        claimToken,
        claimedAt,
      },
    },
    { new: true }
  ).lean();
}

export function markSubscriptionNotified({ subscriptionId, claimToken, notifiedAt }) {
  return RestockSubscriptionModel.updateOne(
    {
      _id: subscriptionId,
      status: restockSubscriptionStatus.PROCESSING,
      claimToken,
    },
    {
      $set: {
        status: restockSubscriptionStatus.NOTIFIED,
        notifiedAt,
      },
      $unset: { claimToken: 1, claimedAt: 1 },
    }
  );
}

export function releaseSubscriptionClaim({ subscriptionId, claimToken }) {
  return RestockSubscriptionModel.updateOne(
    {
      _id: subscriptionId,
      status: restockSubscriptionStatus.PROCESSING,
      claimToken,
    },
    {
      $set: { status: restockSubscriptionStatus.ACTIVE },
      $unset: { claimToken: 1, claimedAt: 1 },
    }
  );
}

export function deleteSubscriptionsForProduct(productId) {
  return RestockSubscriptionModel.deleteMany({ product: productId });
}

export function deleteSubscriptionsForGuest(guestId) {
  return RestockSubscriptionModel.deleteMany(
    identityFilterOrNoMatch({ guestId })
  );
}

export function aggregateRestockDemandSummary({
  warehouseId,
  warehouseScope,
  searchRegex,
  page,
  limit,
}) {
  const pipeline = [
    { $match: pendingDemandMatch({ warehouseId, warehouseScope }) },
  ];

  if (searchRegex) {
    pipeline.push(
      {
        $lookup: {
          from: ProductModel.collection.name,
          localField: "product",
          foreignField: "_id",
          as: "productDocument",
        },
      },
      { $set: { productDocument: { $arrayElemAt: ["$productDocument", 0] } } },
      {
        $match: {
          $or: [
            { "productDocument.name_en": searchRegex },
            { "productDocument.name_ar": searchRegex },
            { "productDocument.slug": searchRegex },
          ],
        },
      },
    );
  }

  pipeline.push(
    {
      $group: {
        _id: { product: "$product", warehouse: "$warehouse" },
        totalSubscribers: { $sum: 1 },
        registeredUserCount: {
          $sum: {
            $cond: [{ $eq: [{ $type: "$user" }, "objectId"] }, 1, 0],
          },
        },
        anonymousGuestCount: {
          $sum: {
            $cond: [{ $eq: [{ $type: "$guestId" }, "string"] }, 1, 0],
          },
        },
        oldestSubscribedAt: { $min: "$createdAt" },
        latestSubscribedAt: { $max: "$createdAt" },
      },
    },
    {
      $lookup: {
        from: ProductModel.collection.name,
        localField: "_id.product",
        foreignField: "_id",
        as: "productDocument",
      },
    },
    { $set: { productDocument: { $arrayElemAt: ["$productDocument", 0] } } },
    {
      $lookup: {
        from: WarehouseModel.collection.name,
        localField: "_id.warehouse",
        foreignField: "_id",
        as: "warehouseDocument",
      },
    },
    { $set: { warehouseDocument: { $arrayElemAt: ["$warehouseDocument", 0] } } },
    // Sort warehouse-level demand before regrouping so warehouseDemand stays
    // deterministic and useful without client-side sorting.
    {
      $sort: {
        totalSubscribers: -1,
        latestSubscribedAt: -1,
        "_id.warehouse": 1,
      },
    },
    // The summary is product-centric. Warehouses are a nested demand breakdown
    // instead of causing the same product to be returned once per warehouse.
    {
      $group: {
        _id: "$_id.product",
        productDocument: { $first: "$productDocument" },
        totalSubscribers: { $sum: "$totalSubscribers" },
        registeredUserCount: { $sum: "$registeredUserCount" },
        anonymousGuestCount: { $sum: "$anonymousGuestCount" },
        oldestSubscribedAt: { $min: "$oldestSubscribedAt" },
        latestSubscribedAt: { $max: "$latestSubscribedAt" },
        warehouseDemand: {
          $push: {
            warehouse: {
              id: "$_id.warehouse",
              name: { $ifNull: ["$warehouseDocument.name", null] },
              code: { $ifNull: ["$warehouseDocument.code", null] },
            },
            totalSubscribers: "$totalSubscribers",
            registeredUserCount: "$registeredUserCount",
            anonymousGuestCount: "$anonymousGuestCount",
            oldestSubscribedAt: "$oldestSubscribedAt",
            latestSubscribedAt: "$latestSubscribedAt",
          },
        },
      },
    },
    {
      $sort: {
        totalSubscribers: -1,
        latestSubscribedAt: -1,
        _id: 1,
      },
    },
    {
      $facet: {
        metadata: [{ $count: "totalDemandGroups" }],
        data: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              product: {
                id: "$_id",
                slug: { $ifNull: ["$productDocument.slug", null] },
                name_en: { $ifNull: ["$productDocument.name_en", null] },
                name_ar: { $ifNull: ["$productDocument.name_ar", null] },
                image: productImageExpression,
              },
              totalSubscribers: 1,
              registeredUserCount: 1,
              anonymousGuestCount: 1,
              oldestSubscribedAt: 1,
              latestSubscribedAt: 1,
              warehouseDemand: 1,
            },
          },
        ],
      },
    },
  );

  return RestockSubscriptionModel.aggregate(pipeline);
}

export function aggregateRestockDemandSubscribers({
  productId,
  warehouseId,
  warehouseScope,
  page,
  limit,
}) {
  return RestockSubscriptionModel.aggregate([
    { $match: pendingDemandMatch({ productId, warehouseId, warehouseScope }) },
    {
      $lookup: {
        from: UserModel.collection.name,
        localField: "user",
        foreignField: "_id",
        as: "userDocument",
      },
    },
    { $set: { userDocument: { $arrayElemAt: ["$userDocument", 0] } } },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              registeredUserCount: {
                $sum: {
                  $cond: [
                    { $eq: [{ $type: "$userDocument._id" }, "objectId"] },
                    1,
                    0,
                  ],
                },
              },
              unavailableRegisteredUserCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: [{ $type: "$user" }, "objectId"] },
                        { $ne: [{ $type: "$userDocument._id" }, "objectId"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              anonymousGuestCount: {
                $sum: {
                  $cond: [{ $eq: [{ $type: "$guestId" }, "string"] }, 1, 0],
                },
              },
            },
          },
        ],
        data: [
          { $match: { "userDocument._id": { $type: "objectId" } } },
          {
            $lookup: {
              from: WarehouseModel.collection.name,
              localField: "warehouse",
              foreignField: "_id",
              as: "warehouseDocument",
            },
          },
          { $set: { warehouseDocument: { $arrayElemAt: ["$warehouseDocument", 0] } } },
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: "$userDocument._id",
              name: "$userDocument.name",
              image: "$userDocument.image.url",
              warehouse: {
                id: "$warehouse",
                name: { $ifNull: ["$warehouseDocument.name", null] },
                code: { $ifNull: ["$warehouseDocument.code", null] },
              },
              subscribedAt: "$createdAt",
              status: 1,
            },
          },
        ],
      },
    },
  ]);
}

const pendingDemandStatuses = [
  restockSubscriptionStatus.ACTIVE,
  restockSubscriptionStatus.PROCESSING,
];

function pendingDemandMatch({ productId, warehouseId, warehouseScope }) {
  const match = { status: { $in: pendingDemandStatuses } };
  if (productId) match.product = productId;
  if (warehouseId) match.warehouse = warehouseId;
  else if (Array.isArray(warehouseScope)) match.warehouse = { $in: warehouseScope };
  return match;
}

const productImageExpression = {
  $let: {
    vars: {
      mainImages: {
        $filter: {
          input: { $ifNull: ["$productDocument.images", []] },
          as: "image",
          cond: { $eq: ["$$image.isMain", true] },
        },
      },
    },
    in: {
      $ifNull: [
        { $arrayElemAt: ["$$mainImages.url", 0] },
        { $arrayElemAt: ["$productDocument.images.url", 0] },
      ],
    },
  },
};
