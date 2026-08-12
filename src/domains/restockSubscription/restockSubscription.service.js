import crypto from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { productTypeEnum } from "../../shared/constants/enums.js";
import { ProductModel } from "../product/product.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { restockNotificationGateway } from "./restockSubscription.notificationGateway.js";
import {
  activateSubscription,
  aggregateRestockDemandSubscribers,
  aggregateRestockDemandSummary,
  cancelSubscription,
  claimActiveSubscription,
  deleteSubscriptionsForProduct,
  deleteSubscriptionsForGuest,
  findActiveSubscriptions,
  findActiveSubscriptionsForUser,
  findPendingGuestSubscriptions,
  findPendingSubscriptionsForIdentity,
  findSubscription,
  markSubscriptionNotified,
  recoverStaleProcessingClaims,
  releaseSubscriptionClaim,
} from "./restockSubscription.repository.js";

const PROCESSING_CLAIM_TTL_MS = 15 * 60 * 1000;

function demandObjectId(value, field) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(`${field} must be a valid MongoDB ObjectId`, 400);
  }
  return new mongoose.Types.ObjectId(String(value));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function demandPagination({ page = 1, limit = 20 } = {}) {
  const normalizedPage = Number(page);
  const normalizedLimit = Number(limit);
  if (!Number.isInteger(normalizedPage) || normalizedPage < 1) {
    throw new ApiError("page must be a positive integer", 400);
  }
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
    throw new ApiError("limit must be an integer between 1 and 100", 400);
  }
  return { page: normalizedPage, limit: normalizedLimit };
}

function ensureWarehouseIsAllowed({ warehouseId, warehouseScope }) {
  if (
    warehouseId &&
    Array.isArray(warehouseScope) &&
    !warehouseScope.some((allowedWarehouseId) => String(allowedWarehouseId) === String(warehouseId))
  ) {
    throw new ApiError("You are not allowed to access this warehouse", 403);
  }
}

function localizedDemandSummary(row, lang) {
  const registeredUserCount = Number(row.registeredUserCount) || 0;
  const anonymousGuestCount = Number(row.anonymousGuestCount) || 0;
  const warehouseDemand = (row.warehouseDemand || []).map((entry) => {
    const warehouseRegisteredUserCount = Number(entry.registeredUserCount) || 0;
    const warehouseAnonymousGuestCount = Number(entry.anonymousGuestCount) || 0;

    return {
      warehouse: {
        id: String(entry.warehouse.id),
        name: entry.warehouse.name || null,
        code: entry.warehouse.code || null,
      },
      totalSubscribers:
        warehouseRegisteredUserCount + warehouseAnonymousGuestCount,
      registeredUserCount: warehouseRegisteredUserCount,
      anonymousGuestCount: warehouseAnonymousGuestCount,
      oldestSubscribedAt: entry.oldestSubscribedAt,
      latestSubscribedAt: entry.latestSubscribedAt,
    };
  });

  return {
    product: {
      id: String(row.product.id),
      slug: row.product.slug || null,
      name:
        lang === "ar"
          ? row.product.name_ar || row.product.name_en
          : row.product.name_en || row.product.name_ar,
      image: row.product.image || null,
    },
    totalSubscribers: registeredUserCount + anonymousGuestCount,
    registeredUserCount,
    anonymousGuestCount,
    oldestSubscribedAt: row.oldestSubscribedAt,
    latestSubscribedAt: row.latestSubscribedAt,
    warehouseDemand,
  };
}

function warehouseIdMatches(value, warehouseId) {
  return value != null && String(value) === String(warehouseId);
}

function getSubscriptionIdentity({ userId, guestId } = {}) {
  if (userId) return { userId, guestId: undefined };

  const normalizedGuestId =
    typeof guestId === "string" ? guestId.trim() : "";
  if (normalizedGuestId) return { userId: undefined, guestId: normalizedGuestId };

  throw new ApiError("Either userId or guestId must be provided", 400);
}

function quantityAtWarehouse(warehouseStocks, warehouseId) {
  return (Array.isArray(warehouseStocks) ? warehouseStocks : []).reduce(
    (total, entry) =>
      warehouseIdMatches(entry?.warehouse, warehouseId)
        ? total + Math.max(0, Number(entry?.quantity) || 0)
        : total,
    0
  );
}

/** Product-level stock. Variants deliberately sum every variant for this warehouse. */
export function getProductStockAtWarehouse(product, warehouseId) {
  if (!product) return 0;
  if (product.type === productTypeEnum.VARIANT) {
    return (Array.isArray(product.variants) ? product.variants : []).reduce(
      (total, variant) => total + quantityAtWarehouse(variant?.warehouseStocks, warehouseId),
      0
    );
  }
  return quantityAtWarehouse(product.warehouseStocks, warehouseId);
}

function toSubscriptionResponse(subscription) {
  return {
    subscribed: subscription?.status === "ACTIVE" || subscription?.status === "PROCESSING",
    status: subscription?.status || null,
    productId: subscription?.product ? String(subscription.product) : null,
    warehouseId: subscription?.warehouse ? String(subscription.warehouse) : null,
  };
}

