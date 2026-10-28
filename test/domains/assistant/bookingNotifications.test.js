import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { bookingReceiptFixture, oid, clone, match } from "./fixtures/bookingReceipts.js";
import { testConfig, testPolicy } from "./fixtures/foundationPolicy.js";
import { AssistantBookingReceipt } from "../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";
import { drainBookingNotifications } from "../../../src/domains/assistant/customer/assistant.booking-notifications.js";
import { deliverClaimedNotificationOutbox } from "../../../src/domains/notification/notificationOutbox.worker.service.js";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { roles, enabledControls } from "../../../src/shared/constants/enums.js";

function fixture(t) {
  const f = bookingReceiptFixture(t); f.outbox = [];
  f.config = { ...testConfig(), bookingNotificationsEnabled: true };
  f.receiptIndexes.push({ key: { notificationPending: 1, notificationAttemptedAt: 1, recordedAt: 1, _id: 1 } });
  f.outboxIndexes = [{ key: { dedupeKey: 1 }, unique: true }];
  f.staff = [roles.SUPER_ADMIN, roles.ADMIN].map(role => ({ _id: oid(), role, active: true, deletedAt: null, account_status: "confirmed", enabledControls: [enabledControls.SERVICE_RESERVATIONS] }));
  t.mock.method(UserModel, "find", filter => f.query(() => f.staff.filter(row => match(row, filter))));
  mongoose.connection.db.collection = name => {
    assert.equal(name, ServiceReservationModel.collection.name);
    return { find(filter, options) {
      assert.equal(options.session, f.session); assert.equal(options.session.active, true);
      assert.deepEqual(options.projection, { _id: 1, status: 1 }); assert.equal(options.limit, 13); assert.equal(options.maxTimeMS, 5000);
      return { async toArray() { return clone(f.reservations.filter(row => match(row, filter))); } };
    } };
  };
  t.mock.method(AssistantBookingReceipt, "find", filter => {
    let limit;
    const query = f.query(() => f.receipts.filter(row => match(row, filter)).sort((a, b) =>
      (a.notificationAttemptedAt?.getTime() ?? 0) - (b.notificationAttemptedAt?.getTime() ?? 0) || String(a._id).localeCompare(String(b._id))).slice(0, limit));
    query.limit = value => { assert.equal(value, 25); limit = value; return query; }; return query;
  });
  t.mock.method(AssistantBookingReceipt, "updateOne", async (filter, update, { session } = {}) => {
    if (session) { assert.equal(session, f.session); assert.equal(session.active, true); }
    const row = f.receipts.find(row => match(row, filter));
    if (!row || f.failClaim && update.$set.notificationPending === false) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, clone(update.$set)); return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(NotificationOutboxModel.collection, "indexes", async () => f.outboxIndexes);
  t.mock.method(NotificationOutboxModel, "findOne", (filter, _projection, options) => f.query(() => f.outbox.find(row => match(row, filter)) ?? null).session(options?.session));
  t.mock.method(NotificationOutboxModel, "create", async ([record], { session }) => {
    assert.equal(session, f.session); assert.equal(session.active, true); f.enqueueCalls = (f.enqueueCalls ?? 0) + 1;
    if (f.failEnqueueAt === f.enqueueCalls) throw new Error("simulated enqueue failure");
    const doc = new NotificationOutboxModel(record); assert.equal(doc.validateSync(), undefined); f.outbox.push(doc.toObject()); return [doc];
  });
  f.drain = () => drainBookingNotifications(f.config);
  return f;
}
test("pending intent queues private-safe alerts and clears atomically without sending", async t => {
  const f = fixture(t); await f.stage(await f.operation());
  const result = await f.drain(); assert.equal(result.queued, 2); assert.equal(result.processed, 1); assert.equal(f.receipts[0].notificationPending, false);
  assert.ok(f.receipts[0].notificationQueuedAt instanceof Date); assert.ok(f.receipts[0].notificationAttemptedAt instanceof Date);
  assert.equal(f.outbox.length, 2); assert.equal(JSON.stringify(f.outbox).includes("PRIVATE"), false);
  for (const row of f.outbox) { assert.equal(row.action.params.reservationId, String(f.reservations[0]._id)); assert.equal(row.source.event, "booking_created"); }
  assert.equal((await f.drain()).queued, 0); assert.equal(f.outbox.length, 2);
});
test("enqueue failure rolls back partial outbox rows and pending flag; retry queues once", async t => {
  const f = fixture(t); await f.stage(await f.operation()); f.failEnqueueAt = 2;
  assert.equal((await f.drain()).failed, 1); assert.equal(f.outbox.length, 0); assert.equal(f.receipts[0].notificationPending, true);
  f.failEnqueueAt = null; assert.equal((await f.drain()).queued, 2); assert.equal(f.outbox.length, 2);
});
test("lost queue commit reply does not cause a second set of notifications", async t => {
  const f = fixture(t); await f.stage(await f.operation()); f.loseResponse = true;
  assert.equal((await f.drain()).failed, 1); assert.equal(f.outbox.length, 2); assert.equal(f.receipts[0].notificationPending, false);
  assert.equal((await f.drain()).queued, 0); assert.equal(f.outbox.length, 2);
});
test("no current staff defers; cancelled/completed bookings are cleared without new alerts", async t => {
  const f = fixture(t); await f.stage(await f.operation()); f.staff = [];
  assert.equal((await f.drain()).deferred, 1); assert.equal(f.receipts[0].notificationPending, true);
  f.reservations[0].status = "CANCELLED"; assert.equal((await f.drain()).processed, 1); assert.equal(f.outbox.length, 0);
});
test("missing/foreign reservations and corrupt receipts remain pending rather than misleading staff", async t => {
  const f = fixture(t); await f.stage(await f.operation()); const owner = f.reservations[0].user;
  f.reservations[0].user = oid(); assert.equal((await f.drain()).failed, 1); assert.equal(f.receipts[0].notificationPending, true);
  f.reservations[0].user = owner; f.reservations[0].status = "UNKNOWN"; assert.equal((await f.drain()).failed, 1); assert.equal(f.receipts[0].notificationPending, true);
  f.reservations[0].status = "BOOKED"; f.receipts[0].resultHash = "b".repeat(64); assert.equal((await f.drain()).failed, 1); assert.equal(f.outbox.length, 0);
});
test("eligible staff rules exclude customers, moderators, banned/deleted and removed controls", async t => {
  const f = fixture(t); await f.stage(await f.operation());
  f.staff.push({ ...clone(f.staff[0]), _id: oid(), role: roles.MODERATOR }, { ...clone(f.staff[1]), _id: oid(), enabledControls: [] },
    { ...clone(f.staff[0]), _id: oid(), account_status: "banned" }, { ...clone(f.staff[0]), _id: oid(), deletedAt: new Date() });
  assert.equal((await f.drain()).queued, 2);
});
test("fanout overflow fails closed and old failed batches rotate behind untouched bookings", async t => {
  const f = fixture(t); await f.stage(await f.operation()); const saved = clone(f.receipts[0]);
  f.staff = Array.from({ length: 101 }, () => ({ ...clone(f.staff[0]), _id: oid() }));
  assert.equal((await f.drain()).failed, 1); assert.equal(f.receipts[0].notificationPending, true); f.staff = [f.staff[0]];
  f.receipts = Array.from({ length: 25 }, () => ({ ...clone(saved), _id: oid(), resultHash: "b".repeat(64) })); f.receipts.push({ ...clone(saved), _id: oid() });
  assert.equal((await f.drain()).failed, 25); assert.equal(f.outbox.length, 0);
  assert.equal((await f.drain()).queued, 1); assert.equal(f.outbox.length, 1);
});
test("notification switch defaults off and requires pending and outbox indexes without DDL", async t => {
  const f = fixture(t); f.config.bookingNotificationsEnabled = false;
  assert.equal((await f.drain()).enabled, false);
  const env = { ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "synthetic", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy()) };
  assert.equal(loadAssistantConfig(env).bookingNotificationsEnabled, false);
  f.config.bookingNotificationsEnabled = true; f.receiptIndexes.pop(); await assert.rejects(f.drain(), { code: "booking_notification_store_unavailable" });
});
test("receipt claim prevents a losing drainer from creating rows and existing dedupe identities are checked", async t => {
  const f = fixture(t); await f.stage(await f.operation()); f.failClaim = true;
  assert.equal((await f.drain()).queued, 0); assert.equal(f.receipts[0].notificationPending, true); f.failClaim = false;
  await f.drain(); f.receipts[0].notificationPending = true; assert.equal((await f.drain()).queued, 0); assert.equal(f.outbox.length, 2);
  f.receipts[0].notificationPending = true; f.outbox[0].recipientUser = oid(); assert.equal((await f.drain()).failed, 1); assert.equal(f.receipts[0].notificationPending, true);
});

