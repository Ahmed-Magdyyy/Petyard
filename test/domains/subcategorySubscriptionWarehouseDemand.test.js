import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { validationResult } from 'express-validator';

import { SubcategoryModel } from '../../src/domains/subcategory/subcategory.model.js';
import { WarehouseModel } from '../../src/domains/warehouse/warehouse.model.js';
import { SubcategorySubscriptionModel } from '../../src/domains/subcategorySubscription/subcategorySubscription.model.js';
import {
  getAdminSubcategoryDemand,
  getAdminSubcategoryDemandSubscribers,
  isUserSubscribedToSubcategory,
  mergeGuestSubcategorySubscriptions,
  subscribeToSubcategory,
  unsubscribeFromSubcategory,
} from '../../src/domains/subcategorySubscription/subcategorySubscription.service.js';
import {
  warehouseIdBodyValidator,
  warehouseQueryValidator,
} from '../../src/domains/subcategorySubscription/subcategorySubscription.validators.js';
import subcategorySubscriptionRoutes from '../../src/domains/subcategorySubscription/subcategorySubscription.routes.js';

function setupCustomerStorage(t, { subcategoryId, warehouseIds }) {
  const records = new Map();
  const keyFor = (filter) =>
    `${filter.user ? `user:${filter.user}` : `guest:${filter.guestId}`}:${filter.subcategory}`;
  const matches = (record, filter) => {
    if (String(record.subcategory) !== String(filter.subcategory)) return false;
    if (filter.user && String(record.user) !== String(filter.user)) return false;
    if (filter.guestId && record.guestId !== filter.guestId) return false;
    if (filter.warehouse != null && String(record.warehouse) !== String(filter.warehouse)) {
      return false;
    }
    return true;
  };

  t.mock.method(SubcategoryModel, 'exists', async ({ _id }) =>
    String(_id) === String(subcategoryId) ? { _id } : null,
  );
  t.mock.method(WarehouseModel, 'exists', async ({ _id }) =>
    warehouseIds.some((id) => String(id) === String(_id)) ? { _id } : null,
  );
  t.mock.method(SubcategorySubscriptionModel, 'updateOne', async (filter, update) => {
    const key = keyFor(filter);
    const current = records.get(key);
    if (current) {
      if (update.$set) Object.assign(current, update.$set);
      return { upsertedCount: 0 };
    }
    records.set(key, {
      ...update.$setOnInsert,
      ...update.$set,
      subcategory: filter.subcategory,
    });
    return { upsertedCount: 1 };
  });
  t.mock.method(SubcategorySubscriptionModel, 'exists', async (filter) =>
    [...records.values()].find((record) => matches(record, filter)) || null,
  );
  t.mock.method(SubcategorySubscriptionModel, 'deleteOne', async (filter) => {
    const entry = [...records.entries()].find(([, record]) => matches(record, filter));
    return { deletedCount: entry && records.delete(entry[0]) ? 1 : 0 };
  });

  return records;
}

test('warehouse-aware customer subscriptions preserve legacy status and delete semantics', async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const firstWarehouseId = new mongoose.Types.ObjectId();
  const secondWarehouseId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const records = setupCustomerStorage(t, {
    subcategoryId,
    warehouseIds: [firstWarehouseId, secondWarehouseId],
  });

  await subscribeToSubcategory({ userId, subcategoryId, warehouseId: firstWarehouseId });
  await subscribeToSubcategory({ userId, subcategoryId });
  await subscribeToSubcategory({ userId, subcategoryId, warehouseId: secondWarehouseId });

  const record = [...records.values()][0];
  assert.equal(String(record.warehouse), String(secondWarehouseId));
  assert.equal(await isUserSubscribedToSubcategory({ userId, subcategoryId }), true);
  assert.equal(
    await isUserSubscribedToSubcategory({
      userId,
      subcategoryId,
      warehouseId: firstWarehouseId,
    }),
    false,
  );
  await unsubscribeFromSubcategory({
    userId,
    subcategoryId,
    warehouseId: firstWarehouseId,
  });
  assert.equal(await isUserSubscribedToSubcategory({ userId, subcategoryId }), true);
  await unsubscribeFromSubcategory({ userId, subcategoryId });
  assert.equal(await isUserSubscribedToSubcategory({ userId, subcategoryId }), false);
  await assert.rejects(
    () => subscribeToSubcategory({
      userId,
      subcategoryId,
      warehouseId: new mongoose.Types.ObjectId(),
    }),
    (error) => error.statusCode === 404,
  );
});

