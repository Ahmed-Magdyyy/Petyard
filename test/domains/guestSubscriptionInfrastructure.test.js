import assert from "node:assert/strict";
import test from "node:test";

import { protectUserOrGuest } from "../../src/domains/auth/auth.middleware.js";
import { NotificationDeviceModel } from "../../src/domains/notification/notification.model.js";
import { mergeGuestNotificationDevicesService } from "../../src/domains/notification/notification.service.js";
import { dispatchNotificationToGuests } from "../../src/domains/notification/notificationDispatcher.js";
import { RestockSubscriptionModel } from "../../src/domains/restockSubscription/restockSubscription.model.js";
import { SubcategorySubscriptionModel } from "../../src/domains/subcategorySubscription/subcategorySubscription.model.js";
import mongoose from "mongoose";

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

test("protectUserOrGuest accepts and normalizes x-guest-id", async () => {
  const req = { headers: { "x-guest-id": "  flutter-guest-123  " } };

  await runMiddleware(protectUserOrGuest, req);

  assert.equal(req.guestId, "flutter-guest-123");
  assert.equal(req.user, undefined);
});

test("protectUserOrGuest rejects requests without either identity", async () => {
  await assert.rejects(
    runMiddleware(protectUserOrGuest, { headers: {} }),
    (error) => error.statusCode === 401,
  );
});

test("guest device merge transfers every matching device to the user", async (t) => {
  const calls = [];
  t.mock.method(NotificationDeviceModel, "updateMany", async (...args) => {
    calls.push(args);
    return { modifiedCount: 2 };
  });

  const result = await mergeGuestNotificationDevicesService({
    userId: "user-id",
    guestId: "guest-id",
  });

  assert.deepEqual(result, { mergedCount: 2 });
  assert.deepEqual(calls[0][0], { guestId: "guest-id" });
  assert.equal(calls[0][1].$set.user, "user-id");
  assert.deepEqual(calls[0][1].$unset, { guestId: 1 });
});

test("guest dispatcher is a no-op for an empty identity list", async () => {
  assert.deepEqual(
    await dispatchNotificationToGuests({
      guestIds: [],
      notification: { title_en: "Restocked", body_en: "Available" },
    }),
    { push: null, inApp: null },
  );
});

test("subscription models require exactly one user or guest owner", async () => {
  const product = new mongoose.Types.ObjectId();
  const warehouse = new mongoose.Types.ObjectId();
  const subcategory = new mongoose.Types.ObjectId();

  await new RestockSubscriptionModel({
    guestId: "guest-owner",
    product,
    warehouse,
  }).validate();
  await new SubcategorySubscriptionModel({
    guestId: "guest-owner",
    subcategory,
  }).validate();

  await assert.rejects(
    new RestockSubscriptionModel({ product, warehouse }).validate(),
    /exactly one user or guest/,
  );
  await assert.rejects(
    new SubcategorySubscriptionModel({
      user: new mongoose.Types.ObjectId(),
      guestId: "guest-owner",
      subcategory,
    }).validate(),
    /exactly one of user or guestId/,
  );
});
