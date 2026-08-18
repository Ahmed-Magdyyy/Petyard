import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import {
  RestockSubscriptionModel,
  restockSubscriptionStatus,
} from "../../src/domains/restockSubscription/restockSubscription.model.js";
import { restockNotificationGateway } from "../../src/domains/restockSubscription/restockSubscription.notificationGateway.js";
import restockSubscriptionRoutes from "../../src/domains/restockSubscription/restockSubscription.routes.js";
import {
  cleanupRestockSubscriptionsForProduct,
  getMyRestockSubscriptionsService,
  getProductStockAtWarehouse,
  getRestockSubscribedProductIdsForUser,
  getRestockSubscriptionStatusService,
  mergeGuestRestockSubscriptions,
  processRestockSubscriptionsForProduct,
  subscribeToRestockService,
  unsubscribeFromRestockService,
} from "../../src/domains/restockSubscription/restockSubscription.service.js";

function id() {
  return new mongoose.Types.ObjectId().toString();
}

function lean(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => value,
  };
}

function simpleProduct(productId, stocks) {
  return {
    _id: productId,
    type: "SIMPLE",
    isActive: true,
    name_en: "Royal Canin",
    name_ar: "رويال كانين",
    warehouseStocks: stocks,
  };
}

function installMemoryStore(t, { product, warehouses = [] }) {
  const subscriptions = [];
  const deletedFilters = [];

  t.mock.method(ProductModel, "findById", async (productId) =>
    String(productId) === String(product?._id) ? product : null
  );
  t.mock.method(WarehouseModel, "findById", async (warehouseId) =>
    warehouses.some((warehouse) => String(warehouse._id) === String(warehouseId))
      ? { _id: warehouseId }
      : null
  );
  t.mock.method(RestockSubscriptionModel, "findOne", (filter) =>
    lean(
      subscriptions.find(
        (item) =>
          (!filter.user || String(item.user) === String(filter.user)) &&
          (!filter.guestId || item.guestId === filter.guestId) &&
          (!filter._id || String(item._id) === String(filter._id)) &&
          (!filter.product || String(item.product) === String(filter.product)) &&
          (!filter.warehouse || String(item.warehouse) === String(filter.warehouse))
      ) || null
    )
  );
  t.mock.method(RestockSubscriptionModel, "find", (filter) =>
    lean(
      subscriptions.filter(
        (item) =>
          !filter._id &&
          (!filter.product ||
            (filter.product?.$in
              ? filter.product.$in.some(
                  (productId) => String(productId) === String(item.product),
                )
              : String(item.product) === String(filter.product))) &&
          (!filter.user || String(item.user) === String(filter.user)) &&
          (!filter.guestId || item.guestId === filter.guestId) &&
          (filter.status?.$in
            ? filter.status.$in.includes(item.status)
            : !filter.status || item.status === filter.status) &&
          (!filter.warehouse?.$in ||
            filter.warehouse.$in.some((warehouseId) => String(warehouseId) === String(item.warehouse))) &&
          (!filter.warehouse || filter.warehouse.$in || String(item.warehouse) === String(filter.warehouse))
      )
    )
  );
  t.mock.method(RestockSubscriptionModel, "findOneAndUpdate", (filter, update, options = {}) => {
    let item = subscriptions.find((candidate) => {
      if (filter._id && String(candidate._id) !== String(filter._id)) return false;
      if (filter.user && String(candidate.user) !== String(filter.user)) return false;
      if (filter.guestId && candidate.guestId !== filter.guestId) return false;
      if (filter.product && String(candidate.product) !== String(filter.product)) return false;
      if (filter.warehouse && String(candidate.warehouse) !== String(filter.warehouse)) return false;
      return !filter.status || candidate.status === filter.status;
    });
    if (!item && options.upsert) {
      item = {
        _id: id(),
        user: filter.user,
        guestId: filter.guestId,
        product: filter.product,
        warehouse: filter.warehouse,
      };
      subscriptions.push(item);
    }
    if (!item) return lean(null);
    Object.assign(item, update.$setOnInsert || {}, update.$set || {});
    return lean({ ...item });
  });
  t.mock.method(RestockSubscriptionModel, "updateMany", async () => ({ modifiedCount: 0 }));
  t.mock.method(RestockSubscriptionModel, "updateOne", async (filter, update) => {
    const item = subscriptions.find(
      (candidate) =>
        String(candidate._id) === String(filter._id) &&
        candidate.status === filter.status &&
        candidate.claimToken === filter.claimToken
    );
    if (!item) return { modifiedCount: 0 };
    Object.assign(item, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete item[key];
    return { modifiedCount: 1 };
  });
  t.mock.method(RestockSubscriptionModel, "deleteMany", async (filter) => {
    deletedFilters.push(filter);
    const matching = subscriptions.filter(
      (item) =>
        (!filter.product || String(item.product) === String(filter.product)) &&
        (!filter.guestId || item.guestId === filter.guestId)
    );
    for (const item of matching) {
      subscriptions.splice(subscriptions.indexOf(item), 1);
    }
    return { deletedCount: matching.length };
  });
  t.mock.method(restockNotificationGateway, "dispatch", async () => ({
    inApp: { success: true },
    push: { successCount: 0, failureCount: 0 },
  }));
  t.mock.method(restockNotificationGateway, "dispatchToGuests", async () => ({
    inApp: null,
    push: { successCount: 1, failureCount: 0 },
  }));

  return { subscriptions, deletedFilters };
}

test("simple and variant warehouse stock validation only allows subscriptions while out of stock", async (t) => {
  const productId = id();
  const warehouseId = id();
  const product = simpleProduct(productId, [{ warehouse: warehouseId, quantity: 0 }]);
  const store = installMemoryStore(t, {
    product,
    warehouses: [{ _id: warehouseId }],
  });

  const subscription = await subscribeToRestockService({ userId: id(), productId, warehouseId });
  assert.equal(subscription.subscribed, true);
  assert.equal(store.subscriptions.length, 1);

  Object.assign(product, {
    ...simpleProduct(productId, []),
    type: "VARIANT",
    variants: [
      { warehouseStocks: [{ warehouse: warehouseId, quantity: 1 }] },
      { warehouseStocks: [{ warehouse: warehouseId, quantity: 2 }] },
    ],
  });
  assert.equal(getProductStockAtWarehouse(product, warehouseId), 3);
  await assert.rejects(
    subscribeToRestockService({ userId: id(), productId, warehouseId }),
    (error) => error.statusCode === 409
  );
});

test("subscribe is unique/idempotent and unsubscribe/status are isolated by warehouse", async (t) => {
  const productId = id();
  const warehouseA = id();
  const warehouseB = id();
  const userId = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [
      { warehouse: warehouseA, quantity: 0 },
      { warehouse: warehouseB, quantity: 0 },
    ]),
    warehouses: [{ _id: warehouseA }, { _id: warehouseB }],
  });

  await subscribeToRestockService({ userId, productId, warehouseId: warehouseA });
  await subscribeToRestockService({ userId, productId, warehouseId: warehouseA });
  await subscribeToRestockService({ userId, productId, warehouseId: warehouseB });
  assert.equal(store.subscriptions.length, 2);

  await unsubscribeFromRestockService({ userId, productId, warehouseId: warehouseA });
  const statusA = await getRestockSubscriptionStatusService({ userId, productId, warehouseId: warehouseA });
  const statusB = await getRestockSubscriptionStatusService({ userId, productId, warehouseId: warehouseB });
  assert.equal(statusA.subscribed, false);
  assert.equal(statusB.subscribed, true);

  const subscribedProductIds = await getRestockSubscribedProductIdsForUser({
    userId,
    productIds: [productId],
    warehouseId: warehouseB,
  });
  assert.deepEqual([...subscribedProductIds], [productId]);
});

