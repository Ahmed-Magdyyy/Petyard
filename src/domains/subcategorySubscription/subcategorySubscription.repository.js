import { SubcategorySubscriptionModel } from "./subcategorySubscription.model.js";

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

export async function createSubscriptionIfMissing({ userId, guestId, subcategoryId }) {
  const owner = ownerFilter({ userId, guestId });
  const filter = { ...owner, subcategory: subcategoryId };

  try {
    return await SubcategorySubscriptionModel.updateOne(
      filter,
      { $setOnInsert: { ...owner, subcategory: subcategoryId } },
      { upsert: true },
    );
  } catch (error) {
    // A simultaneous first subscribe can race on the compound unique index.
    // The competing request has already created the same desired state.
    if (error?.code === 11000) {
      return SubcategorySubscriptionModel.updateOne(
        filter,
        { $setOnInsert: { ...owner, subcategory: subcategoryId } },
        { upsert: false },
      );
    }
    throw error;
  }
}

export function deleteSubscription({ userId, guestId, subcategoryId }) {
  return SubcategorySubscriptionModel.deleteOne({
    ...ownerFilter({ userId, guestId }),
    subcategory: subcategoryId,
  });
}

export function findSubscriptionsForIdentity({ userId, guestId }) {
  return SubcategorySubscriptionModel.find(ownerFilter({ userId, guestId }))
    .select("subcategory")
    .sort({ createdAt: -1 })
    .lean();
}

export function subscriptionExists({ userId, guestId, subcategoryId }) {
  return SubcategorySubscriptionModel.exists({
    ...ownerFilter({ userId, guestId }),
    subcategory: subcategoryId,
  });
}

export function findSubscribedUserIds(subcategoryId) {
  return SubcategorySubscriptionModel.distinct("user", {
    subcategory: subcategoryId,
    user: { $type: "objectId" },
  });
}

export function findSubscribedGuestIds(subcategoryId) {
  return SubcategorySubscriptionModel.distinct("guestId", {
    subcategory: subcategoryId,
    guestId: { $type: "string" },
  });
}

export function findGuestSubscriptions(guestId) {
  return SubcategorySubscriptionModel.find({ guestId: ownerFilter({ guestId }).guestId })
    .select("subcategory")
    .lean();
}

export function deleteSubscriptionsForGuest(guestId) {
  return SubcategorySubscriptionModel.deleteMany({
    guestId: ownerFilter({ guestId }).guestId,
  });
}

export function deleteSubscriptionsForSubcategory(subcategoryId) {
  return SubcategorySubscriptionModel.deleteMany({ subcategory: subcategoryId });
}
