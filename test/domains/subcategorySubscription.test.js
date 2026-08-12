import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validationResult } from "express-validator";

import { SubcategoryModel } from "../../src/domains/subcategory/subcategory.model.js";
import { SubcategorySubscriptionModel } from "../../src/domains/subcategorySubscription/subcategorySubscription.model.js";
import { SubcategoryProductDigestModel } from "../../src/domains/subcategorySubscription/subcategoryProductDigest.model.js";
import {
  cleanupSubscriptionsForSubcategory,
  getSubscribedSubcategoryIdsForIdentity,
  getSubscribedSubcategoryIdsForUser,
  isUserSubscribedToSubcategory,
  mergeGuestSubcategorySubscriptions,
  subscribeToSubcategory,
  unsubscribeFromSubcategory,
} from "../../src/domains/subcategorySubscription/subcategorySubscription.service.js";
import subcategorySubscriptionRoutes from "../../src/domains/subcategorySubscription/subcategorySubscription.routes.js";
import { subcategoryIdParamValidator } from '../../src/domains/subcategorySubscription/subcategorySubscription.validators.js';

function createMemorySubscriptionStorage(t, subcategories = new Map()) {
  const subscriptions = new Map();
  const ownerKey = (owner) =>
    owner.user ? `user:${String(owner.user)}` : `guest:${String(owner.guestId).trim()}`;
  const keyFor = (owner, subcategory) => `${ownerKey(owner)}:${String(subcategory)}`;
  const matches = (subscription, filter = {}) => {
    if (filter.subcategory && String(subscription.subcategory) !== String(filter.subcategory)) {
      return false;
    }
    if (filter.user) {
      if (filter.user.$type && !subscription.user) return false;
      if (!filter.user.$type && String(subscription.user) !== String(filter.user)) return false;
    }
    if (filter.guestId) {
      if (filter.guestId.$type && !subscription.guestId) return false;
      if (
        !filter.guestId.$type &&
        String(subscription.guestId) !== String(filter.guestId).trim()
      ) return false;
    }
    if (Object.hasOwn(filter, 'warehouse')) {
      if (filter.warehouse == null && subscription.warehouse != null) return false;
      if (
        filter.warehouse != null &&
        String(subscription.warehouse) !== String(filter.warehouse)
      ) return false;
    }
    if (filter._id && String(subscription._id) !== String(filter._id)) return false;
    if (filter.updatedAt && subscription.updatedAt?.getTime() !== filter.updatedAt.getTime()) return false;
    return true;
  };

  t.mock.method(SubcategoryModel, "exists", async ({ _id }) =>
    subcategories.has(String(_id)) ? { _id } : null,
  );
  t.mock.method(SubcategoryModel, "findById", (id) => ({
    select() {
      return this;
    },
    lean: async () => subcategories.get(String(id)) || null,
  }));

  t.mock.method(SubcategorySubscriptionModel, 'updateOne', async (filter, update) => {
    const owner = filter.user ? { user: filter.user } : { guestId: filter.guestId };
    const key = keyFor(owner, filter.subcategory);
    const alreadyExists = subscriptions.has(key);
    if (!alreadyExists) {
      subscriptions.set(key, {
        ...update.$setOnInsert,
        ...update.$set,
        _id: new mongoose.Types.ObjectId(),
        subcategory: filter.subcategory,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } else if (matches(subscriptions.get(key), filter) && update.$set) {
      Object.assign(subscriptions.get(key), update.$set, { updatedAt: new Date() });
    }
    return { acknowledged: true, upsertedCount: alreadyExists ? 0 : 1 };
  });
  t.mock.method(SubcategorySubscriptionModel, 'deleteOne', async (filter) => {
    const entry = [...subscriptions.entries()].find(([, subscription]) =>
      matches(subscription, filter),
    );
    return {
      acknowledged: true,
      deletedCount: entry && subscriptions.delete(entry[0]) ? 1 : 0,
    };
  });
  t.mock.method(SubcategorySubscriptionModel, "find", (filter) => ({
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => [...subscriptions.values()].filter((subscription) => matches(subscription, filter)),
  }));
  t.mock.method(SubcategorySubscriptionModel, "exists", async (filter) =>
    [...subscriptions.values()].find((subscription) => matches(subscription, filter)) || null,
  );
  t.mock.method(SubcategorySubscriptionModel, "distinct", async (field, filter) =>
    [...subscriptions.values()]
      .filter((subscription) => matches(subscription, filter))
      .map((subscription) => subscription[field]),
  );
  t.mock.method(SubcategorySubscriptionModel, "deleteMany", async (filter) => {
    let deletedCount = 0;
    for (const [key, subscription] of subscriptions) {
      if (matches(subscription, filter)) {
        subscriptions.delete(key);
        deletedCount += 1;
      }
    }
    return { acknowledged: true, deletedCount };
  });
  t.mock.method(SubcategoryProductDigestModel, "deleteMany", async () => ({
    acknowledged: true,
    deletedCount: 0,
  }));

  return subscriptions;
}

test("subscribe and unsubscribe are idempotent and isolated per user", async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const subcategories = new Map([[String(subcategoryId), { _id: subcategoryId, name_en: "Cat food", name_ar: "طعام القطط" }]]);
  createMemorySubscriptionStorage(t, subcategories);
  const firstUser = new mongoose.Types.ObjectId();
  const secondUser = new mongoose.Types.ObjectId();

  assert.deepEqual(
    await subscribeToSubcategory({ userId: firstUser, subcategoryId }),
    { subcategoryId: String(subcategoryId), subscribed: true },
  );
  await subscribeToSubcategory({ userId: firstUser, subcategoryId });
  await subscribeToSubcategory({ userId: secondUser, subcategoryId });

  assert.deepEqual(await getSubscribedSubcategoryIdsForUser(firstUser), [String(subcategoryId)]);
  assert.equal(
    await isUserSubscribedToSubcategory({ userId: firstUser, subcategoryId }),
    true,
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ userId: secondUser, subcategoryId }),
    true,
  );

  assert.deepEqual(
    await unsubscribeFromSubcategory({ userId: firstUser, subcategoryId }),
    { subcategoryId: String(subcategoryId), subscribed: false },
  );
  await unsubscribeFromSubcategory({ userId: firstUser, subcategoryId });
  assert.equal(
    await isUserSubscribedToSubcategory({ userId: firstUser, subcategoryId }),
    false,
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ userId: secondUser, subcategoryId }),
    true,
  );
});

