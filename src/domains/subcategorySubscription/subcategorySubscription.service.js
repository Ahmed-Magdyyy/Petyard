import mongoose from 'mongoose';
import { WarehouseModel } from '../warehouse/warehouse.model.js';
import { SubcategoryModel } from '../subcategory/subcategory.model.js';
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  aggregateSubcategoryDemandGroups,
  aggregateSubcategoryDemandSubscribers,
  createSubscriptionForMerge,
  createSubscriptionIfMissing,
  deleteGuestSubscriptionSnapshot,
  deleteSubscription,
  deleteSubscriptionsForSubcategory,
  fillSubscriptionWarehouseIfMissing,
  findGuestSubscriptionSnapshots,
  findSubscriptionsForIdentity,
  replaceSubscriptionWarehouseIfMatches,
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

async function ensureWarehouseExists(warehouseId) {
  if (warehouseId == null) return;

  const exists = await WarehouseModel.exists({ _id: warehouseId });
  if (!exists) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 404);
  }
}

function toObjectId(value, fieldName) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new ApiError(`${fieldName} must be a valid MongoDB ObjectId`, 400);
  }
  return new mongoose.Types.ObjectId(value);
}

function normalizePagination({ page, limit }) {
  const parsedPage = Number.parseInt(page, 10);
  const parsedLimit = Number.parseInt(limit, 10);

  return {
    page: Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    limit:
      Number.isSafeInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 100)
        : 20,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWarehouseScope({ warehouseId, warehouseScope }) {
  const normalizedWarehouseId =
    warehouseId == null ? null : toObjectId(warehouseId, 'warehouse');

  if (!Array.isArray(warehouseScope)) {
    return { warehouseId: normalizedWarehouseId, warehouseScope: null };
  }

  const normalizedScope = warehouseScope.map((id) =>
    toObjectId(id, 'warehouse scope'),
  );

  if (
    normalizedWarehouseId &&
    !normalizedScope.some(
      (allowedWarehouseId) =>
        String(allowedWarehouseId) === String(normalizedWarehouseId),
    )
  ) {
    throw new ApiError('You are not allowed to access this warehouse', 403);
  }

  return {
    warehouseId: normalizedWarehouseId,
    warehouseScope: normalizedWarehouseId ? null : normalizedScope,
  };
}

export async function subscribeToSubcategory({
  userId,
  guestId,
  subcategoryId,
  warehouseId,
}) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  await ensureSubcategoryExists(subcategoryId);
  await ensureWarehouseExists(warehouseId);
  await createSubscriptionIfMissing({ ...identity, subcategoryId, warehouseId });

  return { subcategoryId: asId(subcategoryId), subscribed: true };
}

export async function unsubscribeFromSubcategory({
  userId,
  guestId,
  subcategoryId,
  warehouseId,
}) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  await deleteSubscription({ ...identity, subcategoryId, warehouseId });

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
  warehouseId,
}) {
  const identity = getSubcategorySubscriptionIdentity({ userId, guestId });
  return Boolean(
    await subscriptionExists({ ...identity, subcategoryId, warehouseId }),
  );
}

export async function cleanupSubscriptionsForSubcategory(subcategoryId) {
  const [result] = await Promise.all([
    deleteSubscriptionsForSubcategory(subcategoryId),
    deleteDigestsForSubcategory(subcategoryId),
  ]);
  return result?.deletedCount || 0;
}

const GUEST_MERGE_MAX_ATTEMPTS = 3;

async function transferGuestSubscriptionSnapshot({
  userId,
  guestId,
  initialSnapshot,
}) {
  let snapshot = initialSnapshot;
  const subcategoryId = asId(snapshot.subcategory);
  const createResult = await createSubscriptionForMerge({
    userId,
    subcategoryId,
    warehouseId: snapshot.warehouse,
  });
  const fillResult = await fillSubscriptionWarehouseIfMissing({
    userId,
    subcategoryId,
    warehouseId: snapshot.warehouse,
  });
  let mergeOwnsWarehouse =
    Number(createResult?.upsertedCount) > 0 ||
    Number(fillResult?.modifiedCount) > 0;
  let copiedWarehouseId = snapshot.warehouse ?? null;

  for (let attempt = 0; attempt < GUEST_MERGE_MAX_ATTEMPTS; attempt += 1) {
    const deletion = await deleteGuestSubscriptionSnapshot({
      guestId,
      subscriptionId: snapshot._id,
      updatedAt: snapshot.updatedAt,
    });
    if (deletion?.deletedCount > 0) return true;

    const refreshedSnapshots = await findGuestSubscriptionSnapshots(guestId);
    const refreshed = refreshedSnapshots.find(
      (candidate) => String(candidate._id) === String(snapshot._id),
    );
    if (!refreshed) return true;

    const refreshedWarehouseId = refreshed.warehouse ?? null;
    if (
      mergeOwnsWarehouse &&
      String(refreshedWarehouseId ?? '') !== String(copiedWarehouseId ?? '')
    ) {
      const replacement = await replaceSubscriptionWarehouseIfMatches({
        userId,
        subcategoryId,
        expectedWarehouseId: copiedWarehouseId,
        warehouseId: refreshedWarehouseId,
      });
      mergeOwnsWarehouse = Number(replacement?.modifiedCount) > 0;
      if (mergeOwnsWarehouse) copiedWarehouseId = refreshedWarehouseId;
    }
    snapshot = refreshed;
  }

  return false;
}

