import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { DateTime } from "luxon";

import { ProductModel } from "../../src/domains/product/product.model.js";
import { SubcategoryModel } from "../../src/domains/subcategory/subcategory.model.js";
import { SubcategorySubscriptionModel } from "../../src/domains/subcategorySubscription/subcategorySubscription.model.js";
import {
  SubcategoryProductDigestModel,
  subcategoryProductDigestStatus,
} from "../../src/domains/subcategorySubscription/subcategoryProductDigest.model.js";
import { subcategorySubscriptionNotificationDispatcher } from "../../src/domains/subcategorySubscription/subcategorySubscription.notificationDispatcher.js";
import {
  SUBCATEGORY_DIGEST_TIME_ZONE,
  buildSubcategoryDigestNotification,
  getNextSubcategoryDigestDeliveryAt,
  groupSubcategoryDigestRecipients,
  processDueSubcategoryProductDigests,
  queueProductForSubcategoryDigest,
} from "../../src/domains/subcategorySubscription/subcategoryProductDigest.service.js";

function queryResult(value) {
  return {
    select() {
      return this;
    },
    lean: async () => value,
  };
}

test("digest scheduling uses the next 8 PM Cairo window", () => {
  const beforeCutoff = new Date("2026-08-05T15:00:00.000Z");
  const afterCutoff = new Date("2026-08-05T18:00:00.000Z");

  const firstDelivery = DateTime.fromJSDate(
    getNextSubcategoryDigestDeliveryAt(beforeCutoff),
  ).setZone(SUBCATEGORY_DIGEST_TIME_ZONE);
  const secondDelivery = DateTime.fromJSDate(
    getNextSubcategoryDigestDeliveryAt(afterCutoff),
  ).setZone(SUBCATEGORY_DIGEST_TIME_ZONE);

  assert.equal(firstDelivery.hour, 20);
  assert.equal(firstDelivery.toISODate(), "2026-08-05");
  assert.equal(secondDelivery.hour, 20);
  assert.equal(secondDelivery.toISODate(), "2026-08-06");
});

test("daily digest notification content is exact for singular and plural counts", () => {
  const base = {
    digestId: "digest-id",
    subcategoryId: "subcategory-id",
    subcategoryNameEn: "Cat Food",
    subcategoryNameAr: "طعام القطط",
  };

  assert.deepEqual(buildSubcategoryDigestNotification({ ...base, productCount: 1 }), {
    notification: {
      title_en: "New product in Cat Food",
      title_ar: "منتج جديد في طعام القطط",
      body_en: "1 new product was added to Cat Food today.",
      body_ar: "تمت إضافة منتج جديد إلى طعام القطط اليوم.",
    },
    icon: "product",
    action: {
      type: "subcategory_products",
      screen: "ProductListScreen",
      params: { subcategoryId: "subcategory-id" },
    },
    source: {
      domain: "product",
      event: "new_products_in_subcategory_digest",
      referenceId: "digest-id",
    },
  });

  const plural = buildSubcategoryDigestNotification({
    ...base,
    productCount: 3,
  });
  assert.deepEqual(plural.notification, {
    title_en: "New products in Cat Food",
    title_ar: "منتجات جديدة في طعام القطط",
    body_en: "3 new products were added to Cat Food today.",
    body_ar: "تمت إضافة 3 منتجات جديدة إلى طعام القطط اليوم.",
  });
});

