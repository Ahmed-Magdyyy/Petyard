import { createHash } from "node:crypto";
import { UserModel } from "../../user/user.model.js";
import { accountStatus, roles } from "../../../shared/constants/enums.js";
import { enqueueNotificationOutbox, findNotificationOutboxByDedupeKey } from "../../notification/notificationOutbox.service.js";
import { AssistantEvent } from "../shared/assistant.models.js";
import { loadAssistantConfig, requireEnabled } from "../shared/assistant.config.js";
import { AssistantError } from "../shared/assistant.errors.js";
import { objectId } from "../shared/assistant.validation.js";
import { reviewCandidatesPipeline } from "./assistant.review-candidates.js";

export const isAssistantReviewNotification = (source) => source?.domain === "assistant" && source?.event === "review_candidate";

export function reviewNotificationKey(owner, policy, dismissedBefore, recipient) {
  const episode = createHash("sha256").update(JSON.stringify([String(owner), policy.version, policy.windowSeconds,
    policy.offTopicThreshold, policy.directedAbuseThreshold, dismissedBefore.toISOString()])).digest("hex");
  return `assistant:review_candidate:${episode}:${recipient}`;
}

async function currentCandidate(owner, config, session, now) {
  // Include the just-inserted completion at millisecond precision; the public report keeps its exclusive request-time bound.
  const endExclusive = new Date(now.getTime() + 1);
  const start = new Date(endExclusive.getTime() - config.reviewPolicy.windowSeconds * 1000);
  const [candidate] = await AssistantEvent.aggregate(reviewCandidatesPipeline(config.reviewPolicy, { start, endExclusive }, null, 1, owner))
    .session(session).option({ maxTimeMS: 5000 });
  return candidate;
}

// The caller holds the account completion write in this transaction, serializing episode creation across workers.
export async function enqueueAssistantReviewAlerts({ owner, signal, config, session, now = new Date() }) {
  if (!config.reviewPolicy || !["none", "directed_abuse"].includes(signal.languageAssessment) || signal.scope === "identity" ||
    (signal.scope !== "off_topic" && signal.languageAssessment !== "directed_abuse")) return;
  const candidate = await currentCandidate(owner, config, session, now);
  if (!candidate) return;
  const recipients = await UserModel.find({ role: roles.SUPER_ADMIN, active: true, deletedAt: null, phoneVerified: true,
    account_status: { $nin: [accountStatus.BANNED, accountStatus.DELETED] } }).select("_id").maxTimeMS(5000).session(session).lean();
  for (const recipient of recipients) {
    const dedupeKey = reviewNotificationKey(owner, config.reviewPolicy, candidate.dismissedBefore, recipient._id);
    // Avoid deliberately causing a duplicate-key error, which would abort the surrounding Mongo transaction.
    if (await findNotificationOutboxByDedupeKey({ dedupeKey, session })) continue;
    await enqueueNotificationOutbox({ recipientUser: recipient._id, dedupeKey, session,
      title_en: "AI assistant review needed", title_ar: "مراجعة استخدام المساعد الذكي",
      body_en: "A usage pattern needs superAdmin review. Open the dashboard to inspect current evidence.",
      body_ar: "يوجد نمط استخدام يحتاج إلى مراجعة المسؤول الأعلى. افتح لوحة التحكم لمراجعة المعلومات الحالية.",
      icon: "system", action: { type: "assistant_review", screen: "AssistantReviewScreen" },
      source: { domain: "assistant", event: "review_candidate", referenceId: String(owner) },
    });
  }
}

export async function assistantReviewAlertIsCurrent(outbox, { getConfig = loadAssistantConfig, now = new Date() } = {}) {
  let config;
  try { config = requireEnabled(getConfig()); }
  catch (error) { if (error instanceof AssistantError) return false; throw error; }
  if (!config.reviewPolicy || !/^[a-f\d]{24}$/i.test(outbox.source?.referenceId ?? "")) return false;
  const owner = objectId(outbox.source.referenceId);
  const candidate = await currentCandidate(owner, config, null, now);
  return Boolean(candidate && outbox.dedupeKey === reviewNotificationKey(owner, config.reviewPolicy, candidate.dismissedBefore, outbox.recipientUser));
}