// Called after guest authentication by the auth domain. Each guest snapshot is
// deleted conditionally only after its latest metadata was preserved for the
// user. A bounded retry closes the concurrent guest-update race without ever
// deleting a row whose location was not copied.
export async function mergeGuestSubcategorySubscriptions({ userId, guestId }) {
  const userIdentity = getSubcategorySubscriptionIdentity({ userId });
  const guestIdentity = getSubcategorySubscriptionIdentity({ guestId });
  const guestSubscriptions = await findGuestSubscriptionSnapshots(
    guestIdentity.guestId,
  );

  const uniqueGuestSubscriptions = new Map();
  for (const subscription of guestSubscriptions) {
    const subcategoryId = asId(subscription.subcategory);
    if (subcategoryId) uniqueGuestSubscriptions.set(subcategoryId, subscription);
  }

  let mergedCount = 0;
  for (const subscription of uniqueGuestSubscriptions.values()) {
    const merged = await transferGuestSubscriptionSnapshot({
      userId: userIdentity.userId,
      guestId: guestIdentity.guestId,
      initialSnapshot: subscription,
    });
    if (merged) mergedCount += 1;
  }

  return { mergedCount };
}

// This aggregate-only report is safe to expose to authorized staff because it
// never returns a guest ID or an individual subscriber identity.
export async function getAdminSubcategoryDemand({
  warehouseId,
  warehouseScope,
  search,
  page,
  limit,
  lang,
}) {
  const pagination = normalizePagination({ page, limit });
  const scope = normalizeWarehouseScope({ warehouseId, warehouseScope });
  const normalizedSearch = typeof search === 'string' ? search.trim() : '';
  const result = await aggregateSubcategoryDemandGroups({
    ...scope,
    searchRegex: normalizedSearch
      ? new RegExp(escapeRegex(normalizedSearch), 'i')
      : null,
    skip: (pagination.page - 1) * pagination.limit,
    limit: pagination.limit,
    nameField: lang === 'ar' ? 'name_ar' : 'name_en',
  });
  const facet = result[0] || {};
  const totalDemandGroups = facet.metadata?.[0]?.totalDemandGroups || 0;
  const data = facet.data || [];

  return {
    totalPages: Math.ceil(totalDemandGroups / pagination.limit) || 1,
    page: pagination.page,
    results: data.length,
    totalDemandGroups,
    data,
  };
}

export async function getAdminSubcategoryDemandSubscribers({
  subcategoryId,
  warehouseId,
  warehouseScope,
  page,
  limit,
}) {
  const pagination = normalizePagination({ page, limit });
  const normalizedSubcategoryId = toObjectId(
    subcategoryId,
    'subcategoryId',
  );
  const scope = normalizeWarehouseScope({ warehouseId, warehouseScope });
  const [result = {}] = await aggregateSubcategoryDemandSubscribers({
    subcategoryId: normalizedSubcategoryId,
    ...scope,
    ...pagination,
  });
  const counts = result.counts?.[0] || {};
  const registeredUserCount = Number(counts.registeredUserCount) || 0;
  const unavailableRegisteredUserCount =
    Number(counts.unavailableRegisteredUserCount) || 0;
  const anonymousGuestCount = Number(counts.anonymousGuestCount) || 0;
  const data = (result.data || []).map((row) => ({
    id: String(row.id),
    name: row.name || null,
    image: row.image || null,
    warehouse: row.warehouse
      ? {
          id: String(row.warehouse.id),
          name: row.warehouse.name || null,
          code: row.warehouse.code || null,
        }
      : null,
    subscribedAt: row.subscribedAt,
  }));

  return {
    totalPages: Math.ceil(registeredUserCount / pagination.limit) || 1,
    page: pagination.page,
    results: data.length,
    totalSubscribers:
      registeredUserCount +
      unavailableRegisteredUserCount +
      anonymousGuestCount,
    registeredUserCount,
    unavailableRegisteredUserCount,
    anonymousGuestCount,
    data,
  };
}
