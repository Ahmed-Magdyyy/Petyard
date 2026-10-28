import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantAccount, AssistantEvent, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { initializeAssistantStore } from "../../../src/domains/assistant/shared/assistant.store.js";
import { getHistory, reviewHistory, reviewObservations } from "../../../src/domains/assistant/customer/assistant.service.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("isolated Mongo chat and observation review audit pages, isolate owners and fail closed on audit failure", {
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
  const config = testConfig();
  const actor = new mongoose.Types.ObjectId(); const owner = new mongoose.Types.ObjectId(); const other = new mongoose.Types.ObjectId();
  await UserModel.collection.insertMany([actor, owner, other].map((_id) => ({ _id, deletedAt: null })));
  await AssistantAccount.create({ owner, blocked: true, dayMessages: 5 });
  const chat = new mongoose.Types.ObjectId();
  const message = (sequence, extras = {}) => ({ _id: new mongoose.Types.ObjectId(), owner, chat, run: new mongoose.Types.ObjectId(),
    role: "user", text: `target message ${sequence}`, sequence, createdAt: new Date(), expiresAt: new Date("2100-01-01"),
    config: { secret: "private-key" }, providerRequestId: "private-provider", ...extras });
  await AssistantMessage.collection.insertMany([message(1), message(2), message(3),
    message(4, { expiresAt: new Date("2000-01-01"), text: "expired secret" }),
    message(99, { owner: other, chat: new mongoose.Types.ObjectId(), text: "foreign secret" })]);
  await assert.rejects(getHistory(owner, {}, config), { code: "ai_restricted" });
  const first = await reviewHistory(actor, String(owner), { limit: 2 }, config);
  assert.equal(first.userId, String(owner)); assert.equal(first.nextBefore, 2);
  assert.deepEqual(first.messages.map((entry) => entry.sequence), [3, 2]);
  assert.doesNotMatch(JSON.stringify(first), /expired secret|foreign secret|private-key|private-provider/);
  const audit = await AssistantEvent.findOne({ owner, type: "admin_chat_reviewed" }).lean();
  assert.equal(String(audit.actor), String(actor));
  assert.deepEqual(audit.detail, { before: null, limit: 2, returnedCount: 2, newestSequence: 3, oldestSequence: 2 });
  assert.ok(audit.expiresAt > new Date()); assert.doesNotMatch(JSON.stringify(audit), /target message|secret|private-provider/);
  const second = await reviewHistory(actor, String(owner), { limit: 2, before: first.nextBefore }, config);
  assert.deepEqual(second.messages.map((entry) => entry.sequence), [1]); assert.equal(second.nextBefore, null);
  const empty = await reviewHistory(actor, String(owner), { limit: 2, before: 1 }, config);
  assert.equal(empty.messages.length, 0); assert.equal(await AssistantEvent.countDocuments({ type: "admin_chat_reviewed" }), 3);
  const missing = String(new mongoose.Types.ObjectId());
  await assert.rejects(reviewHistory(actor, missing, {}, config), { code: "account_not_found" });
  await UserModel.collection.updateOne({ _id: other }, { $set: { deletedAt: new Date() } });
  await assert.rejects(reviewHistory(actor, String(other), {}, config), { code: "account_not_found" });
  assert.equal(await AssistantEvent.countDocuments({ type: "admin_chat_reviewed" }), 3);
  const auditFailure = t.mock.method(AssistantEvent, "create", async () => { throw new Error("synthetic audit failure"); });
  await assert.rejects(reviewHistory(actor, String(owner), {}, config), /synthetic audit failure/);
  auditFailure.mock.restore();
  assert.equal(await AssistantEvent.countDocuments({ type: "admin_chat_reviewed" }), 3, "Failed access did not commit an audit");

  const observation = (detail, extras = {}) => ({ _id: new mongoose.Types.ObjectId(), owner, run: new mongoose.Types.ObjectId(),
    type: "run_completed", createdAt: new Date(), expiresAt: new Date("2100-01-01"), detail, ...extras });
  const legacy = observation({ scope: "unsupported", languageAssessment: "unsupported", secret: "private-detail" });
  const benign = observation({ scope: "urgent", languageAssessment: "distress", languageAssessmentVerified: true });
  const flagged = observation({ scope: "off_topic", languageAssessment: "directed_abuse", text: "private-text" });
  await AssistantEvent.collection.insertMany([legacy, benign, flagged,
    observation({ scope: "off_topic" }, { expiresAt: new Date("2000-01-01") }),
    observation({ scope: "off_topic" }, { owner: other }),
    observation({ scope: "off_topic" }, { type: "provider_charge_uncertain" })]);
  const observations = await reviewObservations(actor, String(owner), { limit: 2 }, config);
  assert.equal(observations.userId, String(owner)); assert.equal(observations.assessment, "model_unreviewed");
  assert.equal(observations.order, "id_desc"); assert.equal(observations.nextBefore, String(benign._id));
  assert.deepEqual(observations.observations.map((entry) => entry.id), [String(flagged._id), String(benign._id)]);
  assert.deepEqual(observations.observations.map((entry) => entry.languageAssessment), ["directed_abuse", "distress"]);
  assert.ok(observations.observations.every((entry) => entry.verified === false));
  assert.equal(observations.observations[0].runId, String(flagged.run));
  assert.deepEqual(Object.keys(observations.observations[0]).sort(),
    ["id", "runId", "createdAt", "expiresAt", "scope", "languageAssessment", "verified"].sort());
  assert.doesNotMatch(JSON.stringify(observations), /private-detail|private-text/);
  const observedAudit = await AssistantEvent.findOne({ owner, type: "admin_observations_reviewed" }).lean();
  assert.equal(String(observedAudit.actor), String(actor));
  assert.deepEqual(observedAudit.detail, { before: null, limit: 2, observationIds: [String(flagged._id), String(benign._id)] });
  const older = await reviewObservations(actor, String(owner), { limit: 2, before: observations.nextBefore }, config);
  assert.equal(older.observations.length, 1); assert.equal(older.nextBefore, null);
  assert.equal(older.observations[0].scope, null); assert.equal(older.observations[0].languageAssessment, null);
  const emptyObservations = await reviewObservations(actor, String(owner), { before: String(legacy._id) }, config);
  assert.deepEqual(emptyObservations.observations, []); assert.equal(emptyObservations.nextBefore, null);
  await assert.rejects(reviewObservations(actor, missing, {}, config), { code: "account_not_found" });
  await assert.rejects(reviewObservations(actor, String(other), {}, config), { code: "account_not_found" });
  assert.equal(await AssistantEvent.countDocuments({ type: "admin_observations_reviewed" }), 3);
  const failedObservationAudit = t.mock.method(AssistantEvent, "create", async () => { throw new Error("synthetic observation audit failure"); });
  await assert.rejects(reviewObservations(actor, String(owner), {}, config), /synthetic observation audit failure/);
  failedObservationAudit.mock.restore();
  assert.equal(await AssistantEvent.countDocuments({ type: "admin_observations_reviewed" }), 3);
  const account = await AssistantAccount.findOne({ owner }).lean();
  assert.equal(account.blocked, true); assert.equal(account.dayMessages, 5, "Review did not change AI access or allowance");
});
