import { UserModel } from '../user/user.model.js';
import { WarehouseModel } from '../warehouse/warehouse.model.js';
import { SubcategorySubscriptionModel } from './subcategorySubscription.model.js';

export function ownerFilter({ userId, guestId }) {
  const normalizedGuestId =
    typeof guestId === "string" && guestId.trim() ? guestId.trim() : null;
  const hasUser = Boolean(userId);
  const hasGuest = Boolean(normalizedGuestId);

  if (hasUser === hasGuest) {
    throw new Error("Exactly one of userId or guestId is required");
  }

  return hasUser ? { user: userId } : { guestId: normalizedGuestId };
}

export async function createSubscriptionIfMissing({
  userId,
  guestId,
  subcategoryId,
  warehouseId,
}) {
  const owner = ownerFilter({ userId, guestId });
  const filter = { ...owner, subcategory: subcategoryId };
  const update = {
    $setOnInsert: { ...owner, subcategory: subcategoryId },
    // Omitting warehouse keeps an existing demand location for old clients.
    ...(warehouseId != null ? { $set: { warehouse: warehouseId } } : {}),
  };

  try {
    return await SubcategorySubscriptionModel.updateOne(
      filter,
      update,
      { upsert: true },
    );
  } catch (error) {
    // A simultaneous first subscribe can race on the compound unique index.
    // The competing request has already created the same desired state.
    if (error?.code === 11000) {
      return SubcategorySubscriptionModel.updateOne(
        filter,
        update,
        { upsert: false },
      );
    }
    throw error;
  }
}

export function deleteSubscription({ userId, guestId, subcategoryId, warehouseId }) {
  return SubcategorySubscriptionModel.deleteOne({
    ...ownerFilter({ userId, guestId }),
    subcategory: subcategoryId,
    ...(warehouseId != null ? { warehouse: warehouseId } : {}),
  });
}

export function findSubscriptionsForIdentity({ userId, guestId }) {
  return SubcategorySubscriptionModel.find(ownerFilter({ userId, guestId }))
    .select("subcategory")
    .sort({ createdAt: -1 })
    .lean();
}

export function subscriptionExists({ userId, guestId, subcategoryId, warehouseId }) {
  return SubcategorySubscriptionModel.exists({
    ...ownerFilter({ userId, guestId }),
    subcategory: subcategoryId,
    ...(warehouseId != null ? { warehouse: warehouseId } : {}),
  });
}

export function findNotificationSubscriptions(subcategoryId) {
  return SubcategorySubscriptionModel.find({ subcategory: subcategoryId })
    .select("user guestId warehouse")
    .lean();
}

export function findGuestSubscriptions(guestId) {
  return SubcategorySubscriptionModel.find({ guestId: ownerFilter({ guestId }).guestId })
    .select("subcategory")
    .lean();
}

export function findGuestSubscriptionSnapshots(guestId) {
  return SubcategorySubscriptionModel.find({
    guestId: ownerFilter({ guestId }).guestId,
  })
    .select('subcategory warehouse updatedAt')
    .lean();
}

