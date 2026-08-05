import { RestockSubscriptionModel, restockSubscriptionStatus } from "./restockSubscription.model.js";

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