test("multiple product creates share one subcategory delivery window", async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const digestId = new mongoose.Types.ObjectId();
  let digest = null;

  t.mock.method(
    SubcategoryProductDigestModel,
    "findOneAndUpdate",
    (filter, update) => ({
      lean: async () => {
        if (!digest) {
          digest = {
            _id: digestId,
            subcategory: filter.subcategory,
            scheduledFor: filter.scheduledFor,
            productIds: [],
            status: subcategoryProductDigestStatus.PENDING,
          };
        }
        const productId = update.$addToSet.productIds;
        if (!digest.productIds.some((id) => String(id) === String(productId))) {
          digest.productIds.push(productId);
        }
        return { ...digest };
      },
    }),
  );

  const now = new Date("2026-08-05T15:00:00.000Z");
  const productIds = [
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
  ];
  for (const productId of productIds) {
    const result = await queueProductForSubcategoryDigest({
      product: {
        _id: productId,
        subcategory: subcategoryId,
        isActive: true,
      },
      now,
    });
    assert.equal(result.queued, true);
  }

  assert.equal(digest.productIds.length, 3);
  assert.equal(
    new Set(digest.productIds.map(String)).size,
    3,
  );
  assert.deepEqual(
    await queueProductForSubcategoryDigest({
      product: {
        _id: new mongoose.Types.ObjectId(),
        subcategory: subcategoryId,
        isActive: false,
      },
      now,
    }),
    { queued: false },
  );
});

function installDigestDispatchMocks(t, { dispatchFails = false } = {}) {
  const digest = {
    _id: new mongoose.Types.ObjectId(),
    subcategory: new mongoose.Types.ObjectId(),
    scheduledFor: new Date("2026-08-05T17:00:00.000Z"),
    productIds: [
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
      new mongoose.Types.ObjectId(),
    ],
    status: subcategoryProductDigestStatus.PENDING,
    attempts: 0,
  };
  const userId = new mongoose.Types.ObjectId();
  const guestId = "digest-guest";
  const userDispatches = [];
  const guestDispatches = [];

  t.mock.method(SubcategoryProductDigestModel, "updateMany", async () => ({
    modifiedCount: 0,
  }));
  t.mock.method(
    SubcategoryProductDigestModel,
    "findOneAndUpdate",
    (filter, update) => ({
      lean: async () => {
        if (digest.status !== filter.status) return null;
        if (digest.scheduledFor > filter.scheduledFor.$lte) return null;
        if (
          filter._id?.$nin?.some((digestId) =>
            String(digestId) === String(digest._id)
          )
        ) {
          return null;
        }

        Object.assign(digest, update.$set || {});
        digest.attempts += update.$inc?.attempts || 0;
        return { ...digest };
      },
    }),
  );
  t.mock.method(
    SubcategoryProductDigestModel,
    "updateOne",
    async (filter, update) => {
      if (
        String(filter._id) !== String(digest._id) ||
        filter.claimToken !== digest.claimToken
      ) {
        return { modifiedCount: 0 };
      }
      Object.assign(digest, update.$set || {});
      return { modifiedCount: 1 };
    },
  );
  t.mock.method(SubcategoryModel, "findById", () =>
    queryResult({
      _id: digest.subcategory,
      name_en: "Cat Food",
      name_ar: "طعام القطط",
    }),
  );
  t.mock.method(ProductModel, "find", () =>
    queryResult(digest.productIds.map((_id) => ({ _id }))),
  );
  t.mock.method(SubcategorySubscriptionModel, "find", () =>
    queryResult([
      { user: userId },
      { user: userId },
      { guestId },
      { guestId },
    ]),
  );
  t.mock.method(
    subcategorySubscriptionNotificationDispatcher,
    "dispatchNotificationToUsers",
    async (payload) => {
      userDispatches.push(payload);
      if (dispatchFails) throw new Error("dispatch failed");
      return { inApp: { insertedCount: 1 }, push: { successCount: 1 } };
    },
  );
  t.mock.method(
    subcategorySubscriptionNotificationDispatcher,
    "dispatchNotificationToGuests",
    async (payload) => {
      guestDispatches.push(payload);
      return { push: { successCount: 1 } };
    },
  );

  return { digest, userId, guestId, userDispatches, guestDispatches };
}