test("guests can subscribe, query and unsubscribe independently from users", async (t) => {
  const productId = id();
  const warehouseA = id();
  const warehouseB = id();
  const guestId = "guest-restock-123";
  const userId = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [
      { warehouse: warehouseA, quantity: 0 },
      { warehouse: warehouseB, quantity: 0 },
    ]),
    warehouses: [{ _id: warehouseA }, { _id: warehouseB }],
  });

  await subscribeToRestockService({ guestId, productId, warehouseId: warehouseA });
  await subscribeToRestockService({ guestId, productId, warehouseId: warehouseA });
  await subscribeToRestockService({ guestId, productId, warehouseId: warehouseB });
  await subscribeToRestockService({ userId, productId, warehouseId: warehouseA });
  assert.equal(store.subscriptions.length, 3);

  const guestWarehouseA = await getRestockSubscriptionStatusService({
    guestId,
    productId,
    warehouseId: warehouseA,
  });
  const userWarehouseA = await getRestockSubscriptionStatusService({
    userId,
    productId,
    warehouseId: warehouseA,
  });
  assert.equal(guestWarehouseA.subscribed, true);
  assert.equal(userWarehouseA.subscribed, true);

  await unsubscribeFromRestockService({ guestId, productId, warehouseId: warehouseA });
  assert.equal(
    (
      await getRestockSubscriptionStatusService({
        guestId,
        productId,
        warehouseId: warehouseA,
      })
    ).subscribed,
    false
  );
  assert.equal(
    (
      await getRestockSubscriptionStatusService({
        guestId,
        productId,
        warehouseId: warehouseB,
      })
    ).subscribed,
    true
  );

  const subscribedProductIds = await getRestockSubscribedProductIdsForUser({
    userId: id(),
    guestId,
    productIds: [productId],
    warehouseId: warehouseB,
  });
  assert.deepEqual([...subscribedProductIds], []);
  const guestSubscribedProductIds = await getRestockSubscribedProductIdsForUser({
    guestId,
    productIds: [productId],
    warehouseId: warehouseB,
  });
  assert.deepEqual([...guestSubscribedProductIds], [productId]);
});

