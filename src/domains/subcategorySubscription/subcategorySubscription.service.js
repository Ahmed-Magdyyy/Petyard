import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  createSubscriptionIfMissing,
  deleteSubscription,
  deleteSubscriptionsForSubcategory,
  deleteSubscriptionsForGuest,
  findGuestSubscriptions,
  findSubscriptionsForIdentity,
  subscriptionExists,
} from "./subcategorySubscription.repository.js";
import { deleteDigestsForSubcategory } from "./subcategoryProductDigest.repository.js";

function asId(value) {
  return value == null ? null : String(value);
}

// One subscription identity is always either the authenticated user or the
// x-guest-id supplied by the Flutter client. Keeping this in the domain makes
// every operation use the same ownership rule.
export function getSubcategorySubscriptionIdentity({ userId, guestId } = {}) {
  const normalizedGuestId =
    typeof guestId === "string" && guestId.trim() ? guestId.trim() : null;
  const hasUser = Boolean(userId);
  const hasGuest = Boolean(normalizedGuestId);

  if (hasUser === hasGuest) {
    throw new ApiError("Exactly one of userId or guestId is required", 400);
  }

  return hasUser ? { userId } : { guestId: normalizedGuestId };
}

async function ensureSubcategoryExists(subcategoryId) {
  const exists = await SubcategoryModel.exists({ _id: subcategoryId });
  if (!exists) {
    throw new ApiError(`No subcategory found for this id: ${subcategoryId}`, 404);
  }
}

export async function subscribeToSubcategory({ userId, guestId, subcategoryId }) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  await ensureSubcategoryExists(subcategoryId);
  await createSubscriptionIfMissing({ ...identity, subcategoryId });

  return { subcategoryId: asId(subcategoryId), subscribed: true };
}

export async function unsubscribeFromSubcategory({ userId, guestId, subcategoryId }) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  await deleteSubscription({ ...identity, subcategoryId });

  return { subcategoryId: asId(subcategoryId), subscribed: false };
}

export async function getSubscribedSubcategoryIdsForIdentity({ userId, guestId }) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  const subscriptions = await findSubscriptionsForIdentity(identity);
  return subscriptions
    .map((subscription) => asId(subscription.subcategory))
    .filter(Boolean);
}

// Existing product/subcategory callers use this function. Keep it as a
// compatibility wrapper while allowing the shared implementation to support
// guest identities too.
export async function getSubscribedSubcategoryIdsForUser(userId) {
  return getSubscribedSubcategoryIdsForIdentity({ userId });
}

export async function isUserSubscribedToSubcategory({
  userId,
  guestId,
  subcategoryId,
}) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  return Boolean(await subscriptionExists({ ...identity, subcategoryId }));
}

export async function cleanupSubscriptionsForSubcategory(subcategoryId) {
  const [result] = await Promise.all([
    deleteSubscriptionsForSubcategory(subcategoryId),
    deleteDigestsForSubcategory(subcategoryId),
  ]);
  return result?.deletedCount || 0;
}

// Called after guest authentication by the auth domain. User-side upserts are
// idempotent, so duplicate subcategory rows are harmless; guest rows are only
// removed after every subscription has been preserved for the user.
export async function mergeGuestSubcategorySubscriptions({ userId, guestId }) {
  const userIdentity = getSubcategorySubscriptionIdentity({ userId });
  const guestIdentity = getSubcategorySubscriptionIdentity({ guestId });
  const guestSubscriptions = await findGuestSubscriptions(guestIdentity.guestId);

  const subcategoryIds = [
    ...new Set(
      guestSubscriptions
        .map((subscription) => asId(subscription.subcategory))
        .filter(Boolean),
    ),
  ];

  for (const subcategoryId of subcategoryIds) {
    await createSubscriptionIfMissing({
      ...userIdentity,
      subcategoryId,
    });
  }

  await deleteSubscriptionsForGuest(guestIdentity.guestId);
  return { mergedCount: subcategoryIds.length };
}
