import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mergeGuestOrdersService } from "../../../src/domains/order/order.guest-merge.js";
import { getMyOrdersService, getGuestOrdersService, getMyOrderByIdService, getGuestOrderByIdService } from "../../../src/domains/order/order.service.js";
import { listSubstitutionRequestsForOwnerService } from "../../../src/domains/substitution/substitution.service.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ReturnRequestModel } from "../../../src/domains/return/return.model.js";
import { SubstitutionRequestModel } from "../../../src/domains/substitution/substitutionRequest.model.js";
import { OrderPaymentAttemptModel } from "../../../src/domains/payment/orderPaymentAttempt.model.js";
import { RefundOperationModel } from "../../../src/domains/payment/refundOperation.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";
import { mergeGuest } from "../../../src/domains/auth/auth.controller.js";
import authRoutes from "../../../src/domains/auth/auth.routes.js";
import { protect } from "../../../src/domains/auth/auth.middleware.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { AddressModel } from "../../../src/domains/address/address.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { NotificationDeviceModel } from "../../../src/domains/notification/notification.model.js";
import { RestockSubscriptionModel } from "../../../src/domains/restockSubscription/restockSubscription.model.js";
import { SubcategorySubscriptionModel } from "../../../src/domains/subcategorySubscription/subcategorySubscription.model.js";

const USER = "111111111111111111111111";
const OTHER_USER = "222222222222222222222222";
const ORDER = "333333333333333333333333";
const SECOND_ORDER = "444444444444444444444444";
const OTHER_ORDER = "555555555555555555555555";
const GUEST = "original-guest-credential";
const models = { orders: OrderModel, returns: ReturnRequestModel, substitutions: SubstitutionRequestModel,
  attempts: OrderPaymentAttemptModel, refunds: RefundOperationModel, outbox: NotificationOutboxModel, notifications: InAppNotificationModel };

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = key.split(".").reduce((value, field) => value?.[field], document);
    if (expected === null) return actual == null;
    if (expected?.$in) return expected.$in.some(value => String(value) === String(actual));
    if (expected?.$gt !== undefined) return actual > expected.$gt;
    return String(actual) === String(expected);
  });
}

function query(read) {
  let session;
  return { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
    populate() { return this; }, lean() { return this; }, session(value) { session = value; return this; },
    then(resolve, reject) { return Promise.resolve().then(() => read(session)).then(resolve, reject); } };
}