test("users and guests list only their own pending product subscriptions", async (t) => {
  const userId = id();
  const anotherUserId = id();
  const guestId = "guest-restock-list";
  const productA = id();
  const productB = id();
  const warehouseA = id();
  const warehouseB = id();
  const store = installMemoryStore(t, { product: null });

  store.subscriptions.push(
    {
      _id: id(),
      user: userId,
      product: productA,
      warehouse: warehouseA,
      status: restockSubscriptionStatus.ACTIVE,
    },
    {
      _id: id(),
      user: userId,
      product: productB,
      warehouse: warehouseB,
      status: restockSubscriptionStatus.PROCESSING,
    },
    {
      _id: id(),
      user: userId,
      product: id(),
      warehouse: warehouseA,
      status: restockSubscriptionStatus.NOTIFIED,
    },
    {
      _id: id(),
      user: anotherUserId,
      product: id(),
      warehouse: warehouseA,
      status: restockSubscriptionStatus.ACTIVE,
    },
    {
      _id: id(),
      guestId,
      product: productA,
      warehouse: warehouseB,
      status: restockSubscriptionStatus.ACTIVE,
    },
  );

  assert.deepEqual(
    await getMyRestockSubscriptionsService({ userId }),
    [
      {
        subscribed: true,
        status: restockSubscriptionStatus.ACTIVE,
        productId: productA,
        warehouseId: warehouseA,
      },
      {
        subscribed: true,
        status: restockSubscriptionStatus.PROCESSING,
        productId: productB,
        warehouseId: warehouseB,
      },
    ],
  );
  assert.deepEqual(
    await getMyRestockSubscriptionsService({ guestId }),
    [
      {
        subscribed: true,
        status: restockSubscriptionStatus.ACTIVE,
        productId: productA,
        warehouseId: warehouseB,
      },
    ],
  );
});

test("restock routes reserve /me before the product parameter route", () => {
  const rootGetRoute = restockSubscriptionRoutes.stack.find(
    (layer) =>
      layer.route?.path === "/" && layer.route?.methods?.get === true,
  );
  const meIndex = restockSubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/me",
  );
  const parameterIndex = restockSubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/:productId",
  );

  assert.ok(rootGetRoute);
  assert.ok(meIndex >= 0 && meIndex < parameterIndex);
});

