import assert from "node:assert/strict";
import test from "node:test";

import { sendNewOrderNotificationToAdminsAndModerators } from "../../../src/domains/notification/notification.service.js";
import { dispatchNotification } from "../../../src/domains/notification/notificationDispatcher.js";
import { NotificationDeviceModel } from "../../../src/domains/notification/notification.model.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";
import { deliverClaimedNotificationOutbox } from "../../../src/domains/notification/notificationOutbox.worker.service.js";

const order = { _id: "order-1", orderNumber: "PY-1", warehouse: "warehouse-1" };
const staff = [
  { _id: "super-1", role: "superAdmin", active: true, deletedAt: null, account_status: "confirmed" },
  { _id: "admin-orders", role: "admin", enabledControls: ["orders"], active: true, deletedAt: null, account_status: "confirmed" },
  { _id: "moderator-1", role: "moderator", active: true, deletedAt: null, account_status: "confirmed" },
];

function query(rows) {
  const result = {
    select() { return result; },
    lean() { return Promise.resolve(rows); },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  };
  return result;
}

function outboxStore() {
  const rows = new Map();
  return {
    rows,
    async create([document]) {
      if (rows.has(document.dedupeKey)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      rows.set(document.dedupeKey, { ...document });
      return [rows.get(document.dedupeKey)];
    },
    async findOne({ dedupeKey }) { return rows.get(dedupeKey) || null; },
  };
}

test("new-order alerts enqueue once per order and recipient with safe existing order action", async () => {
  const filters = [];
  const userModel = {
    find(filter) {
      filters.push(filter);
      return query(filter._id ? staff.filter((user) => user._id === "moderator-1") : staff.slice(0, 2));
    },
  };
  const warehouseModel = { findById: () => query({ moderators: ["moderator-1"] }) };
  const outboxModel = outboxStore();

  await sendNewOrderNotificationToAdminsAndModerators(order, { userModel, warehouseModel, outboxModel });
  await sendNewOrderNotificationToAdminsAndModerators(order, { userModel, warehouseModel, outboxModel });
  await sendNewOrderNotificationToAdminsAndModerators({ ...order, _id: "order-2" }, { userModel, warehouseModel, outboxModel });

  assert.equal(outboxModel.rows.size, 6);
  assert.ok(outboxModel.rows.has("order:new_order_placed:order-2:super-1"));
  const first = outboxModel.rows.get("order:new_order_placed:order-1:super-1");
  assert.equal(first.recipientUser, "super-1");
  assert.equal(first.source.event, "new_order_placed");
  assert.deepEqual(first.action, {
    type: "order_detail", screen: "OrderDetailScreen", params: { orderId: "order-1" },
  });
  assert.equal("pushOptions" in first, false);
  assert.ok(filters.every((filter) => filter.active === true && filter.deletedAt === null));
  assert.ok(filters.every((filter) => filter.account_status?.$nin?.includes("banned") &&
    filter.account_status.$nin.includes("deleted")));
  assert.ok(filters.some((filter) => filter.role === "moderator"));
});

function deliveryModels(user, { orderExists = true, moderators = ["moderator-1"] } = {}) {
  return {
    userModel: { findById: () => query(user) },
    orderModel: { findById: () => query(orderExists ? { warehouse: "warehouse-1" } : null) },
    warehouseModel: { findById: () => query({ moderators }) },
  };
}

async function deliverStaffAlert(source, user, models = {}) {
  let dispatched;
  let deadLetter;
  const result = await deliverClaimedNotificationOutbox({
    outbox: {
      _id: "outbox-1", leaseToken: "lease-1", attempts: 1,
      recipientUser: user._id, dedupeKey: "alert-1",
      title_en: "Staff alert", body_en: "Review it", source,
      action: { type: "order_detail", screen: "OrderDetailScreen", params: { orderId: source.referenceId } },
    },
    ...models,
    dispatch: async (payload) => {
      dispatched = payload;
      return { inApp: { success: true }, push: { successCount: 1, failureCount: 0, deviceCount: 1 } };
    },
    markSent: async () => null,
    markDeadLetter: async (payload) => { deadLetter = payload; },
  });
  return { result, dispatched, deadLetter };
}

test("staff delivery rechecks roles, account status, controls, and current warehouse membership", async () => {
  const orderSource = { domain: "order", event: "new_order_placed", referenceId: order._id };
  const videoSource = { domain: "videos", event: "youtube_player_error", referenceId: "video-1" };
  const cases = [
    [{ ...staff[2], active: false }, orderSource, {}, "inactive moderator"],
    [{ ...staff[2], deletedAt: new Date() }, orderSource, {}, "deleted moderator"],
    [{ ...staff[2], account_status: "banned" }, orderSource, {}, "banned moderator"],
    [{ ...staff[2], account_status: "deleted" }, orderSource, {}, "deleted account status"],
    [{ ...staff[2], role: "user" }, orderSource, {}, "wrong role"],
    [staff[2], orderSource, { moderators: ["someone-else"] }, "removed from warehouse"],
    [{ ...staff[1], enabledControls: ["videos"] }, orderSource, {}, "revoked order control"],
    [{ ...staff[1], enabledControls: ["orders"] }, videoSource, {}, "wrong admin control"],
  ];

  for (const [user, source, options, label] of cases) {
    const models = deliveryModels(user, options);
    const { result, dispatched, deadLetter } = await deliverStaffAlert(source, user, models);
    assert.equal(result.status, "dead_letter", label);
    assert.equal(dispatched, undefined, label);
    assert.equal(deadLetter.error.code, "RECIPIENT_INVALID", label);
  }
});

test("eligible order staff receive current owner routing and the existing Android and APNs sounds", async () => {
  const { result, dispatched } = await deliverStaffAlert(
    { domain: "order", event: "new_order_placed", referenceId: order._id },
    staff[2],
    deliveryModels(staff[2]),
  );
  assert.equal(result.status, "sent");
  assert.equal(dispatched.userId, "moderator-1");
  assert.equal(dispatched.guestId, undefined);
  assert.equal(dispatched.action.screen, "OrderDetailScreen");
  assert.equal(dispatched.action.params.orderId, order._id);
  assert.equal(dispatched.pushOptions.android.sound, "petyard_songe");
  assert.equal(dispatched.pushOptions.apns.sound, "petyardSonge.caf");
});

test("eligible video staff keep the videos-control route", async () => {
  const videoAdmin = { ...staff[1], enabledControls: ["videos"] };
  const { result, dispatched } = await deliverStaffAlert(
    { domain: "videos", event: "youtube_player_error", referenceId: "video-1" },
    videoAdmin,
    deliveryModels(videoAdmin),
  );
  assert.equal(result.status, "sent");
  assert.equal(dispatched.userId, videoAdmin._id);
  assert.equal(dispatched.pushOptions, undefined);
});

test("outbox delivery looks up the recipient's current device and builds the existing FCM sound options", async (t) => {
  let deviceFilter;
  let message;
  t.mock.method(NotificationDeviceModel, "distinct", async (field, filter) => {
    assert.equal(field, "token");
    deviceFilter = filter;
    return ["current-token"];
  });
  t.mock.method(InAppNotificationModel, "findOneAndUpdate", async () => ({ _id: "in-app-1" }));
  const messaging = {
    sendEachForMulticast: async (payload) => {
      message = payload;
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    },
  };
  const user = { ...staff[2] };
  const result = await deliverClaimedNotificationOutbox({
    outbox: {
      _id: "outbox-2", leaseToken: "lease-2", attempts: 1,
      recipientUser: user._id, dedupeKey: "order:new_order_placed:order-1:moderator-1",
      title_en: "New Order Placed", body_en: "Review the order",
      action: { type: "order_detail", screen: "OrderDetailScreen", params: { orderId: order._id } },
      source: { domain: "order", event: "new_order_placed", referenceId: order._id },
    },
    ...deliveryModels(user),
    dispatch: (payload) => dispatchNotification({
      ...payload,
      messagingProvider: () => messaging,
    }),
    markSent: async () => null,
  });

  assert.equal(result.status, "sent");
  assert.deepEqual(deviceFilter, { user: user._id });
  assert.deepEqual(message.tokens, ["current-token"]);
  assert.equal(message.android.notification.sound, "petyard_songe");
  assert.equal(message.apns.payload.aps.sound, "petyardSonge.caf");
  assert.equal(message.data.orderId, order._id);
});