test("one due digest fans out one aggregated notification per identity", async (t) => {
  const state = installDigestDispatchMocks(t);
  const now = new Date("2026-08-05T17:05:00.000Z");

  assert.deepEqual(await processDueSubcategoryProductDigests({ now }), {
    claimed: 1,
    sent: 1,
    failed: 0,
    products: 3,
    users: 1,
    guests: 1,
  });
  assert.equal(state.digest.status, subcategoryProductDigestStatus.SENT);
  assert.equal(state.userDispatches.length, 1);
  assert.equal(state.guestDispatches.length, 1);
  assert.deepEqual(state.userDispatches[0], {
    userIds: [String(state.userId)],
    notification: {
      title_en: "New products in Cat Food",
      title_ar: "منتجات جديدة في طعام القطط",
      body_en: "3 new products were added to Cat Food today.",
      body_ar: "تمت إضافة 3 منتجات جديدة إلى طعام القطط اليوم.",
    },
    icon: "product",
    action: {
      type: "subcategory_products",
      screen: "ProductListScreen",
      params: { subcategoryId: String(state.digest.subcategory) },
    },
    source: {
      domain: "product",
      event: "new_products_in_subcategory_digest",
      referenceId: String(state.digest._id),
    },
    channels: { push: true, inApp: true },
  });
  assert.equal(state.guestDispatches[0].guestIds[0], state.guestId);

  assert.deepEqual(await processDueSubcategoryProductDigests({ now }), {
    claimed: 0,
    sent: 0,
    failed: 0,
    products: 0,
    users: 0,
    guests: 0,
  });
});

test("a failed digest is released once for a later cron retry", async (t) => {
  const state = installDigestDispatchMocks(t, { dispatchFails: true });

  assert.deepEqual(
    await processDueSubcategoryProductDigests({
      now: new Date("2026-08-05T17:05:00.000Z"),
      limit: 10,
    }),
    {
      claimed: 1,
      sent: 0,
      failed: 1,
      products: 0,
      users: 0,
      guests: 0,
    },
  );
  assert.equal(state.userDispatches.length, 1);
  assert.equal(state.digest.attempts, 1);
  assert.equal(state.digest.status, subcategoryProductDigestStatus.PENDING);
});

test("digest recipients require local stock for selected warehouses", () => {
  const warehouseA = new mongoose.Types.ObjectId();
  const warehouseB = new mongoose.Types.ObjectId();
  const warehouseWithoutStock = new mongoose.Types.ObjectId();
  const legacyUserId = new mongoose.Types.ObjectId();
  const simpleUserId = new mongoose.Types.ObjectId();
  const variantUserId = new mongoose.Types.ObjectId();
  const unavailableUserId = new mongoose.Types.ObjectId();

  const groups = groupSubcategoryDigestRecipients({
    products: [
      {
        _id: new mongoose.Types.ObjectId(),
        type: "SIMPLE",
        warehouseStocks: [{ warehouse: warehouseA, quantity: 2 }],
      },
      {
        _id: new mongoose.Types.ObjectId(),
        type: "VARIANT",
        variants: [
          {
            warehouseStocks: [{ warehouse: warehouseB, quantity: 1 }],
          },
        ],
      },
      {
        _id: new mongoose.Types.ObjectId(),
        type: "SIMPLE",
        warehouseStocks: [{ warehouse: warehouseWithoutStock, quantity: 0 }],
      },
    ],
    subscriptions: [
      { user: legacyUserId },
      { user: simpleUserId, warehouse: warehouseA },
      { user: variantUserId, warehouse: warehouseB },
      { user: unavailableUserId, warehouse: warehouseWithoutStock },
      { guestId: "eligible-guest", warehouse: warehouseB },
      { guestId: "unavailable-guest", warehouse: warehouseWithoutStock },
    ],
  });

  assert.deepEqual(groups, [
    {
      warehouseId: null,
      productCount: 3,
      userIds: [String(legacyUserId)],
      guestIds: [],
    },
    {
      warehouseId: String(warehouseA),
      productCount: 1,
      userIds: [String(simpleUserId)],
      guestIds: [],
    },
    {
      warehouseId: String(warehouseB),
      productCount: 1,
      userIds: [String(variantUserId)],
      guestIds: ["eligible-guest"],
    },
  ]);
});

test("digest model enforces one aggregate per subcategory delivery window", () => {
  const indexes = SubcategoryProductDigestModel.schema.indexes();
  const uniqueWindow = indexes.find(
    ([fields]) => fields.subcategory === 1 && fields.scheduledFor === 1,
  );
  assert.equal(uniqueWindow[1].unique, true);
});