test("restock processing notifies only the warehouses currently in stock with the expected bilingual payload", async (t) => {
  const productId = id();
  const warehouseAvailable = id();
  const warehouseEmpty = id();
  const userAvailable = id();
  const userEmpty = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [
      { warehouse: warehouseAvailable, quantity: 3 },
      { warehouse: warehouseEmpty, quantity: 0 },
    ]),
  });
  store.subscriptions.push(
    { _id: id(), user: userAvailable, product: productId, warehouse: warehouseAvailable, status: restockSubscriptionStatus.ACTIVE },
    { _id: id(), user: userEmpty, product: productId, warehouse: warehouseEmpty, status: restockSubscriptionStatus.ACTIVE }
  );
  const payloads = [];
  t.mock.method(restockNotificationGateway, "dispatch", async (payload) => {
    payloads.push(payload);
    return { inApp: { success: true }, push: { successCount: 1, failureCount: 0 } };
  });

  const result = await processRestockSubscriptionsForProduct({ productId });
  assert.deepEqual(result, { claimed: 1, notified: 1, retried: 0 });
  assert.equal(store.subscriptions[0].status, restockSubscriptionStatus.NOTIFIED);
  assert.equal(store.subscriptions[1].status, restockSubscriptionStatus.ACTIVE);
  assert.deepEqual(payloads[0].notification, {
    title_en: "Product back in stock",
    title_ar: "المنتج متوفر الآن",
    body_en: "Royal Canin is available again. Shop now.",
    body_ar: "عاد رويال كانين إلى المخزون. اطلبه الآن.",
  });
  assert.equal(payloads[0].icon, "product");
  assert.deepEqual(payloads[0].action, {
    type: "product_detail",
    screen: "ProductDetailScreen",
    params: { productId, warehouseId: warehouseAvailable },
  });
  assert.deepEqual(payloads[0].source, { domain: "product", event: "restocked", referenceId: productId });
});

test("restock processing sends guests a push-only notification", async (t) => {
  const productId = id();
  const warehouseId = id();
  const guestId = "guest-restock-push";
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [{ warehouse: warehouseId, quantity: 4 }]),
  });
  store.subscriptions.push({
    _id: id(),
    guestId,
    product: productId,
    warehouse: warehouseId,
    status: restockSubscriptionStatus.ACTIVE,
  });
  const payloads = [];
  t.mock.method(restockNotificationGateway, "dispatchToGuests", async (payload) => {
    payloads.push(payload);
    return { inApp: null, push: { successCount: 1, failureCount: 0 } };
  });

  const result = await processRestockSubscriptionsForProduct({ productId });
  assert.deepEqual(result, { claimed: 1, notified: 1, retried: 0 });
  assert.equal(store.subscriptions[0].status, restockSubscriptionStatus.NOTIFIED);
  assert.deepEqual(payloads[0].guestIds, [guestId]);
  assert.equal(payloads[0].channels, undefined);
  assert.equal(payloads[0].action.params.warehouseId, warehouseId);
});

test("atomic claims stop concurrent processing from sending a duplicate alert", async (t) => {
  const productId = id();
  const warehouseId = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [{ warehouse: warehouseId, quantity: 1 }]),
  });
  store.subscriptions.push({ _id: id(), user: id(), product: productId, warehouse: warehouseId, status: restockSubscriptionStatus.ACTIVE });
  let releaseDispatch;
  const dispatchStarted = new Promise((resolve) => {
    t.mock.method(restockNotificationGateway, "dispatch", async () => {
      resolve();
      await new Promise((done) => { releaseDispatch = done; });
      return { inApp: { success: true }, push: { successCount: 1, failureCount: 0 } };
    });
  });

  const first = processRestockSubscriptionsForProduct({ productId });
  await dispatchStarted;
  const second = await processRestockSubscriptionsForProduct({ productId });
  releaseDispatch();
  const firstResult = await first;
  assert.equal(firstResult.notified, 1);
  assert.deepEqual(second, { claimed: 0, notified: 0, retried: 0 });
});

