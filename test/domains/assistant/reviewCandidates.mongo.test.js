import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantAccount, AssistantBudget, AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { initializeAssistantStore, transaction } from "../../../src/domains/assistant/shared/assistant.store.js";
import { getReviewCandidates } from "../../../src/domains/assistant/review/assistant.review-candidates.js";
import { dismissReviewCandidate } from "../../../src/domains/assistant/review/assistant.review-dismissals.js";
import { testConfig, reviewOnlyPolicy } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("isolated Mongo review candidates deduplicate rules, respect exclusions/window and audit without enforcing", {
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
  const config = testConfig({ reviewPolicy: reviewOnlyPolicy });
  const now = new Date("2026-10-19T12:00:00Z"); const start = new Date(now.getTime() - 86400_000);
  const actor = new mongoose.Types.ObjectId();
  const id = (value) => new mongoose.Types.ObjectId(String(value).padStart(24, "0"));
  const deleted = id(5), off = id(10), missing = id(15), directed = id(20), below = id(30), both = id(40), inactive = id(50);
  await UserModel.collection.insertMany([actor, deleted, off, directed, below, both, inactive].map((_id) => ({
    _id, deletedAt: String(_id) === String(deleted) ? new Date("2026-01-01") : null,
    active: String(_id) !== String(inactive), email: `${_id}@private-email.test`, name: "private-name",
  })));
  await AssistantAccount.create({ owner: off, blocked: true, dayMessages: 9 });
  await AssistantBudget.create({ _id: "unchanged-test-budget", periodEnd: new Date("2100-01-01"), spent: 123, reserved: 45 });
  const event = (owner, scope = "off_topic", language = "none", extras = {}) => ({
    _id: new mongoose.Types.ObjectId(), owner, run: new mongoose.Types.ObjectId(), type: "run_completed",
    createdAt: new Date(now.getTime() - 3600_000), expiresAt: new Date("2100-01-01"),
    detail: { scope, languageAssessment: language, languageAssessmentVerified: false, privateText: "private-evidence" }, ...extras,
  });
  const repeatedOff = Array.from({ length: 5 }, () => event(off)); repeatedOff[0].createdAt = start;
  const belowDirect = [event(below, "pet_care", "directed_abuse"), event(below, "pet_care", "directed_abuse")];
  const excluded = ["casual_profanity", "quoted", "distress", "uncertain", "unsupported"].map((label) => event(off, "off_topic", label));
  await AssistantEvent.collection.insertMany([
    ...repeatedOff, ...Array.from({ length: 4 }, () => ({ ...event(off), run: repeatedOff[0].run, createdAt: start })),
    ...Array.from({ length: 3 }, () => event(directed, "health", "directed_abuse")),
    ...Array.from({ length: 4 }, () => event(below)), ...belowDirect,
    ...Array.from({ length: 4 }, () => ({ ...event(below, "pet_care", "directed_abuse"), run: belowDirect[0].run })),
    ...Array.from({ length: 5 }, (_, index) => event(both, "off_topic", index < 3 ? "directed_abuse" : "none")),
    ...[deleted, missing, inactive].flatMap((owner) => Array.from({ length: 5 }, () => event(owner))),
    ...excluded, event(off, "identity", "directed_abuse"), event(off, "unsupported", "directed_abuse"),
    event(off, "off_topic", "none", { createdAt: new Date(start.getTime() - 1) }),
    event(off, "off_topic", "none", { createdAt: now }),
    event(off, "off_topic", "none", { expiresAt: now }),
    event(off, "off_topic", "none", { type: "run_failed_after_dispatch" }),
    event(off, "off_topic", "none", { run: null }), event(off, "off_topic", "none", { run: [new mongoose.Types.ObjectId()] }),
    event(off, "off_topic", "none", { detail: { scope: "off_topic", languageAssessment: "none" } }),
    event(off, "off_topic", "none", { detail: { scope: "off_topic", languageAssessment: "none", languageAssessmentVerified: true } }),
  ]);

  const first = await getReviewCandidates(actor, { limit: 2 }, config, now);
  assert.match(first.reviewSnapshotId, /^[a-f\d]{24}$/);
  assert.deepEqual(first.policy, reviewOnlyPolicy);
  assert.equal(first.generatedAt, now.toISOString());
  assert.deepEqual(first.window, { start: start.toISOString(), endExclusive: now.toISOString() });
  assert.deepEqual(first.candidates.map((candidate) => candidate.userId), [String(off), String(directed)]);
  assert.equal(first.nextAfter, String(directed));
  assert.deepEqual(first.candidates[0].counts, { offTopic: 5, directedAbuse: 0 });
  assert.deepEqual(first.candidates[0].matchedRules, [{ id: "repeated_off_topic", observedCount: 5, threshold: 5 }]);
  assert.equal(first.candidates[0].oldestObservationAt, start.toISOString());
  assert.deepEqual(first.candidates[1].matchedRules, [{ id: "repeated_directed_abuse", observedCount: 3, threshold: 3 }]);
  assert.equal(first.candidates[1].assessment, "needs_human_review");
  assert.doesNotMatch(JSON.stringify(first), /private-email|private-name|private-evidence|privateText|providerRequestId/);

  const second = await getReviewCandidates(actor, { limit: 2, after: first.nextAfter }, config, now);
  assert.deepEqual(second.candidates.map((candidate) => candidate.userId), [String(both), String(inactive)]);
  assert.deepEqual(second.candidates[0].counts, { offTopic: 5, directedAbuse: 3 });
  assert.equal(second.candidates[0].matchedRules.length, 2); assert.equal(second.nextAfter, null);
  const empty = await getReviewCandidates(actor, { after: String(inactive) }, config, now);
  assert.deepEqual(empty.candidates, []); assert.equal(empty.nextAfter, null);
  const audits = await AssistantEvent.find({ type: "admin_review_candidates_viewed" }).sort({ _id: 1 }).lean();
  assert.equal(audits.length, 3); assert.equal(String(audits[0].owner), String(actor));
  assert.equal(String(audits[0].actor), String(actor));
  assert.deepEqual(audits[0].detail.candidateUserIds, [String(off), String(directed)]);
  assert.equal(audits[0].detail.policyVersion, reviewOnlyPolicy.version);
  assert.doesNotMatch(JSON.stringify(audits), /private-evidence|private-email|private-name/);
  const auditFailure = t.mock.method(AssistantEvent, "create", async () => { throw new Error("synthetic candidate audit failure"); });
  await assert.rejects(getReviewCandidates(actor, {}, config, now), /synthetic candidate audit failure/);
  auditFailure.mock.restore();
  assert.equal(await AssistantEvent.countDocuments({ type: "admin_review_candidates_viewed" }), 3);
  const account = await AssistantAccount.findOne({ owner: off }).lean();
  assert.equal(account.blocked, true); assert.equal(account.dayMessages, 9);
  assert.equal(await AssistantAccount.countDocuments(), 1, "Detection created no restrictions/accounts");
  const budget = await AssistantBudget.findById("unchanged-test-budget").lean();
  assert.equal(budget.spent, 123); assert.equal(budget.reserved, 45);

  const dismissal = { reviewSnapshotId: first.reviewSnapshotId, reason: "Reviewed synthetic context" };
  await assert.rejects(dismissReviewCandidate(new mongoose.Types.ObjectId(), String(off), dismissal, config, now), { code: "review_snapshot_unavailable" });
  await assert.rejects(dismissReviewCandidate(actor, String(off), { ...dismissal, reviewSnapshotId: second.reviewSnapshotId }, config, now), { code: "review_snapshot_unavailable" });
  await assert.rejects(dismissReviewCandidate(actor, String(missing), dismissal, config, now), { code: "account_not_found" });
  await assert.rejects(dismissReviewCandidate(actor, String(deleted), dismissal, config, now), { code: "account_not_found" });
  const changedPolicy = testConfig({ reviewPolicy: { ...reviewOnlyPolicy, offTopicThreshold: 6 } });
  await assert.rejects(dismissReviewCandidate(actor, String(off), dismissal, changedPolicy, now), { code: "review_snapshot_unavailable" });
  const originalSnapshot = await AssistantEvent.findById(first.reviewSnapshotId).lean();
  const expiredSnapshot = new mongoose.Types.ObjectId();
  await AssistantEvent.collection.insertOne({ ...originalSnapshot, _id: expiredSnapshot, expiresAt: now });
  await assert.rejects(dismissReviewCandidate(actor, String(off), { ...dismissal, reviewSnapshotId: String(expiredSnapshot) }, config, now), { code: "review_snapshot_unavailable" });
  const failedDecisionAudit = t.mock.method(AssistantEvent, "create", async () => { throw new Error("synthetic dismissal audit failure"); });
  await assert.rejects(dismissReviewCandidate(actor, String(off), dismissal, config, now), /synthetic dismissal audit failure/);
  failedDecisionAudit.mock.restore();
  assert.equal((await AssistantAccount.findOne({ owner: off }).lean()).reviewDismissedBefore, undefined, "Audit failure rolled back the cutoff");
  const saved = await dismissReviewCandidate(actor, String(off), dismissal, config, now);
  assert.equal(saved.advanced, true); assert.equal(saved.dismissedBefore, now.toISOString());
  const decision = await AssistantEvent.findById(saved.decisionId).lean();
  assert.equal(decision.type, "admin_review_dismissed"); assert.equal(String(decision.actor), String(actor));
  assert.equal(String(decision.owner), String(off)); assert.equal(decision.detail.reason, dismissal.reason);
  const repeated = await dismissReviewCandidate(actor, String(off), dismissal, config, now);
  assert.equal(repeated.advanced, false); assert.equal(repeated.dismissedBefore, saved.dismissedBefore);
  assert.equal((await getReviewCandidates(actor, {}, config, now)).candidates.some((entry) => entry.userId === String(off)), false);

  async function completeObservations(records) {
    await transaction(async (session) => {
      await AssistantAccount.updateOne({ owner: off }, { $inc: { reviewEvidenceVersion: records.length } }, { session });
      await AssistantEvent.collection.insertMany(records, { session });
    });
  }
  const later = new Date(now.getTime() + 60000);
  await completeObservations([
    ...Array.from({ length: 3 }, () => event(off, "off_topic", "none", { createdAt: new Date(now.getTime() + 1000) })),
    event(off, "off_topic", "none", { createdAt: new Date(now.getTime() + 500), run: repeatedOff[1].run }),
  ]);
  assert.equal((await getReviewCandidates(actor, {}, config, later)).candidates.some((entry) => entry.userId === String(off)), false,
    "Old evidence/duplicate run plus four fresh observations cannot trigger five");
  await completeObservations([event(off, "off_topic", "none", { createdAt: new Date(now.getTime() + 2000) })]);
  const fresh = await getReviewCandidates(actor, {}, config, later);
  assert.equal(fresh.candidates.find((entry) => entry.userId === String(off)).counts.offTopic, 5);
  // Even an observation timestamped before the snapshot must not be silently discarded if it committed later.
  await completeObservations([event(off, "off_topic", "none", { createdAt: new Date(later.getTime() - 1) })]);
  const laterNow = new Date(later.getTime() + 1000);
  await assert.rejects(dismissReviewCandidate(actor, String(off), { ...dismissal, reviewSnapshotId: fresh.reviewSnapshotId }, config, laterNow),
    { code: "review_snapshot_stale" });
  assert.equal((await AssistantAccount.findOne({ owner: off }).lean()).reviewDismissedBefore.toISOString(), now.toISOString());

  const racing = await getReviewCandidates(actor, {}, config, laterNow);
  const originalFind = AssistantAccount.findOne.bind(AssistantAccount); let injected = false;
  const race = t.mock.method(AssistantAccount, "findOne", (...args) => {
    const query = originalFind(...args); const originalLean = query.lean.bind(query);
    query.lean = async (...leanArgs) => {
      const record = await originalLean(...leanArgs);
      if (!injected) {
        injected = true;
        await completeObservations([event(off, "off_topic", "none", { createdAt: new Date(laterNow.getTime() - 1) })]);
      }
      return record;
    };
    return query;
  });
  await assert.rejects(dismissReviewCandidate(actor, String(off), { ...dismissal, reviewSnapshotId: racing.reviewSnapshotId }, config,
    new Date(laterNow.getTime() + 1000)), { code: "review_snapshot_stale" });
  race.mock.restore(); assert.equal(injected, true);
  const currentNow = new Date(laterNow.getTime() + 2000);
  const current = await getReviewCandidates(actor, {}, config, currentNow);
  const concurrentBody = { ...dismissal, reviewSnapshotId: current.reviewSnapshotId };
  const concurrent = await Promise.all([dismissReviewCandidate(actor, String(off), concurrentBody, config, currentNow),
    dismissReviewCandidate(actor, String(off), concurrentBody, config, currentNow)]);
  assert.equal(concurrent.filter((result) => result.advanced).length, 1);
  const older = await dismissReviewCandidate(actor, String(off), dismissal, config, currentNow);
  assert.equal(older.advanced, false); assert.equal(older.dismissedBefore, currentNow.toISOString());
  const final = await getReviewCandidates(actor, {}, config, currentNow);
  assert.equal(final.candidates.some((entry) => entry.userId === String(off)), false);
  assert.ok(final.candidates.some((entry) => entry.userId === String(both)), "Dismissal isolates its target account");
  const afterReview = await AssistantAccount.findOne({ owner: off }).lean();
  assert.equal(afterReview.blocked, true); assert.equal(afterReview.dayMessages, 9); assert.equal(afterReview.activeRun, null);
  assert.equal(afterReview.restrictionVersion, 0);
  const afterBudget = await AssistantBudget.findById("unchanged-test-budget").lean();
  assert.equal(afterBudget.spent, 123); assert.equal(afterBudget.reserved, 45);
});
