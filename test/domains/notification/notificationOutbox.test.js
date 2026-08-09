import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import {
  claimNextNotificationOutbox,
  enqueueNotificationOutbox,
  markNotificationOutboxDeadLetter,
  markNotificationOutboxRetryable,
  markNotificationOutboxSent,
} from "../../../src/domains/notification/notificationOutbox.service.js";
import {
  markGuestNotificationAsReadService,
} from "../../../src/domains/notification/inAppNotification.service.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";

function notificationInput(overrides = {}) {
  return {
    recipientGuestId: "guest-123",
    dedupeKey: "substitution:request-1:guest-123:offered",
    title_en: "Substitutes are available",
    body_en: "Review the alternatives for your order.",
    action: {
      type: "order_detail",
      screen: "OrderDetailScreen",
      params: { orderId: "507f1f77bcf86cd799439011" },
    },
    source: { domain: "order", event: "substitution_offered", referenceId: "request-1" },
    ...overrides,
  };
}

test("notification outbox model requires exactly one recipient", async () => {
  const userId = new mongoose.Types.ObjectId();
  const both = new NotificationOutboxModel(notificationInput({ recipientUser: userId }));
  const neither = new NotificationOutboxModel(notificationInput({ recipientGuestId: undefined }));

  await assert.rejects(both.validate(), /Exactly one outbox recipient/);
  await assert.rejects(neither.validate(), /Exactly one outbox recipient/);
});

test("enqueue rejects unsafe action payloads before persistence", async () => {
  let persisted = false;
  const model = {
    create: async () => {
      persisted = true;
      return [];
    },
  };

  await assert.rejects(
    enqueueNotificationOutbox({
      ...notificationInput({ action: { params: { proofUrl: "https://private.example/proof" } } }),
      model,
    }),
    (error) => error.statusCode === 400 && error.code === "UNSAFE_NOTIFICATION_PAYLOAD",
  );
  assert.equal(persisted, false);
});

test("enqueue returns the existing document when the dedupe key races", async () => {
  const existing = { _id: "outbox-1", dedupeKey: notificationInput().dedupeKey };
  const duplicate = Object.assign(new Error("duplicate"), { code: 11000 });
  const model = {
    create: async () => {
      throw duplicate;
    },
    findOne: async (filter) => {
      assert.deepEqual(filter, { dedupeKey: existing.dedupeKey });
      return existing;
    },
  };

  const result = await enqueueNotificationOutbox({ ...notificationInput(), model });
  assert.equal(result, existing);
});

test("claim can reclaim an expired processing lease and creates a fresh fence", async () => {
  let captured;
  const now = new Date("2026-07-29T10:00:00.000Z");
  const model = {
    findOneAndUpdate: async (filter, update, options) => {
      captured = { filter, update, options };
      return { _id: "outbox-1", leaseToken: update.$set.leaseToken };
    },
  };

  const claimed = await claimNextNotificationOutbox({ now, leaseMs: 30_000, model });
  const reclaimBranch = captured.filter.$or.find(
    (branch) => branch.status === "processing",
  );

  assert.deepEqual(reclaimBranch.leaseExpiresAt, { $lte: now });
  assert.equal(captured.update.$inc.attempts, 1);
  assert.equal(captured.update.$set.status, "processing");
  assert.equal(claimed.leaseToken, captured.update.$set.leaseToken);
  assert.notEqual(captured.update.$set.leaseToken, "");
});

test("sent, retry, and dead-letter transitions are fenced by processing lease", async () => {
  const calls = [];
  const model = {
    findOneAndUpdate: async (filter, update) => {
      calls.push({ filter, update });
      return null;
    },
  };
  const args = { outboxId: "outbox-1", leaseToken: "current-lease", model };

  assert.equal(await markNotificationOutboxSent(args), null);
  assert.equal(
    await markNotificationOutboxRetryable({
      ...args,
      error: { code: "FCM_UNAVAILABLE", message: "https://provider.example/token=secret" },
      retryDelayMs: 5_000,
      now: new Date("2026-07-29T10:00:00.000Z"),
    }),
    null,
  );
  assert.equal(
    await markNotificationOutboxDeadLetter({
      ...args,
      error: { code: "PERMANENT_FAILURE", message: "cannot deliver" },
    }),
    null,
  );

  for (const call of calls) {
    assert.deepEqual(call.filter, {
      _id: "outbox-1",
      status: "processing",
      leaseToken: "current-lease",
    });
  }
  assert.equal(calls[1].update.$set.lastErrorCode, "FCM_UNAVAILABLE");
  assert.match(calls[1].update.$set.lastErrorMessage, /redacted-url/);
  assert.ok(calls[2].update.$set.deadLetteredAt instanceof Date);
});

test("guest notification mutations are owner-scoped and opaque", async (t) => {
  let filter;
  t.mock.method(InAppNotificationModel, "findOneAndUpdate", async (candidate) => {
    filter = candidate;
    return null;
  });

  const result = await markGuestNotificationAsReadService({
    guestId: "guest-a",
    notificationId: "507f1f77bcf86cd799439011",
  });

  assert.deepEqual(result, { success: false });
  assert.deepEqual(filter, {
    _id: "507f1f77bcf86cd799439011",
    guestId: "guest-a",
  });
});
