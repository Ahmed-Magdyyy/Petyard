import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueSubstitutionCustomerNotification,
  enqueueSubstitutionRefundNotification,
  enqueueSubstitutionStaffNotification,
  resolveSubstitutionStaffRecipients,
} from "../../../src/domains/substitution/substitution.notification.js";
import {
  deliverClaimedNotificationOutbox,
  drainNotificationOutbox,
} from "../../../src/domains/notification/notificationOutbox.worker.service.js";

const order = {
  _id: "order-1",
  warehouse: "warehouse-a",
  user: "user-1",
  orderNumber: "PY-1",
};
const request = { _id: "request-1" };

test("customer substitution notifications use the exact registered or guest owner and safe order action", async () => {
  const entries = [];
  const enqueue = async (entry) => {
    entries.push(entry);
    return entry;
  };

  await enqueueSubstitutionCustomerNotification({
    order,
    request,
    event: "offered",
    session: "transaction-session",
    enqueue,
  });
  await enqueueSubstitutionCustomerNotification({
    order: { ...order, user: undefined, guestId: "guest-88" },
    request,
    event: "offered",
    enqueue,
  });

  assert.equal(entries[0].recipientUser, "user-1");
  assert.equal(entries[0].recipientGuestId, undefined);
  assert.equal(entries[0].session, "transaction-session");
  assert.equal(
    entries[0].title_en,
    "⚠️ Some items are unavailable. Substitutes are available.",
  );
  assert.equal(
    entries[0].body_en,
    "Unfortunately, some items in your order are unavailable. You can choose substitutes or continue without them. Please review and make your selection.",
  );
  assert.equal(entries[0].title_ar, "⚠️ بعض المنتجات غير متاحة. تتوفر بدائل.");
  assert.equal(
    entries[0].body_ar,
    "للأسف، بعض منتجات طلبك غير متاحة. يمكنك اختيار بدائل لها أو المتابعة بدونها. يُرجى مراجعة العرض وتحديد اختيارك.",
  );
  assert.equal(entries[0].action.screen, "OrderDetailScreen");
  assert.deepEqual(entries[0].action.params, {
    orderId: "order-1",
    substitutionRequestId: "request-1",
  });
  assert.equal(entries[0].dedupeKey, "substitution:request-1:user:user-1:offered");
  assert.equal(entries[1].recipientGuestId, "guest-88");
  assert.equal(entries[1].dedupeKey, "substitution:request-1:guest:guest-88:offered");
  assert.equal(JSON.stringify(entries).match(/token|proof|secret|card/i), null);
});
test("substitution refund notifications describe the completed wallet credit or guest card refund", async () => {
  const entries = [];
  const enqueue = async (entry) => {
    entries.push(entry);
    return entry;
  };

  await enqueueSubstitutionRefundNotification({
    order,
    requestId: request._id,
    amountPiastres: 125,
    method: "wallet",
    session: "transaction-session",
    enqueue,
  });
  await enqueueSubstitutionRefundNotification({
    order: { ...order, user: undefined, guestId: "guest-88" },
    requestId: request._id,
    amountPiastres: 250,
    method: "card",
    enqueue,
  });

  assert.equal(entries[0].recipientUser, "user-1");
  assert.equal(entries[0].dedupeKey, "substitution:request-1:user:user-1:refund_wallet");
  assert.equal(entries[0].icon, "wallet");
  assert.equal(entries[0].title_en, "Refund added to your wallet");
  assert.equal(entries[0].body_en, "1.25 EGP has been added to your wallet for your updated order.");
  assert.deepEqual(entries[0].action.params, {
    orderId: "order-1",
    substitutionRequestId: "request-1",
  });
  assert.equal(entries[1].recipientGuestId, "guest-88");
  assert.equal(entries[1].dedupeKey, "substitution:request-1:guest:guest-88:refund_card");
  assert.equal(entries[1].title_en, "Refund sent to your card");
  assert.match(entries[1].body_en, /2.50 EGP/);
});

