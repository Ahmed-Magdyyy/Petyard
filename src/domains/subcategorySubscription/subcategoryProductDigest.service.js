import crypto from "node:crypto";
import { DateTime } from "luxon";

import { productTypeEnum } from "../../shared/constants/enums.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import { ProductModel } from "../product/product.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { findNotificationSubscriptions } from "./subcategorySubscription.repository.js";
import { subcategorySubscriptionNotificationDispatcher } from "./subcategorySubscription.notificationDispatcher.js";
import {
  claimNextDueDigest,
  markDigestSent,
  queueDigestProduct,
  recoverStaleDigestClaims,
  releaseDigestClaim,
} from "./subcategoryProductDigest.repository.js";

export const SUBCATEGORY_DIGEST_TIME_ZONE = "Africa/Cairo";
export const SUBCATEGORY_DIGEST_HOUR_CAIRO = parseBoundedInt(
  process.env.SUBCATEGORY_DIGEST_HOUR_CAIRO,
  20,
  0,
  23,
);

const DIGEST_PROCESSING_LIMIT = parseBoundedInt(
  process.env.SUBCATEGORY_DIGEST_PROCESSING_LIMIT,
  100,
  1,
  1000,
);
const DIGEST_CLAIM_TTL_MINUTES = parseBoundedInt(
  process.env.SUBCATEGORY_DIGEST_CLAIM_TTL_MINUTES,
  30,
  5,
  24 * 60,
);

function asId(value) {
  return value == null ? null : String(value);
}

function warehouseIdMatches(value, warehouseId) {
  return value != null && String(value) === String(warehouseId);
}

function hasPositiveStockAtWarehouse(warehouseStocks, warehouseId) {
  return (Array.isArray(warehouseStocks) ? warehouseStocks : []).some(
    (entry) =>
      warehouseIdMatches(entry?.warehouse, warehouseId) &&
      Number(entry?.quantity) > 0,
  );
}

function isProductAvailableAtWarehouse(product, warehouseId) {
  if (product?.type === productTypeEnum.VARIANT) {
    return (Array.isArray(product.variants) ? product.variants : []).some(
      (variant) =>
        hasPositiveStockAtWarehouse(variant?.warehouseStocks, warehouseId),
    );
  }

  return hasPositiveStockAtWarehouse(product?.warehouseStocks, warehouseId);
}

/**
 * A selected warehouse is eligible only when at least one newly-added product
 * is in stock there. Subscriptions without a selected warehouse keep the
 * existing category-wide delivery behavior.
 */
export function groupSubcategoryDigestRecipients({ subscriptions, products }) {
  const groups = new Map();
  const availableProducts = Array.isArray(products) ? products : [];

  for (const subscription of subscriptions || []) {
    const warehouseId = asId(subscription?.warehouse);
    const eligibleProducts = warehouseId
      ? availableProducts.filter((product) =>
          isProductAvailableAtWarehouse(product, warehouseId),
        )
      : availableProducts;

    if (!eligibleProducts.length) continue;

    const groupKey = warehouseId || "legacy";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        warehouseId,
        productCount: eligibleProducts.length,
        userIds: new Set(),
        guestIds: new Set(),
      };
      groups.set(groupKey, group);
    }

    const userId = asId(subscription?.user);
    if (userId) {
      group.userIds.add(userId);
      continue;
    }

    const guestId =
      typeof subscription?.guestId === "string"
        ? subscription.guestId.trim()
        : "";
    if (guestId) group.guestIds.add(guestId);
  }

  return [...groups.values()].map((group) => ({
    warehouseId: group.warehouseId,
    productCount: group.productCount,
    userIds: [...group.userIds],
    guestIds: [...group.guestIds],
  }));
}

export function getNextSubcategoryDigestDeliveryAt(now = new Date()) {
  const localNow = DateTime.fromJSDate(new Date(now), { zone: "utc" }).setZone(
    SUBCATEGORY_DIGEST_TIME_ZONE,
  );
  if (!localNow.isValid) throw new Error("Invalid digest scheduling date");

  let delivery = localNow.startOf("day").set({
    hour: SUBCATEGORY_DIGEST_HOUR_CAIRO,
  });
  if (localNow >= delivery) delivery = delivery.plus({ days: 1 });

  return delivery.toUTC().toJSDate();
}

export async function queueProductForSubcategoryDigest({ product, now } = {}) {
  if (!product || product.isActive === false || !product.subcategory) {
    return { queued: false };
  }

  const productId = asId(product._id);
  const subcategoryId = asId(product.subcategory?._id || product.subcategory);
  if (!productId || !subcategoryId) return { queued: false };

  const scheduledFor = getNextSubcategoryDigestDeliveryAt(now || new Date());
  const digest = await queueDigestProduct({
    subcategoryId,
    productId,
    scheduledFor,
  });

  return {
    queued: true,
    digestId: asId(digest?._id),
    subcategoryId,
    scheduledFor,
  };
}

