import { UserModel } from "../../user/user.model.js";
import { AssistantEvent } from "../shared/assistant.models.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { outputSchema } from "../customer/assistant.policy.js";
import { event, transaction } from "../shared/assistant.store.js";
import { fields, objectId, page } from "../shared/assistant.validation.js";

export async function reviewObservations(actorValue, ownerValue, query, config) {
  requireEnabled(config);
  const actor = objectId(String(actorValue));
  const owner = objectId(ownerValue);
  fields(query, ["before", "limit"]);
  const { limit } = page({ limit: query.limit });
  const before = query.before === undefined ? null : objectId(query.before);
  const now = new Date();
  return transaction(async (session) => {
    if (!await UserModel.exists({ _id: owner, deletedAt: null }).session(session)) reject("account_not_found", 404);
    const records = await AssistantEvent.find({ owner, type: "run_completed", expiresAt: { $gt: now },
      ...(before ? { _id: { $lt: before } } : {}) })
      .sort({ _id: -1 }).limit(limit + 1).maxTimeMS(5000).session(session).lean();
    const observations = records.slice(0, limit).map((record) => ({
      id: String(record._id), runId: record.run ? String(record.run) : null,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
      scope: outputSchema.properties.scope.enum.includes(record.detail?.scope) ? record.detail.scope : null,
      languageAssessment: outputSchema.properties.languageAssessment.enum.includes(record.detail?.languageAssessment)
        ? record.detail.languageAssessment : null,
      verified: false,
    }));
    // Do not release identifiable observations unless the access audit commits.
    await event(owner, "admin_observations_reviewed", config, {
      before: before ? String(before) : null, limit, observationIds: observations.map((record) => record.id),
    }, { session, actor });
    return { userId: String(owner), assessment: "model_unreviewed", observations,
      nextBefore: records.length > limit ? observations.at(-1).id : null, order: "id_desc" };
  });
}