function didDispatchCompletelyFail(result) {
  if (!result || typeof result !== "object") return true;

  const inAppSucceeded = result.inApp?.success === true;
  const pushSucceeded =
    result.push?.success === true || (result.push?.successCount || 0) > 0;

  return !inAppSucceeded && !pushSucceeded;
}

function notificationPayload({ product, warehouseId }) {
  const productId = String(product._id);
  return {
    notification: {
      title_en: "Back in stock",
      title_ar: "متوفر الآن",
      body_en: `${product.name_en} is back in stock.`,
      body_ar: `${product.name_ar} متوفر الآن.`,
    },
    icon: "product",
    action: {
      type: "product_detail",
      screen: "ProductDetailScreen",
      params: { productId, warehouseId: String(warehouseId) },
    },
    source: {
      domain: "product",
      event: "restocked",
      referenceId: productId,
    },
  };
}

async function getValidOutOfStockProductAndWarehouse({ productId, warehouseId }) {
  const [product, warehouse] = await Promise.all([
    ProductModel.findById(productId),
    WarehouseModel.findById(warehouseId),
  ]);

  if (!product || product.isActive === false) {
    throw new ApiError("Product not found", 404);
  }
  if (!warehouse) {
    throw new ApiError("Warehouse not found", 404);
  }
  if (getProductStockAtWarehouse(product, warehouseId) > 0) {
    throw new ApiError("Product is already in stock in this warehouse", 409);
  }
  return product;
}

export async function subscribeToRestockService({
  userId,
  guestId,
  productId,
  warehouseId,
}) {
  const identity = getSubscriptionIdentity({ userId, guestId });
  await getValidOutOfStockProductAndWarehouse({ productId, warehouseId });
  const subscription = await activateSubscription({
    ...identity,
    productId,
    warehouseId,
  });

  // Close the gap where a stock write commits after the validation above.
  await processRestockSubscriptionsForProduct({ productId, warehouseIds: [warehouseId] });

  // Return the committed current state in case the post-upsert recheck consumed it.
  const currentSubscription = await findSubscription({
    ...identity,
    productId,
    warehouseId,
  });
  return toSubscriptionResponse(currentSubscription || subscription);
}

export async function unsubscribeFromRestockService({
  userId,
  guestId,
  productId,
  warehouseId,
}) {
  const identity = getSubscriptionIdentity({ userId, guestId });
  const subscription = await cancelSubscription({
    ...identity,
    productId,
    warehouseId,
  });
  return {
    subscribed: false,
    productId: String(productId),
    warehouseId: String(warehouseId),
    status: subscription?.status || "CANCELLED",
  };
}

export async function getRestockSubscriptionStatusService({
  userId,
  guestId,
  productId,
  warehouseId,
}) {
  const identity = getSubscriptionIdentity({ userId, guestId });
  const subscription = await findSubscription({
    ...identity,
    productId,
    warehouseId,
  });
  return subscription
    ? toSubscriptionResponse(subscription)
    : {
        subscribed: false,
        status: null,
        productId: String(productId),
        warehouseId: String(warehouseId),
      };
}

export async function getMyRestockSubscriptionsService({
  userId,
  guestId,
} = {}) {
  const identity = getSubscriptionIdentity({ userId, guestId });
  const subscriptions = await findPendingSubscriptionsForIdentity(identity);
  return subscriptions.map(toSubscriptionResponse);
}

export async function getRestockDemandSummaryService({
  warehouseId,
  search,
  page,
  limit,
  warehouseScope,
  lang,
} = {}) {
  const pagination = demandPagination({ page, limit });
  const normalizedWarehouseId = warehouseId
    ? demandObjectId(warehouseId, "warehouse")
    : undefined;
  ensureWarehouseIsAllowed({
    warehouseId: normalizedWarehouseId,
    warehouseScope,
  });

  const normalizedSearch = typeof search === "string" ? search.trim() : "";
  const [result = {}] = await aggregateRestockDemandSummary({
    warehouseId: normalizedWarehouseId,
    warehouseScope,
    searchRegex: normalizedSearch ? new RegExp(escapeRegex(normalizedSearch), "i") : undefined,
    ...pagination,
  });
  const totalDemandGroups = result.metadata?.[0]?.totalDemandGroups || 0;
  const data = (result.data || []).map((row) => localizedDemandSummary(row, lang));

  return {
    totalPages: Math.ceil(totalDemandGroups / pagination.limit) || 1,
    page: pagination.page,
    results: data.length,
    totalDemandGroups,
    data,
  };
}

