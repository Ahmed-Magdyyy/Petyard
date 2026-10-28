import { UserModel } from "../../user/user.model.js";
import { AssistantAccount, AssistantEvent } from "../shared/assistant.models.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { event, transaction } from "../shared/assistant.store.js";
import { fields, objectId, page } from "../shared/assistant.validation.js";

export function reviewCandidatesPipeline(policy, { start, endExclusive }, after, limit, owner = null) {
  const offTopic = { $eq: ["$detail.scope", "off_topic"] };
  const directedAbuse = { $eq: ["$detail.languageAssessment", "directed_abuse"] };
  return [
    { $match: { type: "run_completed", createdAt: { $gte: start, $lt: endExclusive }, expiresAt: { $gt: endExclusive },
      ...(owner ? { owner } : after ? { owner: { $gt: after } } : {}),
      $expr: { $and: [
        { $eq: [{ $type: "$owner" }, "objectId"] }, { $eq: [{ $type: "$run" }, "objectId"] },
        { $eq: [{ $type: "$createdAt" }, "date"] }, { $eq: [{ $type: "$expiresAt" }, "date"] },
        { $eq: ["$detail.languageAssessmentVerified", false] },
        { $in: ["$detail.scope", ["pet_care", "petyard", "health", "urgent", "off_topic"]] },
        { $in: ["$detail.languageAssessment", ["none", "directed_abuse"]] },
        { $or: [offTopic, directedAbuse] },
      ] } } },
    { $project: { owner: 1, run: 1, createdAt: 1, "detail.scope": 1, "detail.languageAssessment": 1 } },
    { $group: { _id: { owner: "$owner", run: "$run" },
      offTopic: { $max: { $cond: [offTopic, 1, 0] } }, directedAbuse: { $max: { $cond: [directedAbuse, 1, 0] } },
      oldest: { $min: "$createdAt" }, newest: { $max: "$createdAt" } } },
    { $lookup: { from: AssistantAccount.collection.name, localField: "_id.owner", foreignField: "owner",
      pipeline: [{ $project: { reviewDismissedBefore: 1, reviewEvidenceVersion: 1 } }], as: "review" } },
    { $set: { dismissedBefore: { $ifNull: [{ $arrayElemAt: ["$review.reviewDismissedBefore", 0] }, new Date(0)] },
      reviewEvidenceVersion: { $ifNull: [{ $arrayElemAt: ["$review.reviewEvidenceVersion", 0] }, 0] } } },
    { $match: { $expr: { $gte: ["$oldest", "$dismissedBefore"] } } },
    { $group: { _id: "$_id.owner", offTopic: { $sum: "$offTopic" }, directedAbuse: { $sum: "$directedAbuse" },
      oldest: { $min: "$oldest" }, newest: { $max: "$newest" }, reviewEvidenceVersion: { $max: "$reviewEvidenceVersion" },
      dismissedBefore: { $max: "$dismissedBefore" } } },
    { $match: { $or: [{ offTopic: { $gte: policy.offTopicThreshold } }, { directedAbuse: { $gte: policy.directedAbuseThreshold } }] } },
    { $lookup: { from: UserModel.collection.name, localField: "_id", foreignField: "_id",
      pipeline: [{ $match: { deletedAt: null } }, { $project: { _id: 1 } }], as: "account" } },
    { $match: { "account.0": { $exists: true } } },
    { $sort: { _id: 1 } }, { $limit: limit + 1 },
    { $project: { _id: 1, offTopic: 1, directedAbuse: 1, oldest: 1, newest: 1, reviewEvidenceVersion: 1, dismissedBefore: 1 } },
  ];
}

export async function getReviewCandidates(actorValue, query, config, now = new Date()) {
  requireEnabled(config);
  if (!config.reviewPolicy) reject("review_policy_required", 503);
  const actor = objectId(String(actorValue));
  fields(query, ["after", "limit"]);
  const { limit } = page({ limit: query.limit });
  const after = query.after === undefined ? null : objectId(query.after);
  const policy = config.reviewPolicy;
  const window = { start: new Date(now.getTime() - policy.windowSeconds * 1000), endExclusive: now };
  return transaction(async (session) => {
    const rows = await AssistantEvent.aggregate(reviewCandidatesPipeline(policy, window, after, limit))
      .session(session).option({ maxTimeMS: 5000 });
    const candidates = rows.slice(0, limit).map((row) => ({
      userId: String(row._id), assessment: "needs_human_review",
      counts: { offTopic: row.offTopic, directedAbuse: row.directedAbuse },
      matchedRules: [
        { id: "repeated_off_topic", observedCount: row.offTopic, threshold: policy.offTopicThreshold },
        { id: "repeated_directed_abuse", observedCount: row.directedAbuse, threshold: policy.directedAbuseThreshold },
      ].filter((rule) => rule.observedCount >= rule.threshold),
      oldestObservationAt: row.oldest.toISOString(), newestObservationAt: row.newest.toISOString(),
    }));
    // Cross-account data leaves the service only after a bounded, content-free access audit commits.
    const reviewSnapshotId = await event(actor, "admin_review_candidates_viewed", config, {
      after: after ? String(after) : null, limit, candidateUserIds: candidates.map((candidate) => candidate.userId),
      policyVersion: policy.version, windowStart: window.start.toISOString(), windowEndExclusive: now.toISOString(),
      reviewPolicy: { ...policy },
      evidenceVersions: rows.slice(0, limit).map((row) => ({ userId: String(row._id), version: row.reviewEvidenceVersion })),
    }, { session, actor });
    return { policy: { ...policy }, generatedAt: now.toISOString(), reviewSnapshotId: String(reviewSnapshotId),
      window: { start: window.start.toISOString(), endExclusive: now.toISOString() },
      coverage: { source: "retained_unverified_completion_events", completeness: "not_guaranteed", configuredAuditRetentionDays: config.auditDays },
      candidates, nextAfter: rows.length > limit ? candidates.at(-1).userId : null, order: "user_id_ascending" };
  });
}