export function buildSubcategoryDigestNotification({
  digestId,
  subcategoryId,
  subcategoryNameEn,
  subcategoryNameAr,
  productCount,
}) {
  const count = Math.max(1, Number(productCount) || 1);
  const englishName = subcategoryNameEn || subcategoryNameAr || "this category";
  const arabicName = subcategoryNameAr || subcategoryNameEn || "هذا القسم";
  const singular = count === 1;

  return {
    notification: {
      title_en: singular
        ? `New product in ${englishName}`
        : `New products in ${englishName}`,
      title_ar: singular
        ? `منتج جديد في ${arabicName}`
        : `منتجات جديدة في ${arabicName}`,
      body_en: singular
        ? `1 new product was added to ${englishName} today.`
        : `${count} new products were added to ${englishName} today.`,
      body_ar: singular
        ? `تمت إضافة منتج جديد إلى ${arabicName} اليوم.`
        : `تمت إضافة ${count} منتجات جديدة إلى ${arabicName} اليوم.`,
    },
    icon: "product",
    action: {
      type: "subcategory_products",
      screen: "ProductListScreen",
      params: { subcategoryId: String(subcategoryId) },
    },
    source: {
      domain: "product",
      event: "new_products_in_subcategory_digest",
      referenceId: String(digestId),
    },
  };
}

async function dispatchClaimedDigest(digest) {
  const subcategoryId = asId(digest.subcategory);
  const [subcategory, products, subscriptions] = await Promise.all([
      SubcategoryModel.findById(subcategoryId)
        .select("_id name_en name_ar")
        .lean(),
      ProductModel.find({
        _id: { $in: digest.productIds || [] },
        subcategory: subcategoryId,
        isActive: { $ne: false },
      })
        .select(
          "_id type warehouseStocks.warehouse warehouseStocks.quantity variants.warehouseStocks.warehouse variants.warehouseStocks.quantity",
        )
        .lean(),
      findNotificationSubscriptions(subcategoryId),
    ]);

  if (!subcategory || products.length === 0) {
    return { skipped: true, productCount: 0, userCount: 0, guestCount: 0 };
  }

  const recipientGroups = groupSubcategoryDigestRecipients({
    subscriptions,
    products,
  });
  const dispatches = [];
  for (const recipientGroup of recipientGroups) {
    const payload = buildSubcategoryDigestNotification({
      digestId: digest._id,
      subcategoryId,
      subcategoryNameEn: subcategory.name_en,
      subcategoryNameAr: subcategory.name_ar,
      productCount: recipientGroup.productCount,
    });

    if (recipientGroup.userIds.length) {
      dispatches.push(
        subcategorySubscriptionNotificationDispatcher.dispatchNotificationToUsers({
          ...payload,
          userIds: recipientGroup.userIds,
          channels: { push: true, inApp: true },
        }),
      );
    }
    if (recipientGroup.guestIds.length) {
      const { icon: _icon, ...guestPayload } = payload;
      dispatches.push(
        subcategorySubscriptionNotificationDispatcher.dispatchNotificationToGuests({
          ...guestPayload,
          guestIds: recipientGroup.guestIds,
        }),
      );
    }
  }

  await Promise.all(dispatches);
  const userCount = recipientGroups.reduce(
    (total, group) => total + group.userIds.length,
    0,
  );
  const guestCount = recipientGroups.reduce(
    (total, group) => total + group.guestIds.length,
    0,
  );
  return {
    skipped: userCount === 0 && guestCount === 0,
    productCount: products.length,
    userCount,
    guestCount,
  };
}

export async function processDueSubcategoryProductDigests({
  now = new Date(),
  limit = DIGEST_PROCESSING_LIMIT,
} = {}) {
  const processingTime = new Date(now);
  await recoverStaleDigestClaims({
    before: new Date(
      processingTime.getTime() - DIGEST_CLAIM_TTL_MINUTES * 60 * 1000,
    ),
  });

  const summary = {
    claimed: 0,
    sent: 0,
    failed: 0,
    products: 0,
    users: 0,
    guests: 0,
  };
  const attemptedDigestIds = [];

  for (let index = 0; index < limit; index += 1) {
    const claimToken = crypto.randomUUID();
    const digest = await claimNextDueDigest({
      now: processingTime,
      claimToken,
      excludeDigestIds: attemptedDigestIds,
    });
    if (!digest) break;
    attemptedDigestIds.push(digest._id);
    summary.claimed += 1;

    try {
      const result = await dispatchClaimedDigest(digest);
      await markDigestSent({
        digestId: digest._id,
        claimToken,
        sentAt: new Date(),
      });
      summary.sent += 1;
      summary.products += result.productCount;
      summary.users += result.userCount;
      summary.guests += result.guestCount;
    } catch (error) {
      await releaseDigestClaim({
        digestId: digest._id,
        claimToken,
        error,
      });
      summary.failed += 1;
    }
  }

  return summary;
}