test("missing or complete dispatcher failure releases the claim for retry, while success is one-shot and cleanup removes product subscriptions", async (t) => {
  const productId = id();
  const warehouseId = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [{ warehouse: warehouseId, quantity: 1 }]),
  });
  const subscription = { _id: id(), user: id(), product: productId, warehouse: warehouseId, status: restockSubscriptionStatus.ACTIVE };
  store.subscriptions.push(subscription);
  let dispatchResult = null;
  t.mock.method(restockNotificationGateway, "dispatch", async () => dispatchResult);

  assert.deepEqual(await processRestockSubscriptionsForProduct({ productId }), { claimed: 1, notified: 0, retried: 1 });
  assert.equal(subscription.status, restockSubscriptionStatus.ACTIVE);

  dispatchResult = { inApp: { success: false }, push: { successCount: 0, failureCount: 0 } };
  assert.deepEqual(await processRestockSubscriptionsForProduct({ productId }), { claimed: 1, notified: 0, retried: 1 });
  assert.equal(subscription.status, restockSubscriptionStatus.ACTIVE);

  dispatchResult = { inApp: { success: true }, push: { successCount: 1, failureCount: 0 } };
  assert.deepEqual(await processRestockSubscriptionsForProduct({ productId }), { claimed: 1, notified: 1, retried: 0 });
  assert.equal(subscription.status, restockSubscriptionStatus.NOTIFIED);
  assert.deepEqual(await processRestockSubscriptionsForProduct({ productId }), { claimed: 0, notified: 0, retried: 0 });

  await cleanupRestockSubscriptionsForProduct(productId);
  assert.deepEqual(store.deletedFilters, [{ product: productId }]);
});

test("merging guest subscriptions activates pending user subscriptions and removes all guest rows", async (t) => {
  const userId = id();
  const guestId = "guest-restock-merge";
  const productA = id();
  const productB = id();
  const productC = id();
  const productD = id();
  const warehouseId = id();
  const store = installMemoryStore(t, { product: null });
  store.subscriptions.push(
    {
      _id: id(),
      guestId,
      product: productA,
      warehouse: warehouseId,
      status: restockSubscriptionStatus.ACTIVE,
    },
    {
      _id: id(),
      guestId,
      product: productB,
      warehouse: warehouseId,
      status: restockSubscriptionStatus.PROCESSING,
    },
    {
      _id: id(),
      guestId,
      product: productC,
      warehouse: warehouseId,
      status: restockSubscriptionStatus.NOTIFIED,
    },
    {
      _id: id(),
      guestId,
      product: productD,
      warehouse: warehouseId,
      status: restockSubscriptionStatus.CANCELLED,
    },
    {
      _id: id(),
      user: userId,
      product: productA,
      warehouse: warehouseId,
      status: restockSubscriptionStatus.CANCELLED,
    }
  );

  const result = await mergeGuestRestockSubscriptions({ userId, guestId });
  assert.deepEqual(result, { mergedCount: 2, removedCount: 4 });
  assert.equal(store.subscriptions.some((item) => item.guestId === guestId), false);
  const userSubscriptions = store.subscriptions.filter(
    (item) => String(item.user) === String(userId)
  );
  assert.equal(userSubscriptions.length, 2);
  assert.equal(
    userSubscriptions.find((item) => String(item.product) === productA).status,
    restockSubscriptionStatus.ACTIVE
  );
  assert.equal(
    userSubscriptions.find((item) => String(item.product) === productB).status,
    restockSubscriptionStatus.ACTIVE
  );
});

test("merging a guest restock subscription immediately processes stock that is already available", async (t) => {
  const userId = id();
  const guestId = "guest-restock-merge-available";
  const productId = id();
  const warehouseId = id();
  const store = installMemoryStore(t, {
    product: simpleProduct(productId, [
      { warehouse: warehouseId, quantity: 2 },
    ]),
  });
  store.subscriptions.push({
    _id: id(),
    guestId,
    product: productId,
    warehouse: warehouseId,
    status: restockSubscriptionStatus.ACTIVE,
  });
  const userPayloads = [];
  t.mock.method(restockNotificationGateway, "dispatch", async (payload) => {
    userPayloads.push(payload);
    return { inApp: { success: true }, push: { successCount: 0 } };
  });

  const result = await mergeGuestRestockSubscriptions({ userId, guestId });

  assert.deepEqual(result, { mergedCount: 1, removedCount: 1 });
  assert.equal(store.subscriptions.some((item) => item.guestId === guestId), false);
  assert.equal(userPayloads.length, 1);
  assert.equal(userPayloads[0].userId, userId);
  assert.equal(store.subscriptions[0].status, restockSubscriptionStatus.NOTIFIED);
});