test('optional warehouse validators reject malformed body and query values', async () => {
  const bodyRequest = { body: { warehouseId: 'not-an-id' } };
  for (const validator of warehouseIdBodyValidator.slice(0, -1)) {
    await validator.run(bodyRequest);
  }
  assert.equal(
    validationResult(bodyRequest).array()[0].msg,
    'warehouseId must be a valid MongoDB ObjectId',
  );

  const queryRequest = { query: { warehouse: 'not-an-id' } };
  for (const validator of warehouseQueryValidator.slice(0, -1)) {
    await validator.run(queryRequest);
  }
  assert.equal(
    validationResult(queryRequest).array()[0].msg,
    'warehouse must be a valid MongoDB ObjectId',
  );
});

test('guest merge preserves a user warehouse and conditionally deletes the snapshot', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const subcategoryId = new mongoose.Types.ObjectId();
  const guestWarehouseId = new mongoose.Types.ObjectId();
  const userWarehouseId = new mongoose.Types.ObjectId();
  const snapshot = {
    _id: new mongoose.Types.ObjectId(),
    subcategory: subcategoryId,
    warehouse: guestWarehouseId,
    updatedAt: new Date('2026-08-11T10:00:00.000Z'),
  };
  const userRecord = { user: userId, subcategory: subcategoryId, warehouse: userWarehouseId };
  let deletedFilter;

  t.mock.method(SubcategorySubscriptionModel, 'find', () => ({
    select() {
      return this;
    },
    lean: async () => [snapshot],
  }));
  t.mock.method(SubcategorySubscriptionModel, 'updateOne', async (filter, update) => {
    if (String(filter.user) !== String(userId)) return { modifiedCount: 0 };
    if (update.$set && userRecord.warehouse == null) {
      userRecord.warehouse = update.$set.warehouse;
    }
    return { modifiedCount: 0, upsertedCount: 0 };
  });
  t.mock.method(SubcategorySubscriptionModel, 'deleteOne', async (filter) => {
    deletedFilter = filter;
    return { deletedCount: 1 };
  });

  assert.deepEqual(
    await mergeGuestSubcategorySubscriptions({ userId, guestId: 'guest-merge' }),
    { mergedCount: 1 },
  );
  assert.equal(String(userRecord.warehouse), String(userWarehouseId));
  assert.equal(String(deletedFilter._id), String(snapshot._id));
  assert.equal(deletedFilter.updatedAt.getTime(), snapshot.updatedAt.getTime());
  assert.equal(deletedFilter.guestId, 'guest-merge');
});

test('guest merge retries a concurrent warehouse update without copying stale demand', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const subcategoryId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId();
  const firstWarehouseId = new mongoose.Types.ObjectId();
  const latestWarehouseId = new mongoose.Types.ObjectId();
  const initialSnapshot = {
    _id: subscriptionId,
    subcategory: subcategoryId,
    warehouse: firstWarehouseId,
    updatedAt: new Date('2026-08-11T10:00:00.000Z'),
  };
  const refreshedSnapshot = {
    ...initialSnapshot,
    warehouse: latestWarehouseId,
    updatedAt: new Date('2026-08-11T10:00:01.000Z'),
  };
  let findCalls = 0;
  let deleteCalls = 0;
  let userWarehouse = null;

  t.mock.method(SubcategorySubscriptionModel, 'find', () => ({
    select() {
      return this;
    },
    lean: async () => {
      findCalls += 1;
      return findCalls === 1 ? [initialSnapshot] : [refreshedSnapshot];
    },
  }));
  t.mock.method(SubcategorySubscriptionModel, 'updateOne', async (filter, update) => {
    if (update.$setOnInsert) {
      userWarehouse = update.$setOnInsert.warehouse ?? null;
      return { upsertedCount: 1, modifiedCount: 0 };
    }
    if (
      update.$set &&
      String(filter.warehouse ?? '') === String(userWarehouse ?? '')
    ) {
      userWarehouse = update.$set.warehouse ?? null;
      return { upsertedCount: 0, modifiedCount: 1 };
    }
    return { upsertedCount: 0, modifiedCount: 0 };
  });
  t.mock.method(SubcategorySubscriptionModel, 'deleteOne', async () => {
    deleteCalls += 1;
    return { deletedCount: deleteCalls === 1 ? 0 : 1 };
  });

  assert.deepEqual(
    await mergeGuestSubcategorySubscriptions({
      userId,
      guestId: 'guest-concurrent-update',
    }),
    { mergedCount: 1 },
  );
  assert.equal(String(userWarehouse), String(latestWarehouseId));
  assert.equal(deleteCalls, 2);
});