function fixture(t) {
  const date = new Date("2026-09-01T12:00:00Z");
  const order = { _id: ORDER, guestId: GUEST, warehouse: "warehouse-a", orderNumber: "KEEP-123", items: [],
    deliveryAddress: { phone: "original-phone", name: "Original recipient" }, total: 80, subtotal: 70,
    paymentMethod: "card", paymentStatus: "paid", status: "delivered", history: [],
    settlement: { cardCapturedPiastres: 8000, cardRefundedPiastres: 0 },
    createdAt: date, updatedAt: date, checkoutKey: "preserve-checkout-key", paymobOrderId: "provider-123" };
  const related = { _id: "related", order: ORDER, guestId: GUEST, status: "pending", refundMethod: "card",
    method: "card", amountPiastres: 3000, currency: "EGP", originalTransactionId: "original-capture",
    requestIdempotencyKey: "keep-payment-key", operationId: "keep-refund-id", createdAt: date, updatedAt: date };
  const notification = { _id: "notification", guestId: GUEST, source: { domain: "order" },
    action: { params: { orderId: ORDER } }, dedupeKey: "keep-original-dedupe", isRead: true, readAt: date,
    createdAt: date, updatedAt: date };
  const state = { writes: [], ended: 0, active: false, failAt: null, retries: 0, beforeRetry: null, stores: {
    orders: [order, { ...structuredClone(order), _id: SECOND_ORDER, status: "awaiting_payment", warehouse: "warehouse-b" },
      { ...structuredClone(order), _id: OTHER_ORDER, guestId: "another-guest" },
      { ...structuredClone(order), _id: "already-owned", user: OTHER_USER },
      { ...structuredClone(order), _id: "existing-user-order", user: USER, guestId: undefined }],
    returns: [related], substitutions: [structuredClone(related)], attempts: [structuredClone(related)], refunds: [structuredClone(related)],
    notifications: [notification], outbox: [{ ...structuredClone(notification), guestId: undefined, recipientGuestId: GUEST,
      status: "pending", leaseToken: "preserve-lease", nextAttemptAt: date }],
  } };
  for (const name of ["returns", "substitutions", "attempts", "refunds"]) {
    state.stores[name].push({ ...structuredClone(related), _id: "unrelated-order", order: OTHER_ORDER });
    state.stores[name].push({ ...structuredClone(related), _id: "already-owned", user: OTHER_USER });
  }
  for (const name of ["notifications", "outbox"]) {
    state.stores[name].push({ ...structuredClone(state.stores[name][0]), _id: "unrelated-event", source: { domain: "restock" } });
    state.stores[name].push({ ...structuredClone(state.stores[name][0]), _id: "unrelated-order", action: { params: { orderId: OTHER_ORDER } } });
  }
  const requireTransaction = session => { assert.equal(session, state.session); assert.equal(state.active, true); };
  state.session = { async endSession() { state.ended++; }, async withTransaction(work) {
    while (true) {
      const snapshot = structuredClone(state.stores);
      state.active = true;
      try {
        const result = await work();
        if (state.retries-- > 0) {
          state.stores = snapshot;
          state.beforeRetry?.();
          continue;
        }
        return result;
      } catch (error) { state.stores = snapshot; throw error; }
      finally { state.active = false; }
    }
  } };
  // This double verifies transaction usage and caller aborts, not native MongoDB isolation.
  t.mock.method(mongoose, "startSession", async () => state.session);
  t.mock.method(mongoose.Connection.prototype, "openUri", () => assert.fail("No database connections"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider calls"));
  for (const [name, model] of Object.entries(models)) {
    t.mock.method(model, "find", filter => query(session => {
      if (session) requireTransaction(session);
      return structuredClone(state.stores[name].filter(document => matches(document, filter)));
    }));
    t.mock.method(model, "findById", id => query(() => structuredClone(state.stores[name].find(document => String(document._id) === String(id)) ?? null)));
    t.mock.method(model, "findOne", filter => query(() => structuredClone(state.stores[name].find(document => matches(document, filter)) ?? null)));
    t.mock.method(model, "countDocuments", async filter => state.stores[name].filter(document => matches(document, filter)).length);
    t.mock.method(model, "updateMany", async (filter, update, options) => {
      requireTransaction(options.session);
      assert.equal(options.timestamps, false);
      if (state.failAt === name) throw new Error("injected ownership write failure");
      state.writes.push({ name, filter, update });
      let modifiedCount = 0;
      for (const document of state.stores[name].filter(document => matches(document, filter))) {
        Object.assign(document, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete document[key];
        modifiedCount++;
      }
      return { modifiedCount };
    });
    t.mock.method(model, "updateOne", (...args) => model.updateMany(...args));
  }
  state.merge = (userId = USER) => mergeGuestOrdersService({ userId, guestId: GUEST });
  return state;
}

test("merge transfers orders across statuses and warehouses with related ownership only", async t => {
  const state = fixture(t);
  const before = structuredClone(state.stores);
  assert.deepEqual(await state.merge(), { mergedCount: 2 });
  for (const [name, documents] of Object.entries(state.stores)) {
    for (let index = 0; index < documents.length; index++) {
      const original = before[name][index];
      const eligible = name === "orders" ? index < 2 : index === 0;
      const ownerKey = name === "outbox" ? "recipientUser" : "user";
      const guestKey = name === "outbox" ? "recipientGuestId" : "guestId";
      const expected = structuredClone(original);
      if (eligible) { expected[ownerKey] = USER; delete expected[guestKey]; }
      assert.deepEqual(documents[index], expected, `${name}[${index}] must preserve non-ownership fields`);
    }
  }
  assert.equal(state.ended, 1);
});

test("transferred orders and substitutions are visible to the user and inaccessible to the old guest", async t => {
  const state = fixture(t);
  await state.merge();
  const userOrders = await getMyOrdersService({ userId: USER });
  assert.equal(userOrders.results, 3);
  assert.ok(userOrders.data.some(order => order._id === ORDER));
  assert.equal((await getGuestOrdersService({ guestId: GUEST })).data.some(order => order._id === ORDER), false);
  assert.equal((await getMyOrderByIdService({ userId: USER, orderId: ORDER }))._id, ORDER);
  await assert.rejects(getGuestOrderByIdService({ guestId: GUEST, orderId: ORDER }), error => error.statusCode === 404);
  await assert.rejects(getMyOrderByIdService({ userId: OTHER_USER, orderId: ORDER }), error => error.statusCode === 404);
  assert.equal((await listSubstitutionRequestsForOwnerService({ userId: USER, orderId: ORDER })).length, 1);
  await assert.rejects(listSubstitutionRequestsForOwnerService({ guestId: GUEST, orderId: ORDER }), error => error.statusCode === 404);
});

test("retrying the merge is a no-op and another user cannot claim transferred orders", async t => {
  const state = fixture(t);
  await state.merge();
  const after = structuredClone(state.stores);
  const writes = state.writes.length;
  assert.deepEqual(await state.merge(), { mergedCount: 0 });
  assert.deepEqual(await state.merge(OTHER_USER), { mergedCount: 0 });
  assert.deepEqual(state.stores, after);
  assert.equal(state.writes.length, writes);
  assert.equal(state.ended, 3);
});

test("an empty guest does not change related records", async t => {
  const state = fixture(t);
  state.stores.orders = [];
  const before = structuredClone(state.stores);
  assert.deepEqual(await state.merge(), { mergedCount: 0 });
  assert.deepEqual(state.stores, before);
  assert.equal(state.writes.length, 0);
  assert.equal(state.ended, 1);
});

test("a dependent ownership failure aborts the transaction and can be retried", async t => {
  const state = fixture(t);
  const before = structuredClone(state.stores);
  state.failAt = "refunds";
  await assert.rejects(state.merge(), /injected ownership write failure/);
  assert.deepEqual(state.stores, before);
  assert.equal(state.ended, 1);
  state.failAt = null;
  assert.deepEqual(await state.merge(), { mergedCount: 2 });
});

test("a transaction callback retry does not double-count transfers", async t => {
  const state = fixture(t);
  state.retries = 1;
  assert.deepEqual(await state.merge(), { mergedCount: 2 });
  assert.equal(state.stores.orders.filter(order => order.user === USER).length, 3);
});

test("a transaction retry observes orders claimed by another user", async t => {
  const state = fixture(t);
  state.retries = 1;
  state.beforeRetry = () => {
    for (const documents of Object.values(state.stores)) {
      for (const document of documents) {
        if (document.guestId === GUEST && !document.user && (document.order === ORDER || [ORDER, SECOND_ORDER].includes(document._id))) {
          document.user = OTHER_USER; delete document.guestId;
        }
      }
    }
  };
  assert.deepEqual(await state.merge(), { mergedCount: 0 });
  assert.equal(state.stores.orders.find(order => order._id === ORDER).user, OTHER_USER);
});

test("invalid user or guest identities fail before opening a session", async t => {
  t.mock.method(mongoose, "startSession", () => assert.fail("Invalid input must not open a session"));
  for (const input of [{ userId: USER }, { userId: USER, guestId: " " },
    { userId: USER, guestId: { $ne: null } }, { userId: "bad-id", guestId: GUEST }, { guestId: GUEST }]) {
    await assert.rejects(mergeGuestOrdersService(input), error => error.statusCode === 400);
  }
});

for (const paymentMethod of ["card", "instapay"]) {
  test(`merge preserves an unqueued terminal ${paymentMethod} refund`, async t => {
    const state = fixture(t);
    const order = state.stores.orders[0];
    order.paymentMethod = paymentMethod;
    order.paymobTransactionId = "original-transaction";
    order.settlement.pendingRefundLiabilityPiastres = 3000;
    const request = state.stores.substitutions[0];
    Object.assign(request, { isActive: false, status: "expired", pricingSnapshot: { refundOrCreditPiastres: 3000 } });
    state.stores.refunds = [];
    t.mock.method(RefundOperationModel, "create", async (documents, options) => {
      assert.equal(options.session, state.session);
      assert.equal(state.active, true);
      const operation = { _id: "new-refund", ...documents[0] };
      state.stores.refunds.push(operation);
      return [structuredClone(operation)];
    });
    assert.deepEqual(await state.merge(), { mergedCount: 2 });
    const operation = state.stores.refunds[0];
    assert.equal(operation.method, paymentMethod === "card" ? "card" : "manual");
    assert.equal(operation.amountPiastres, 3000);
    assert.equal(operation.status, "pending");
    assert.equal(operation.user, USER);
    assert.equal(operation.guestId, undefined);
    assert.equal(state.stores.substitutions[0].refundOperation, "new-refund");
    assert.equal(state.stores.orders[0].settlement.pendingRefundLiabilityPiastres, 3000);
    assert.equal(state.stores.orders[0].settlement.cardRefundedPiastres, 0);
    assert.deepEqual(await state.merge(), { mergedCount: 0 });
    assert.equal(state.stores.refunds.length, 1);
  });
}

function stubOtherMerges(t) {
  const warehouse = "666666666666666666666666";
  const cart = { _id: "user-cart", user: USER, items: [], checkoutKey: "existing-key", async save() { return this; } };
  t.mock.method(CartModel, "findOne", filter => query(() => filter.user ? cart : null));
  t.mock.method(WarehouseModel, "findById", () => query(() => ({ _id: warehouse, active: true })));
  t.mock.method(CollectionModel, "updateMany", async () => ({ modifiedCount: 0 }));
  t.mock.method(FavoriteModel, "findOne", filter => query(() => filter.user ? { _id: "favorite", user: USER, items: [] } : null));
  t.mock.method(AddressModel, "find", () => query(() => []));
  t.mock.method(NotificationDeviceModel, "updateMany", async () => ({ modifiedCount: 1 }));
  t.mock.method(RestockSubscriptionModel, "find", () => query(() => []));
  t.mock.method(RestockSubscriptionModel, "deleteMany", async () => ({ deletedCount: 0 }));
  t.mock.method(SubcategorySubscriptionModel, "find", () => query(() => []));
  return { headers: { "x-guest-id": `  ${GUEST}  ` }, user: { _id: USER }, query: { warehouse } };
}

function callMerge(req) {
  return new Promise((resolve, reject) => {
    const res = { status(code) { assert.equal(code, 200); return this; }, json: resolve };
    mergeGuest(req, res, reject);
  });
}

test("the same protected merge-guest route returns orders alongside all existing merge fields", async t => {
  const state = fixture(t);
  const route = authRoutes.stack.find(layer => layer.route?.path === "/merge-guest").route;
  assert.equal(route.methods.post, true);
  assert.equal(route.stack[0].handle, protect);
  assert.equal(route.stack[1].handle, mergeGuest);
  const req = stubOtherMerges(t);
  const response = await callMerge(req);
  assert.equal(response.message, "Guest merged successfully");
  assert.deepEqual(Object.keys(response.data).sort(), ["cart", "favorites", "addresses", "notificationDevices",
    "restockSubscriptions", "subcategorySubscriptions", "orders"].sort());
  assert.deepEqual(response.data.orders, { mergedCount: 2 });
  assert.equal(state.stores.orders[0].user, USER);
  assert.equal(response.data.notificationDevices.mergedCount, 1);
  assert.deepEqual((await callMerge(req)).data.orders, { mergedCount: 0 });
});

test("merge-guest propagates an order-transfer failure instead of returning success", async t => {
  const state = fixture(t);
  const before = structuredClone(state.stores);
  state.failAt = "refunds";
  await assert.rejects(callMerge(stubOtherMerges(t)), /injected ownership write failure/);
  assert.deepEqual(state.stores, before);
});

test("merge-guest still requires the original guest header and warehouse before any order transfer", async t => {
  t.mock.method(mongoose, "startSession", () => assert.fail("Invalid request must not start order transfer"));
  for (const req of [{ headers: {}, user: { _id: USER }, query: { warehouse: "warehouse" } },
    { headers: { "x-guest-id": GUEST }, user: { _id: USER }, query: {} }]) {
    await assert.rejects(callMerge(req), error => error.statusCode === 400);
  }
  await assert.rejects(new Promise((resolve, reject) => protect({ headers: {} }, {}, error => error ? reject(error) : resolve())),
    error => error.statusCode === 401);
});