test("staff routing is active superadmins, order-enabled admins, and active exact-warehouse moderators only", async () => {
  const filters = [];
  const userModel = {
    find(filter) {
      filters.push(filter);
      const isModeratorLookup = Boolean(filter._id);
      return {
        select: async () =>
          isModeratorLookup
            ? [{ _id: "moderator-a" }]
            : [{ _id: "super-a" }, { _id: "admin-orders-a" }],
      };
    },
  };
  const warehouseModel = {
    findById(id) {
      assert.equal(id, "warehouse-a");
      return { select: async () => ({ moderators: ["moderator-a", "inactive-mod", "super-a"] }) };
    },
  };

  const recipientIds = await resolveSubstitutionStaffRecipients({
    order,
    userModel,
    warehouseModel,
  });
  assert.deepEqual(recipientIds.sort(), ["admin-orders-a", "moderator-a", "super-a"]);
  assert.equal(filters[0].active, true);
  assert.deepEqual(filters[0].$or, [
    { role: "superAdmin" },
    { role: "admin", enabledControls: "orders" },
  ]);
  assert.equal(filters[1].role, "moderator");
  assert.equal(filters[1].active, true);
  assert.deepEqual(filters[1]._id.$in, ["moderator-a", "inactive-mod", "super-a"]);
});

test("staff notifications enqueue one deterministic outbox entry per exact recipient", async () => {
  const entries = [];
  const userModel = {
    find(filter) {
      return {
        select: async () => (filter._id ? [{ _id: "moderator-a" }] : [{ _id: "super-a" }]),
      };
    },
  };
  const warehouseModel = {
    findById: () => ({ select: async () => ({ moderators: ["moderator-a"] }) }),
  };

  const result = await enqueueSubstitutionStaffNotification({
    order,
    request,
    event: "customer_accepted",
    enqueue: async (entry) => {
      entries.push(entry);
      return entry;
    },
    userModel,
    warehouseModel,
  });

  assert.deepEqual(result.recipientUserIds.sort(), ["moderator-a", "super-a"]);
  assert.deepEqual(entries.map((entry) => entry.dedupeKey).sort(), [
    "substitution:request-1:staff:moderator-a:customer_accepted",
    "substitution:request-1:staff:super-a:customer_accepted",
  ]);
});

test("delivery retries a failed push without changing the in-app dedupe key", async () => {
  let dispatched;
  let retry;
  const outbox = {
    _id: "outbox-1",
    leaseToken: "lease-1",
    attempts: 1,
    recipientGuestId: "guest-88",
    dedupeKey: "substitution:request-1:guest:guest-88:offered",
    title_en: "Substitutes are available",
    body_en: "Review your order",
    action: { type: "order_detail", screen: "OrderDetailScreen", params: { orderId: "order-1" } },
    source: { domain: "order", event: "substitution_offered", referenceId: "request-1" },
  };

  const result = await deliverClaimedNotificationOutbox({
    outbox,
    dispatch: async (payload) => {
      dispatched = payload;
      return {
        inApp: { success: true },
        push: { deviceCount: 1, successCount: 0, failureCount: 1 },
      };
    },
    markRetryable: async (payload) => {
      retry = payload;
    },
    markSent: async () => assert.fail("should not mark sent"),
    markDeadLetter: async () => assert.fail("should not dead-letter yet"),
    baseRetryDelayMs: 1_000,
  });

  assert.equal(result.status, "retryable");
  assert.equal(dispatched.guestId, "guest-88");
  assert.equal(dispatched.userId, undefined);
  assert.equal(dispatched.dedupeKey, outbox.dedupeKey);
  assert.equal(retry.retryDelayMs, 1_000);
  assert.equal(retry.outboxId, "outbox-1");
  assert.equal(retry.leaseToken, "lease-1");
});

test("delivery marks terminal provider failures dead-letter and drains unique claims in bounded batches", async () => {
  let deadLetter;
  const terminal = await deliverClaimedNotificationOutbox({
    outbox: { _id: "outbox-2", leaseToken: "lease-2", attempts: 1 },
    dispatch: async () => {
      const error = new Error("invalid recipient");
      error.code = "RECIPIENT_INVALID";
      error.permanent = true;
      throw error;
    },
    markDeadLetter: async (payload) => {
      deadLetter = payload;
    },
  });
  assert.equal(terminal.status, "dead_letter");
  assert.equal(deadLetter.outboxId, "outbox-2");

  const claims = [{ _id: "a", leaseToken: "a" }, { _id: "b", leaseToken: "b" }];
  const delivered = [];
  const summary = await drainNotificationOutbox({
    maxRecords: 5,
    concurrency: 2,
    claim: async () => claims.shift() || null,
    deliver: async ({ outbox }) => {
      delivered.push(outbox._id);
      return { status: "sent" };
    },
  });
  assert.deepEqual(delivered.sort(), ["a", "b"]);
  assert.deepEqual(summary, { claimed: 2, sent: 2, retryable: 0, dead_letter: 0 });
});