test('aggregate demand scopes moderators and routes before guest customer handlers', async (t) => {
  const warehouseId = new mongoose.Types.ObjectId();
  const disallowedWarehouseId = new mongoose.Types.ObjectId();
  let pipeline;
  t.mock.method(SubcategorySubscriptionModel, 'aggregate', async (value) => {
    pipeline = value;
    return [{ metadata: [{ totalDemandGroups: 0 }], data: [] }];
  });

  await getAdminSubcategoryDemand({
    warehouseScope: [warehouseId],
    search: 'cat.*',
    page: 1,
    limit: 20,
    lang: 'ar',
  });
  assert.deepEqual(pipeline[0].$match.warehouse.$in, [warehouseId]);
  const groups = pipeline.filter((stage) => stage.$group);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].$group._id, {
    subcategory: '$subcategory',
    warehouse: { $ifNull: ['$warehouse', null] },
  });
  assert.equal(groups[1].$group._id, '$_id.subcategory');
  assert.ok(groups[1].$group.warehouseDemand.$push);
  assert.equal(
    pipeline.at(-1).$facet.data.at(-1).$project.subcategory.name.$ifNull[0],
    '$subcategoryDocument.name_ar',
  );
  assert.equal(pipeline.at(-1).$facet.data.at(-1).$project.warehouse, undefined);
  assert.equal(pipeline.at(-1).$facet.data.at(-1).$project.warehouseDemand, 1);
  assert.equal(
    pipeline.find((stage) => stage.$match?.$or).$match.$or[0]['subcategoryDocument.name_en'].source,
    'cat\\.\\*',
  );
  await assert.rejects(
    () => getAdminSubcategoryDemand({
      warehouseId: disallowedWarehouseId,
      warehouseScope: [warehouseId],
    }),
    (error) => error.statusCode === 403,
  );

  const adminIndex = subcategorySubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === '/admin/demand',
  );
  const subscribersIndex = subcategorySubscriptionRoutes.stack.findIndex(
    (layer) =>
      layer.route?.path ===
      '/admin/demand/:subcategoryId/subscribers',
  );
  const parameterIndex = subcategorySubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === '/:subcategoryId',
  );
  assert.ok(adminIndex >= 0 && adminIndex < parameterIndex);
  assert.ok(subscribersIndex >= 0 && subscribersIndex < parameterIndex);
  assert.ok(subcategorySubscriptionRoutes.stack[adminIndex].route.stack.length >= 7);
  assert.ok(
    subcategorySubscriptionRoutes.stack[subscribersIndex].route.stack.length >=
      7,
  );
});

test('subscriber detail returns approved identity fields and count-only guests', async (t) => {
  const subcategoryId = new mongoose.Types.ObjectId();
  const warehouseId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let pipeline;

  t.mock.method(SubcategorySubscriptionModel, 'aggregate', async (value) => {
    pipeline = value;
    return [
      {
        counts: [
          {
            registeredUserCount: 1,
            unavailableRegisteredUserCount: 1,
            anonymousGuestCount: 2,
          },
        ],
        data: [
          {
            id: userId,
            name: 'amira',
            image: 'https://media.example/avatar.webp',
            warehouse: null,
            subscribedAt: new Date('2026-08-11T12:00:00.000Z'),
          },
        ],
      },
    ];
  });

  const result = await getAdminSubcategoryDemandSubscribers({
    subcategoryId,
    warehouseScope: [warehouseId],
    page: 1,
    limit: 20,
  });

  assert.equal(result.totalSubscribers, 4);
  assert.equal(result.registeredUserCount, 1);
  assert.equal(result.unavailableRegisteredUserCount, 1);
  assert.equal(result.anonymousGuestCount, 2);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(Object.keys(result.data[0]).sort(), [
    'id',
    'image',
    'name',
    'subscribedAt',
    'warehouse',
  ]);
  assert.equal(result.data[0].warehouse, null);
  assert.deepEqual(pipeline[0].$match.warehouse.$in, [warehouseId]);

  const projection = pipeline.find((stage) => stage.$facet).$facet.data.at(-1)
    .$project;
  assert.equal(projection.image, '$userDocument.image.url');
  assert.equal(Object.hasOwn(projection, 'email'), false);
  assert.equal(Object.hasOwn(projection, 'phone'), false);
  assert.equal(Object.hasOwn(projection, 'guestId'), false);
});
