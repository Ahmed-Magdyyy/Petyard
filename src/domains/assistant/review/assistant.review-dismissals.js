import { UserModel } from "../../user/user.model.js";
import { AssistantAccount, AssistantEvent } from "../shared/assistant.models.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { event, transaction } from "../shared/assistant.store.js";
import { fields, objectId, text } from "../shared/assistant.validation.js";

export async function dismissReviewCandidate(actorValue, ownerValue, body, config, now = new Date()) {
  requireEnabled(config);
  if (!config.reviewPolicy) reject("review_policy_required", 503);
  const actor = objectId(String(actorValue));
  const owner = objectId(ownerValue);
  fields(body, ["reviewSnapshotId", "reason"]);
  const snapshotId = objectId(body.reviewSnapshotId);
  const reason = text(body.reason, 500);
  return transaction(async (session) => {
    if (!await UserModel.exists({ _id: owner, deletedAt: null }).session(session)) reject("account_not_found", 404);
    const snapshot = await AssistantEvent.findOne({ _id: snapshotId, owner: actor, actor,
      type: "admin_review_candidates_viewed", expiresAt: { $gt: now } }).session(session).lean();
    const detail = snapshot?.detail;
    const evidence = Array.isArray(detail?.evidenceVersions)
      ? detail.evidenceVersions.find((entry) => entry?.userId === String(owner)) : null;
    const cutoff = new Date(detail?.windowEndExclusive);
    if (!detail || !Array.isArray(detail.candidateUserIds) || !detail.candidateUserIds.includes(String(owner)) ||
      !["version", "windowSeconds", "offTopicThreshold", "directedAbuseThreshold"]
        .every((key) => detail.reviewPolicy?.[key] === config.reviewPolicy[key]) ||
      !Number.isSafeInteger(evidence?.version) || evidence.version < 0 || typeof detail.windowEndExclusive !== "string" ||
      !Number.isFinite(cutoff.getTime()) || cutoff > now) {
      reject("review_snapshot_unavailable", 409);
    }
    const account = await AssistantAccount.findOne({ owner }).session(session).lean();
    const previous = account?.reviewDismissedBefore ?? null;
    const advanced = !previous || cutoff > previous;
    if (advanced && (account?.reviewEvidenceVersion ?? 0) !== evidence.version) reject("review_snapshot_stale", 409);
    if (advanced) {
      // The same account is written by final completion, so a race retries and rechecks its evidence version.
      await AssistantAccount.updateOne({ owner }, { $setOnInsert: { owner }, $max: { reviewDismissedBefore: cutoff } }, { upsert: true, session });
    }
    const dismissedBefore = advanced ? cutoff : previous;
    const decisionId = await event(owner, "admin_review_dismissed", config, {
      reviewSnapshotId: String(snapshotId), reason, dismissedBefore: dismissedBefore.toISOString(), advanced,
    }, { session, actor });
    return { userId: String(owner), decisionId: String(decisionId), dismissedBefore: dismissedBefore.toISOString(), advanced };
  });
}