test("guests can subscribe, check status, list, and unsubscribe in isolation", async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const subcategories = new Map([[String(subcategoryId), { _id: subcategoryId }]]);
  createMemorySubscriptionStorage(t, subcategories);
  const firstGuestId = "guest-device-one";
  const secondGuestId = "guest-device-two";

  assert.deepEqual(
    await subscribeToSubcategory({ guestId: firstGuestId, subcategoryId }),
    { subcategoryId: String(subcategoryId), subscribed: true },
  );
  await subscribeToSubcategory({ guestId: firstGuestId, subcategoryId });
  await subscribeToSubcategory({ guestId: secondGuestId, subcategoryId });

  assert.deepEqual(
    await getSubscribedSubcategoryIdsForIdentity({ guestId: firstGuestId }),
    [String(subcategoryId)],
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId: firstGuestId, subcategoryId }),
    true,
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId: "another-guest", subcategoryId }),
    false,
  );

  assert.deepEqual(
    await unsubscribeFromSubcategory({ guestId: firstGuestId, subcategoryId }),
    { subcategoryId: String(subcategoryId), subscribed: false },
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId: firstGuestId, subcategoryId }),
    false,
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId: secondGuestId, subcategoryId }),
    true,
  );
});

test("user and guest identities never share a subscription", async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const subcategories = new Map([[String(subcategoryId), { _id: subcategoryId }]]);
  createMemorySubscriptionStorage(t, subcategories);
  const userId = new mongoose.Types.ObjectId();
  const guestId = "same-device";

  await subscribeToSubcategory({ userId, subcategoryId });
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId, subcategoryId }),
    false,
  );
  await subscribeToSubcategory({ guestId, subcategoryId });
  assert.equal(
    await isUserSubscribedToSubcategory({ userId, subcategoryId }),
    true,
  );
  assert.equal(
    await isUserSubscribedToSubcategory({ guestId, subcategoryId }),
    true,
  );
});

