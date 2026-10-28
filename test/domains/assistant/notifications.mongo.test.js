import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantAccount, AssistantEvent, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { initializeAssistantStore, transaction } from "../../../src/domains/assistant/shared/assistant.store.js";
import { processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { submitMessage, getChat, getReviewCandidates, dismissReviewCandidate } from "../../../src/domains/assistant/customer/assistant.service.js";
import { assistantReviewAlertIsCurrent } from "../../../src/domains/assistant/review/assistant.notifications.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { claimNextNotificationOutbox } from "../../../src/domains/notification/notificationOutbox.service.js";
import { deliverClaimedNotificationOutbox } from "../../../src/domains/notification/notificationOutbox.worker.service.js";
import { dispatchNotification } from "../../../src/domains/notification/notificationDispatcher.js";
import { NotificationDeviceModel } from "../../../src/domains/notification/notification.model.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";
import { createInAppNotificationService, getMyNotificationsService, getUnreadCountService,
  markAllNotificationsAsReadService, markNotificationAsReadService, deleteNotificationService } from "../../../src/domains/notification/inAppNotification.service.js";
import { testConfig, reviewOnlyPolicy, structuredReply, knownUsage } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("isolated Mongo review alerts: completion outbox, superAdmin delivery, role revocation, dedupe and fresh episodes", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`;
  let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true;
  t.diagnostic(`assistant_test_database=${database}`);
  await initializeAssistantStore();
  await InAppNotificationModel.createCollection(); await InAppNotificationModel.createIndexes();
  await NotificationDeviceModel.createCollection(); await NotificationDeviceModel.createIndexes();
  const config = testConfig({ reviewPolicy: reviewOnlyPolicy, rateMax: 100, dailyMessageLimit: 100 });
  const owner = new mongoose.Types.ObjectId();
  const roots = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
  const base = { active: true, phoneVerified: true, deletedAt: null, account_status: "confirmed" };
  await UserModel.collection.insertMany([
    { _id: owner, ...base, role: "user" }, ...roots.map((_id) => ({ _id, ...base, role: "superAdmin" })),
    ...[{ role: "admin" }, { role: "moderator" }, { role: "superAdmin", active: false },
      { role: "superAdmin", phoneVerified: false }, { role: "superAdmin", account_status: "banned" },
      { role: "superAdmin", deletedAt: new Date() }].map((extras) => ({ _id: new mongoose.Types.ObjectId(), ...base, ...extras })),
  ]);
  await NotificationDeviceModel.create(roots.map((user, index) => ({ user, token: `fake-root-device-${index}` })));
  await getChat(owner, config);
  async function seedObservations(count, historical = false) {
    await transaction(async (session) => {
      if (!historical) await AssistantAccount.updateOne({ owner }, { $inc: { reviewEvidenceVersion: count } }, { session });
      await AssistantEvent.create(Array.from({ length: count }, () => ({ owner, run: new mongoose.Types.ObjectId(), type: "run_completed",
        createdAt: new Date(Date.now() - (historical ? 1000 : 0)), expiresAt: new Date("2100-01-01"),
        detail: { scope: "off_topic", languageAssessment: "none", languageAssessmentVerified: false } })), { session, ordered: true });
    });
  }
  let calls = 0;
  const options = (policy = config) => ({ getConfig: () => policy, adapterFactory: () => ({ async generate() {
    calls += 1;
    return { structured: structuredReply({ scope: "off_topic", primaryTopic: "off_topic" }), finishReason: "completed",
      toolCalls: [], usage: knownUsage, serviceTier: "default", latencyMs: 1 };
  } }) });
  async function submit(key, policy = config) {
    return (await submitMessage(owner, { text: "private-customer-text unrelated question" }, key, policy)).run.id;
  }
  await seedObservations(4, true);
  const fifth = await submit("notification-fifth");
  await Promise.all([processAssistantRun(fifth, options()), processAssistantRun(fifth, options())]);
  assert.equal(calls, 1); assert.equal((await AssistantRun.findById(fifth)).status, "completed");
  let outboxes = await NotificationOutboxModel.find().lean();
  assert.equal(outboxes.length, 4); assert.deepEqual(outboxes.map((row) => String(row.recipientUser)).sort(), roots.map(String).sort());
  assert.ok(outboxes.every((row) => !row.recipientGuestId && row.action.type === "assistant_review"));
  assert.doesNotMatch(JSON.stringify(outboxes), /private-customer-text|fake-root-device|providerRequestId|diagnos|abuser/i);
  const sixth = await submit("notification-sixth"); await processAssistantRun(sixth, options());
  assert.equal((await AssistantRun.findById(sixth)).status, "completed"); assert.equal(calls, 2);
  assert.equal(await NotificationOutboxModel.countDocuments(), 4, "Repeated signal committed without duplicate-key transaction errors");

  const claimed = [];
  for (let index = 0; index < 4; index += 1) claimed.push(await claimNextNotificationOutbox());
  const byRoot = roots.map((root) => claimed.find((row) => String(row.recipientUser) === String(root)));
  const pushes = []; let firstDeviceFailure = true;
  const messaging = { async sendEachForMulticast(payload) {
    pushes.push(payload);
    if (payload.tokens.includes("fake-root-device-0") && firstDeviceFailure) {
      firstDeviceFailure = false;
      return { successCount: 0, failureCount: 1, responses: [{ success: false, error: { code: "messaging/unavailable" } }] };
    }
    return { successCount: payload.tokens.length, failureCount: 0, responses: payload.tokens.map(() => ({ success: true })) };
  } };
  const delivery = { validateAssistantReview: (row) => assistantReviewAlertIsCurrent(row, { getConfig: () => config }),
    dispatch: (payload) => dispatchNotification({ ...payload, messagingProvider: () => messaging }), baseRetryDelayMs: 1000 };
  assert.equal((await deliverClaimedNotificationOutbox({ outbox: byRoot[0], ...delivery })).status, "retryable");
  assert.equal((await deliverClaimedNotificationOutbox({ outbox: byRoot[1], ...delivery })).status, "sent");
  await UserModel.collection.updateOne({ _id: roots[2] }, { $set: { role: "admin" } });
  assert.equal((await deliverClaimedNotificationOutbox({ outbox: byRoot[2], ...delivery })).status, "dead_letter");
  const retry = await claimNextNotificationOutbox({ now: new Date(Date.now() + 1500) });
  assert.equal(String(retry._id), String(byRoot[0]._id));
  assert.equal((await deliverClaimedNotificationOutbox({ outbox: retry, ...delivery })).status, "sent");
  assert.equal(await InAppNotificationModel.countDocuments({ user: roots[0] }), 1, "Push retry did not duplicate dashboard storage");
  assert.equal(pushes.length, 3); assert.ok(pushes.every((push) => !push.tokens.includes("fake-root-device-2") && !push.tokens.includes("fake-root-device-3")));

  const review = await getReviewCandidates(roots[0], {}, config);
  await dismissReviewCandidate(roots[0], String(owner), { reviewSnapshotId: review.reviewSnapshotId, reason: "Reviewed synthetic case" }, config);
  assert.equal((await deliverClaimedNotificationOutbox({ outbox: byRoot[3], ...delivery })).status, "dead_letter", "Pending dismissed case cannot send");
  assert.equal(pushes.length, 3); assert.equal(await InAppNotificationModel.countDocuments({ user: roots[3] }), 0);

  const privileged = await InAppNotificationModel.findOne({ user: roots[1] }).lean();
  await createInAppNotificationService({ userId: roots[1], title_en: "Ordinary notice", body_en: "Existing behavior", source: { domain: "order", event: "status_changed" } });
  await UserModel.collection.updateOne({ _id: roots[1] }, { $set: { role: "admin" } });
  const ordinary = await getMyNotificationsService({ userId: roots[1], actorRole: "admin" });
  assert.equal(ordinary.results, 1); assert.equal(ordinary.data[0].title, "Ordinary notice");
  assert.equal((await getUnreadCountService(roots[1], "admin")).unreadCount, 1);
  assert.equal((await markNotificationAsReadService({ userId: roots[1], actorRole: "admin", notificationId: privileged._id })).success, false);
  assert.equal((await deleteNotificationService({ userId: roots[1], actorRole: "admin", notificationId: privileged._id })).deleted, false);
  assert.equal((await markAllNotificationsAsReadService(roots[1], "admin")).modifiedCount, 1);
  assert.equal((await InAppNotificationModel.findById(privileged._id)).isRead, false);
  assert.equal((await getMyNotificationsService({ userId: roots[1], actorRole: "superAdmin" })).results, 2, "Authorized role scope includes its owned alert");

  await seedObservations(4);
  const fresh = await submit("notification-new-episode"); await processAssistantRun(fresh, options());
  outboxes = await NotificationOutboxModel.find().lean();
  assert.equal(outboxes.length, 6, "Fresh threshold notifies only the two remaining eligible superAdmins");
  const freshRows = outboxes.filter((row) => !claimed.some((old) => String(old._id) === String(row._id)));
  assert.deepEqual(freshRows.map((row) => String(row.recipientUser)).sort(), [roots[0], roots[3]].map(String).sort());
  assert.ok(freshRows.every((row) => !claimed.some((old) => old.dedupeKey === row.dedupeKey)));

  const changed = testConfig({ reviewPolicy: { ...reviewOnlyPolicy, version: "review-only-v2" }, rateMax: 100, dailyMessageLimit: 100 });
  const failedId = await submit("notification-enqueue-failure", changed);
  const beforeVersion = (await AssistantAccount.findOne({ owner }).lean()).reviewEvidenceVersion;
  const failedEnqueue = t.mock.method(NotificationOutboxModel, "create", async () => { throw new Error("synthetic outbox failure"); });
  await assert.rejects(processAssistantRun(failedId, options(changed)), /synthetic outbox failure/);
  failedEnqueue.mock.restore();
  assert.equal((await AssistantRun.findById(failedId)).status, "dispatching");
  assert.equal((await AssistantRun.findById(failedId)).accounting, "reserved");
  assert.equal(await AssistantEvent.countDocuments({ run: failedId, type: "run_completed" }), 0);
  assert.equal((await AssistantAccount.findOne({ owner }).lean()).reviewEvidenceVersion, beforeVersion);
  assert.equal(await NotificationOutboxModel.countDocuments(), 6);
  const beforeCalls = calls; await processAssistantRun(failedId, options(changed));
  assert.equal(calls, beforeCalls, "Unknown publication outcome did not trigger another provider call");
});
