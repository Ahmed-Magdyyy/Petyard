import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { assistantReviewAlertIsCurrent, enqueueAssistantReviewAlerts, reviewNotificationKey } from "../../../src/domains/assistant/review/assistant.notifications.js";
import { deliverClaimedNotificationOutbox } from "../../../src/domains/notification/notificationOutbox.worker.service.js";
import { dispatchNotification } from "../../../src/domains/notification/notificationDispatcher.js";
import { NotificationDeviceModel } from "../../../src/domains/notification/notification.model.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";
import notificationRouter from "../../../src/domains/notification/notification.routes.js";
import { testConfig, reviewOnlyPolicy } from "./fixtures/foundationPolicy.js";

const owner = new mongoose.Types.ObjectId(); const recipient = new mongoose.Types.ObjectId();
const config = testConfig({ reviewPolicy: reviewOnlyPolicy });
const source = { domain: "assistant", event: "review_candidate", referenceId: String(owner) };
const root = { _id: recipient, role: "superAdmin", active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed" };
const query = (value) => ({ select() { return this; }, async lean() { return value; } });

test("review alert dedupe binds account, recipient, full policy and dismissal period", () => {
  const first = reviewNotificationKey(owner, reviewOnlyPolicy, new Date(0), recipient);
  assert.equal(first, reviewNotificationKey(owner, { ...reviewOnlyPolicy }, new Date(0), recipient));
  for (const key of [reviewNotificationKey(new mongoose.Types.ObjectId(), reviewOnlyPolicy, new Date(0), recipient),
    reviewNotificationKey(owner, reviewOnlyPolicy, new Date(0), new mongoose.Types.ObjectId()),
    reviewNotificationKey(owner, reviewOnlyPolicy, new Date(1), recipient),
    reviewNotificationKey(owner, { ...reviewOnlyPolicy, offTopicThreshold: 6 }, new Date(0), recipient)]) assert.notEqual(key, first);
});

test("ordinary/excluded observations make no review query, and disabled alerts do not query or dispatch", async (t) => {
  t.mock.method(AssistantEvent, "aggregate", () => { throw new Error("must not query"); });
  for (const signal of [{ scope: "pet_care", languageAssessment: "none" }, { scope: "identity", languageAssessment: "directed_abuse" },
    ...["casual_profanity", "quoted", "distress", "uncertain"].map((languageAssessment) => ({ scope: "off_topic", languageAssessment }))]) {
    await enqueueAssistantReviewAlerts({ owner, signal, config, session: null });
  }
  await enqueueAssistantReviewAlerts({ owner, signal: { scope: "off_topic", languageAssessment: "none" }, config: testConfig(), session: null });
  assert.equal(await assistantReviewAlertIsCurrent({ source }, { getConfig: () => ({ enabled: false }) }), false);
  assert.equal(await assistantReviewAlertIsCurrent({ source: { ...source, referenceId: "invalid" } }, { getConfig: () => config }), false);
});

test("delivery validity rejects old episodes, policies and absent candidates", async (t) => {
  let row = { dismissedBefore: new Date(0) };
  t.mock.method(AssistantEvent, "aggregate", (pipeline) => {
    assert.equal(String(pipeline[0].$match.owner), String(owner));
    return { session() { return this; }, async option() { return row ? [row] : []; } };
  });
  const outbox = { source, recipientUser: recipient, dedupeKey: reviewNotificationKey(owner, reviewOnlyPolicy, new Date(0), recipient) };
  assert.equal(await assistantReviewAlertIsCurrent(outbox, { getConfig: () => config }), true);
  assert.equal(await assistantReviewAlertIsCurrent(outbox, { getConfig: () => testConfig({ reviewPolicy: { ...reviewOnlyPolicy, version: "new-version" } }) }), false);
  row = { dismissedBefore: new Date(1) };
  assert.equal(await assistantReviewAlertIsCurrent(outbox, { getConfig: () => config }), false);
  row = null; assert.equal(await assistantReviewAlertIsCurrent(outbox, { getConfig: () => config }), false);
});

test("delivery rechecks superAdmin role, active status, phone and current evidence before both channels", async () => {
  const outbox = { _id: "outbox", leaseToken: "lease", attempts: 1, recipientUser: recipient, dedupeKey: "episode", source };
  const deliver = async (user, current = true) => {
    let sent = 0; let checked = 0;
    const result = await deliverClaimedNotificationOutbox({ outbox, userModel: { findById: () => query(user) },
      validateAssistantReview: async () => { checked += 1; return current; },
      dispatch: async (payload) => { sent += 1; assert.deepEqual(payload.channels, { push: true, inApp: true });
        return { inApp: { success: true }, push: { deviceCount: 1, successCount: 1, failureCount: 0 } }; },
      markSent: async () => {}, markDeadLetter: async () => {},
    });
    return { result, sent, checked };
  };
  for (const user of [null, ...["user", "admin", "moderator"].map((role) => ({ ...root, role })),
    { ...root, active: false }, { ...root, deletedAt: new Date() }, { ...root, account_status: "banned" }, { ...root, phoneVerified: false }]) {
    const result = await deliver(user); assert.equal(result.result.status, "dead_letter"); assert.equal(result.sent, 0); assert.equal(result.checked, 0);
  }
  assert.equal((await deliver(root, false)).sent, 0);
  assert.equal((await deliver(root)).result.status, "sent");
  let retried = false;
  const failed = await deliverClaimedNotificationOutbox({ outbox, userModel: { findById: () => query(root) },
    validateAssistantReview: async () => { throw new Error("synthetic database failure"); },
    dispatch: async () => { throw new Error("must not dispatch"); }, markRetryable: async () => { retried = true; },
  });
  assert.equal(failed.status, "retryable"); assert.equal(retried, true);
});

test("existing dispatcher retries fake push with one dashboard record, safe payload and exact recipient device", async (t) => {
  let calls = 0; const stored = new Map();
  t.mock.method(NotificationDeviceModel, "distinct", async (_field, filter) => {
    assert.deepEqual(filter, { user: recipient }); return ["fake-superadmin-device"];
  });
  t.mock.method(InAppNotificationModel, "findOneAndUpdate", async (filter, update) => {
    if (!stored.has(filter.dedupeKey)) stored.set(filter.dedupeKey, update.$setOnInsert);
    return { _id: "in-app" };
  });
  const outbox = { _id: "outbox", leaseToken: "lease", attempts: 1, recipientUser: recipient, dedupeKey: "episode", source,
    title_en: "AI assistant review needed", body_en: "Open the dashboard to review current evidence.",
    action: { type: "assistant_review", screen: "AssistantReviewScreen" } };
  const messaging = { async sendEachForMulticast(payload) {
    calls += 1; assert.deepEqual(payload.tokens, ["fake-superadmin-device"]);
    assert.equal(payload.data.type, "assistant_review"); assert.equal(payload.data.referenceId, String(owner));
    assert.doesNotMatch(JSON.stringify(payload.notification), /pet name|medical|provider|model|abuser/i);
    return calls === 1 ? { successCount: 0, failureCount: 1, responses: [{ success: false, error: { code: "messaging/unavailable" } }] }
      : { successCount: 1, failureCount: 0, responses: [{ success: true }] };
  } };
  const options = { outbox, userModel: { findById: () => query(root) }, validateAssistantReview: async () => true,
    dispatch: (payload) => dispatchNotification({ ...payload, messagingProvider: () => messaging }),
    markSent: async () => {}, markRetryable: async () => {} };
  assert.equal((await deliverClaimedNotificationOutbox(options)).status, "retryable");
  assert.equal((await deliverClaimedNotificationOutbox(options)).status, "sent");
  assert.equal(calls, 2); assert.equal(stored.size, 1);
});

test("notification HTTP derives role from current auth, hiding alerts after demotion across all operations", async (t) => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "notification-visibility-test";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; });
  const user = { ...root }; const filters = [];
  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(InAppNotificationModel, "find", (filter) => {
    filters.push(filter); return { sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return []; } };
  });
  t.mock.method(InAppNotificationModel, "countDocuments", async (filter) => { filters.push(filter); return 0; });
  t.mock.method(InAppNotificationModel, "findOneAndUpdate", async (filter) => { filters.push(filter); return null; });
  t.mock.method(InAppNotificationModel, "updateMany", async (filter) => { filters.push(filter); return { modifiedCount: 0 }; });
  t.mock.method(InAppNotificationModel, "deleteOne", async (filter) => { filters.push(filter); return { deletedCount: 0 }; });
  const app = express(); app.use(express.json()); app.use("/notifications", notificationRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: "unavailable" }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/notifications/me`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(recipient) }, process.env.JWT_ACCESS_SECRET)}` };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200); assert.ok(filters.every((filter) => filter.$nor === undefined));
  for (const role of ["user", "admin", "moderator"]) {
    user.role = role; filters.length = 0;
    for (const [path, method, status] of [["?actorRole=superAdmin", "GET", 200], ["/unread-count", "GET", 200],
      [`/${owner}/read`, "PATCH", 404], ["/read-all", "PATCH", 200], [`/${owner}`, "DELETE", 404]]) {
      assert.equal((await fetch(base + path, { headers, method })).status, status);
    }
    assert.ok(filters.every((filter) => String(filter.user) === String(recipient) &&
      filter.$nor?.[0]?.["source.domain"] === "assistant" && filter.$nor[0]["source.event"] === "review_candidate"));
  }
});