export async function getRestockDemandSubscribersService({
  productId,
  warehouseId,
  page,
  limit,
  warehouseScope,
} = {}) {
  const pagination = demandPagination({ page, limit });
  const normalizedProductId = demandObjectId(productId, "productId");
  const normalizedWarehouseId = warehouseId
    ? demandObjectId(warehouseId, "warehouse")
    : undefined;
  ensureWarehouseIsAllowed({
    warehouseId: normalizedWarehouseId,
    warehouseScope,
  });

  const [result = {}] = await aggregateRestockDemandSubscribers({
    productId: normalizedProductId,
    warehouseId: normalizedWarehouseId,
    warehouseScope,
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
    warehouse: {
      id: String(row.warehouse.id),
      name: row.warehouse.name || null,
      code: row.warehouse.code || null,
    },
    subscribedAt: row.subscribedAt,
    status: row.status,
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

export async function getRestockSubscribedProductIdsForUser({
  userId,
  guestId,
  productIds,
  warehouseId,
}) {
  if (!warehouseId || !Array.isArray(productIds) || !productIds.length) {
    return new Set();
  }

  const identity = getSubscriptionIdentity({ userId, guestId });

  const subscriptions = await findActiveSubscriptionsForUser({
    ...identity,
    productIds,
    warehouseId,
  });
  return new Set(subscriptions.map((subscription) => String(subscription.product)));
}

/**
 * Call only after a stock write has committed. Claims prevent duplicate sends when
 * overlapping stock updates process the same product/warehouse at once.
 */
export async function processRestockSubscriptionsForProduct({ productId, warehouseIds } = {}) {
  if (!productId) return { claimed: 0, notified: 0, retried: 0 };

  const scopedWarehouseIds = Array.isArray(warehouseIds)
    ? [...new Set(warehouseIds.filter(Boolean).map(String))]
    : undefined;
  const now = new Date();

  await recoverStaleProcessingClaims({
    productId,
    warehouseIds: scopedWarehouseIds,
    before: new Date(now.getTime() - PROCESSING_CLAIM_TTL_MS),
  });

  const product = await ProductModel.findById(productId);
  if (!product || product.isActive === false) {
    return { claimed: 0, notified: 0, retried: 0 };
  }

  const activeSubscriptions = await findActiveSubscriptions({
    productId,
    warehouseIds: scopedWarehouseIds,
  });
  const summary = { claimed: 0, notified: 0, retried: 0 };

  for (const subscription of activeSubscriptions) {
    if (getProductStockAtWarehouse(product, subscription.warehouse) <= 0) continue;

    const claimToken = crypto.randomUUID();
    const claim = await claimActiveSubscription({
      subscriptionId: subscription._id,
      claimToken,
      claimedAt: now,
    });
    if (!claim) continue;
    summary.claimed += 1;

    try {
      const payload = notificationPayload({
        product,
        warehouseId: claim.warehouse,
      });
      const result = claim.user
        ? await restockNotificationGateway.dispatch({
            ...payload,
            userId: claim.user,
            channels: { push: true, inApp: true },
          })
        : await restockNotificationGateway.dispatchToGuests({
            ...payload,
            guestIds: [claim.guestId],
          });

      if (didDispatchCompletelyFail(result)) {
        await releaseSubscriptionClaim({ subscriptionId: claim._id, claimToken });
        summary.retried += 1;
      } else {
        await markSubscriptionNotified({
          subscriptionId: claim._id,
          claimToken,
          notifiedAt: new Date(),
        });
        summary.notified += 1;
      }
    } catch (error) {
      await releaseSubscriptionClaim({ subscriptionId: claim._id, claimToken });
      summary.retried += 1;
    }
  }

  return summary;
}

export function cleanupRestockSubscriptionsForProduct(productId) {
  return deleteSubscriptionsForProduct(productId);
}

/**
 * Move a guest's pending subscriptions to their account after login.
 * Re-activating each user row resolves existing user conflicts and also turns
 * a guest PROCESSING claim back into a safe ACTIVE user subscription.
 */
export async function mergeGuestRestockSubscriptions({ userId, guestId }) {
  if (!userId) throw new ApiError("userId is required for merge", 400);

  const identity = getSubscriptionIdentity({ guestId });
  const pendingSubscriptions = await findPendingGuestSubscriptions(identity.guestId);
  const productWarehousePairs = new Map();

  let mergedCount = 0;
  for (const subscription of pendingSubscriptions) {
    await activateSubscription({
      userId,
      productId: subscription.product,
      warehouseId: subscription.warehouse,
    });
    productWarehousePairs.set(
      `${String(subscription.product)}:${String(subscription.warehouse)}`,
      {
        productId: subscription.product,
        warehouseId: subscription.warehouse,
      }
    );
    mergedCount += 1;
  }

  const deletion = await deleteSubscriptionsForGuest(identity.guestId);

  // Stock may have returned while the guest was logging in. Process only after
  // the guest rows are removed, so the transferred user subscription is the
  // single eligible recipient. Failures remain retryable through the normal
  // stock-processing path and do not make the merge/deletion unsafe.
  await Promise.all(
    [...productWarehousePairs.values()].map(({ productId, warehouseId }) =>
      processRestockSubscriptionsForProduct({
        productId,
        warehouseIds: [warehouseId],
      }).catch((error) =>
        console.error(
          "[RestockSubscription] Failed to process a merged subscription:",
          error?.message || error
        )
      )
    )
  );

  return {
    mergedCount,
    removedCount: deletion?.deletedCount || 0,
  };
}