test("subscription requires an existing subcategory", async (t) => {
  createMemorySubscriptionStorage(t);

  await assert.rejects(
    () => subscribeToSubcategory({
      userId: new mongoose.Types.ObjectId(),
      subcategoryId: new mongoose.Types.ObjectId(),
    }),
    { statusCode: 404 },
  );
});

test("merging guest subscriptions keeps user subscriptions and removes the guest rows", async (t) => {
  const firstSubcategoryId = new mongoose.Types.ObjectId();
  const secondSubcategoryId = new mongoose.Types.ObjectId();
  const subcategories = new Map([
    [String(firstSubcategoryId), { _id: firstSubcategoryId }],
    [String(secondSubcategoryId), { _id: secondSubcategoryId }],
  ]);
  createMemorySubscriptionStorage(t, subcategories);
  const userId = new mongoose.Types.ObjectId();
  const guestId = "merge-guest";

  await subscribeToSubcategory({ userId, subcategoryId: firstSubcategoryId });
  await subscribeToSubcategory({ guestId, subcategoryId: firstSubcategoryId });
  await subscribeToSubcategory({ guestId, subcategoryId: secondSubcategoryId });

  assert.deepEqual(
    await mergeGuestSubcategorySubscriptions({ userId, guestId }),
    { mergedCount: 2 },
  );
  assert.deepEqual(
    new Set(await getSubscribedSubcategoryIdsForUser(userId)),
    new Set([String(firstSubcategoryId), String(secondSubcategoryId)]),
  );
  assert.deepEqual(
    await getSubscribedSubcategoryIdsForIdentity({ guestId }),
    [],
  );
  assert.deepEqual(
    await mergeGuestSubcategorySubscriptions({ userId, guestId }),
    { mergedCount: 0 },
  );
});

test("cleanup deletes only subscriptions for the removed subcategory", async (t) => {
  const firstSubcategoryId = new mongoose.Types.ObjectId();
  const secondSubcategoryId = new mongoose.Types.ObjectId();
  const subcategories = new Map([
    [String(firstSubcategoryId), { _id: firstSubcategoryId }],
    [String(secondSubcategoryId), { _id: secondSubcategoryId }],
  ]);
  createMemorySubscriptionStorage(t, subcategories);
  const firstUser = new mongoose.Types.ObjectId();
  const secondUser = new mongoose.Types.ObjectId();
  await subscribeToSubcategory({ userId: firstUser, subcategoryId: firstSubcategoryId });
  await subscribeToSubcategory({ userId: secondUser, subcategoryId: firstSubcategoryId });
  await subscribeToSubcategory({ userId: firstUser, subcategoryId: secondSubcategoryId });

  assert.equal(await cleanupSubscriptionsForSubcategory(firstSubcategoryId), 2);
  assert.deepEqual(await getSubscribedSubcategoryIdsForUser(firstUser), [String(secondSubcategoryId)]);
  assert.deepEqual(await getSubscribedSubcategoryIdsForUser(secondUser), []);
});

test("routes reserve /me before the parameter route and validate Mongo IDs", async () => {
  const meIndex = subcategorySubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/me",
  );
  const parameterIndex = subcategorySubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/:subcategoryId",
  );
  assert.ok(meIndex >= 0 && meIndex < parameterIndex);

  const request = { params: { subcategoryId: "not-an-id" } };
  for (const validator of subcategoryIdParamValidator.slice(0, -1)) {
    await validator.run(request);
  }
  assert.equal(
    validationResult(request).array()[0].msg,
    "subcategoryId must be a valid MongoDB ObjectId",
  );
});