function delivery(overrides = {}) {
  const id = String(oid()), recipient = { _id: oid(), active: true, phoneVerified: true, role: roles.ADMIN, enabledControls: [enabledControls.SERVICE_RESERVATIONS] };
  const state = { recipient, status: "BOOKED", calls: [], transitions: [] };
  const query = value => ({ select() { return this; }, maxTimeMS() { return this; }, async lean() { return value(); } });
  state.options = { outbox: { _id: oid(), leaseToken: "test-lease", recipientUser: recipient._id, dedupeKey: "test-key", attempts: 1,
    title_en: "New Service Reservation", body_en: "Review the booking.", source: { domain: "assistant", event: "booking_created", referenceId: id },
    action: { params: { reservationId: id } } },
    userModel: { findById: () => query(() => state.recipient) }, reservationModel: { findById: () => query(() => state.status ? { status: state.status } : null) },
    dispatch: async input => { state.calls.push(input); return { inApp: { success: true }, push: { success: true } }; },
    markSent: async () => state.transitions.push("sent"), markRetryable: async () => state.transitions.push("retryable"), markDeadLetter: async () => state.transitions.push("dead_letter"), ...overrides };
  state.deliver = () => deliverClaimedNotificationOutbox(state.options); return state;
}
test("outbox delivery rechecks service staff and booking status and uses existing staff push options", async () => {
  const f = delivery(); assert.equal((await f.deliver()).status, "sent"); assert.equal(f.calls.length, 1); assert.ok(f.calls[0].pushOptions);
  f.recipient.enabledControls = []; assert.equal((await f.deliver()).status, "dead_letter"); assert.equal(f.calls.length, 1);
});
test("stale booking, removed recipient or mismatched action is permanently suppressed without sending", async () => {
  for (const status of ["CANCELLED", "COMPLETED", "NO_SHOW", null]) { const f = delivery(); f.status = status; assert.equal((await f.deliver()).status, "dead_letter"); assert.equal(f.calls.length, 0); }
  const f = delivery(); f.options.outbox.action.params.reservationId = String(oid()); assert.equal((await f.deliver()).status, "dead_letter"); assert.equal(f.calls.length, 0);
});
test("delivery failure retains the existing retry path instead of reporting sent", async () => {
  const f = delivery({ dispatch: async () => { throw new Error("simulated provider failure"); } });
  assert.equal((await f.deliver()).status, "retryable"); assert.deepEqual(f.transitions, ["retryable"]);
});
test("default delivery status lookup uses a bounded native read of the existing collection", async t => {
  const f = delivery({ reservationModel: undefined }), previous = mongoose.connection.db;
  mongoose.connection.db = { collection(name) {
    assert.equal(name, ServiceReservationModel.collection.name);
    return { async findOne(filter, options) {
      assert.equal(String(filter._id), f.options.outbox.source.referenceId);
      assert.deepEqual(options, { projection: { status: 1 }, maxTimeMS: 5000 });
      return { status: f.status };
    } };
  } };
  t.after(() => { mongoose.connection.db = previous; });
  assert.equal((await f.deliver()).status, "sent"); assert.equal(f.calls.length, 1);
});