export async function createSubscriptionForMerge({
  userId,
  subcategoryId,
  warehouseId,
}) {
  const owner = ownerFilter({ userId });
  const filter = { ...owner, subcategory: subcategoryId };
  const update = {
    $setOnInsert: {
      ...owner,
      subcategory: subcategoryId,
      ...(warehouseId != null ? { warehouse: warehouseId } : {}),
    },
  };

  try {
    return await SubcategorySubscriptionModel.updateOne(filter, update, {
      upsert: true,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return SubcategorySubscriptionModel.updateOne(filter, update, {
        upsert: false,
      });
    }
    throw error;
  }
}

export function fillSubscriptionWarehouseIfMissing({
  userId,
  subcategoryId,
  warehouseId,
}) {
  if (warehouseId == null) {
    return Promise.resolve({ acknowledged: true, modifiedCount: 0 });
  }

  return SubcategorySubscriptionModel.updateOne(
    {
      ...ownerFilter({ userId }),
      subcategory: subcategoryId,
      // MongoDB matches null against legacy documents with no warehouse field.
      warehouse: null,
    },
    { $set: { warehouse: warehouseId } },
  );
}

export function replaceSubscriptionWarehouseIfMatches({
  userId,
  subcategoryId,
  expectedWarehouseId,
  warehouseId,
}) {
  return SubcategorySubscriptionModel.updateOne(
    {
      ...ownerFilter({ userId }),
      subcategory: subcategoryId,
      warehouse: expectedWarehouseId ?? null,
    },
    { $set: { warehouse: warehouseId ?? null } },
  );
}

export function deleteGuestSubscriptionSnapshot({
  guestId,
  subscriptionId,
  updatedAt,
}) {
  return SubcategorySubscriptionModel.deleteOne({
    guestId: ownerFilter({ guestId }).guestId,
    _id: subscriptionId,
    ...(updatedAt ? { updatedAt } : {}),
  });
}

export function deleteSubscriptionsForGuest(guestId) {
  return SubcategorySubscriptionModel.deleteMany({
    guestId: ownerFilter({ guestId }).guestId,
  });
}

function demandMatch({ warehouseId, warehouseScope }) {
  if (warehouseId != null) return { warehouse: warehouseId };
  if (Array.isArray(warehouseScope)) {
    // An empty moderator scope deliberately excludes legacy null demand too.
    return { warehouse: { $in: warehouseScope } };
  }
  return {};
}

function warehouseProjection() {
  return {
    $cond: [
      { $ne: [{ $ifNull: ['$_id.warehouse', null] }, null] },
      {
        id: { $ifNull: ['$warehouseDocument._id', '$_id.warehouse'] },
        name: { $ifNull: ['$warehouseDocument.name', null] },
        code: { $ifNull: ['$warehouseDocument.code', null] },
      },
      null,
    ],
  };
}

export function aggregateSubcategoryDemandGroups({
  warehouseId,
  warehouseScope,
  searchRegex,
  skip,
  limit,
  nameField,
}) {
  const fallbackNameField = nameField === 'name_ar' ? 'name_en' : 'name_ar';
  const pipeline = [
    { $match: demandMatch({ warehouseId, warehouseScope }) },
    {
      $group: {
        _id: {
          subcategory: '$subcategory',
          warehouse: { $ifNull: ['$warehouse', null] },
        },
        totalSubscribers: { $sum: 1 },
        registeredUserCount: {
          $sum: {
            $cond: [{ $eq: [{ $type: '$user' }, 'objectId'] }, 1, 0],
          },
        },
        anonymousGuestCount: {
          $sum: {
            $cond: [{ $eq: [{ $type: '$guestId' }, 'string'] }, 1, 0],
          },
        },
        oldestSubscribedAt: { $min: '$createdAt' },
        latestSubscribedAt: { $max: '$createdAt' },
      },
    },
    {
      $lookup: {
        from: 'subcategories',
        localField: '_id.subcategory',
        foreignField: '_id',
        as: 'subcategoryDocument',
      },
    },
    {
      $unwind: {
        path: '$subcategoryDocument',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: 'warehouses',
        localField: '_id.warehouse',
        foreignField: '_id',
        as: 'warehouseDocument',
      },
    },
    {
      $unwind: {
        path: '$warehouseDocument',
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  if (searchRegex) {
    pipeline.push({
      $match: {
        $or: [
          { 'subcategoryDocument.name_en': searchRegex },
          { 'subcategoryDocument.name_ar': searchRegex },
          { 'subcategoryDocument.slug': searchRegex },
        ],
      },
    });
  }

  pipeline.push(
    {
      $sort: {
        totalSubscribers: -1,
        latestSubscribedAt: -1,
        '_id.warehouse': 1,
      },
    },
    // One top-level record represents one subcategory. Warehouse-level demand
    // is retained as a nested breakdown in the sorted order above.
    {
      $group: {
        _id: '$_id.subcategory',
        subcategoryDocument: { $first: '$subcategoryDocument' },
        totalSubscribers: { $sum: '$totalSubscribers' },
        registeredUserCount: { $sum: '$registeredUserCount' },
        anonymousGuestCount: { $sum: '$anonymousGuestCount' },
        oldestSubscribedAt: { $min: '$oldestSubscribedAt' },
        latestSubscribedAt: { $max: '$latestSubscribedAt' },
        warehouseDemand: {
          $push: {
            warehouse: warehouseProjection(),
            totalSubscribers: '$totalSubscribers',
            registeredUserCount: '$registeredUserCount',
            anonymousGuestCount: '$anonymousGuestCount',
            oldestSubscribedAt: '$oldestSubscribedAt',
            latestSubscribedAt: '$latestSubscribedAt',
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
        metadata: [{ $count: 'totalDemandGroups' }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              subcategory: {
                id: '$_id',
                slug: { $ifNull: ['$subcategoryDocument.slug', null] },
                name: {
                  $ifNull: [
                    `$subcategoryDocument.${nameField}`,
                    {
                      $ifNull: [
                        `$subcategoryDocument.${fallbackNameField}`,
                        null,
                      ],
                    },
                  ],
                },
                image: { $ifNull: ['$subcategoryDocument.image.url', null] },
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

  return SubcategorySubscriptionModel.aggregate(pipeline);
}

export function aggregateSubcategoryDemandSubscribers({
  subcategoryId,
  warehouseId,
  warehouseScope,
  page,
  limit,
}) {
  return SubcategorySubscriptionModel.aggregate([
    {
      $match: {
        subcategory: subcategoryId,
        ...demandMatch({ warehouseId, warehouseScope }),
      },
    },
    {
      $lookup: {
        from: UserModel.collection.name,
        localField: 'user',
        foreignField: '_id',
        as: 'userDocument',
      },
    },
    { $set: { userDocument: { $arrayElemAt: ['$userDocument', 0] } } },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              registeredUserCount: {
                $sum: {
                  $cond: [
                    { $eq: [{ $type: '$userDocument._id' }, 'objectId'] },
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
                        { $eq: [{ $type: '$user' }, 'objectId'] },
                        {
                          $ne: [
                            { $type: '$userDocument._id' },
                            'objectId',
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              anonymousGuestCount: {
                $sum: {
                  $cond: [
                    { $eq: [{ $type: '$guestId' }, 'string'] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        data: [
          { $match: { 'userDocument._id': { $type: 'objectId' } } },
          {
            $lookup: {
              from: WarehouseModel.collection.name,
              localField: 'warehouse',
              foreignField: '_id',
              as: 'warehouseDocument',
            },
          },
          {
            $set: {
              warehouseDocument: {
                $arrayElemAt: ['$warehouseDocument', 0],
              },
            },
          },
          { $sort: { createdAt: -1, _id: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: '$userDocument._id',
              name: '$userDocument.name',
              image: '$userDocument.image.url',
              warehouse: {
                $cond: [
                  { $ne: [{ $ifNull: ['$warehouse', null] }, null] },
                  {
                    id: '$warehouse',
                    name: { $ifNull: ['$warehouseDocument.name', null] },
                    code: { $ifNull: ['$warehouseDocument.code', null] },
                  },
                  null,
                ],
              },
              subscribedAt: '$createdAt',
            },
          },
        ],
      },
    },
  ]);
}

export function deleteSubscriptionsForSubcategory(subcategoryId) {
  return SubcategorySubscriptionModel.deleteMany({ subcategory: subcategoryId });
}
