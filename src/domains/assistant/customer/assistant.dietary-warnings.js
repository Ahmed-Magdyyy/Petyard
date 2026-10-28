import { PetModel } from "../../pet/pet.model.js";
import { AssistantDietaryWarning, AssistantMessage } from "../shared/assistant.models.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { event, getState, transaction } from "../shared/assistant.store.js";
import { invalidateContext } from "./assistant.context.js";
import { fields, objectId, subjectId, text } from "../shared/assistant.validation.js";
import { isCustomerRun } from "../shared/assistant.purpose.js";

const warningDto = (warning) => ({ id: String(warning._id), subjectId: warning.subjectId,
  text: warning.state === "active" ? warning.text : null, source: warning.source, state: warning.state,
  version: warning.version, reportedAt: warning.reportedAt.toISOString(), updatedAt: warning.updatedAt.toISOString() });
function warningSubject(value) {
  const subject = subjectId(value); if (!subject) reject("invalid_subject");
  return subject.toLowerCase();
}
function expectedVersion(body, editing) {
  fields(body, editing ? ["expectedVersion", "text"] : ["expectedVersion"]);
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || body.expectedVersion >= Number.MAX_SAFE_INTEGER) reject("invalid_request");
  return body.expectedVersion;
}
async function ownedSubject(owner, subject, session, now = new Date()) {
  const { chat } = await getState(owner, session);
  if (subject.startsWith("pet:")) {
    if (!await PetModel.exists({ _id: objectId(subject.slice(4)), petOwner: owner }).session(session)) reject("subject_not_found", 404);
  } else if (!chat.subjects.some((pet) => pet.id === subject && pet.expiresAt > now)) reject("subject_not_found", 404);
  return chat;
}
async function audit(warning, type, config, session) {
  await event(warning.owner, type, config, { warningId: String(warning._id), subjectId: warning.subjectId, version: warning.version },
    { session, actor: warning.owner });
}

export async function listDietaryWarnings(ownerValue, query, config) {
  requireEnabled(config); fields(query, ["subjectId", "before", "limit"]);
  const owner = objectId(String(ownerValue)); const subject = query.subjectId === undefined ? null : warningSubject(query.subjectId);
  const before = query.before === undefined ? null : objectId(query.before);
  const limit = query.limit === undefined ? 25 : typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("invalid_pagination");
  return transaction(async (session) => {
    // Owners can manage retained warnings even after the original pet was deleted or expired.
    const rows = await AssistantDietaryWarning.find({ owner, ...(subject ? { subjectId: subject } : {}), state: "active", ...(before ? { _id: { $lt: before } } : {}) })
      .sort({ _id: -1 }).limit(limit + 1).maxTimeMS(5000).session(session).lean();
    const selected = rows.slice(0, limit);
    return { warnings: selected.map(warningDto), nextBefore: rows.length > limit ? String(selected.at(-1)._id) : null };
  });
}

export async function editDietaryWarning(ownerValue, idValue, body, config) {
  requireEnabled(config); const version = expectedVersion(body, true); const value = text(body.text, 500);
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  return transaction(async (session) => {
    const warning = await AssistantDietaryWarning.findOne({ _id: id, owner }).session(session);
    if (!warning) reject("dietary_warning_not_found", 404);
    const { chat } = await getState(owner, session);
    if (warning.state !== "active" || warning.version !== version) reject("dietary_warning_changed", 409);
    const updated = await AssistantDietaryWarning.findOneAndUpdate({ _id: id, owner, state: "active", version },
      { $set: { text: value, source: "user_edit" }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!updated) reject("dietary_warning_changed", 409);
    await invalidateContext(chat, session); await audit(updated, "dietary_warning_edited", config, session);
    return { warning: warningDto(updated) };
  });
}

export async function removeDietaryWarning(ownerValue, idValue, body, config) {
  requireEnabled(config); const version = expectedVersion(body, false);
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  return transaction(async (session) => {
    const warning = await AssistantDietaryWarning.findOne({ _id: id, owner }).session(session);
    if (!warning) reject("dietary_warning_not_found", 404);
    const { chat } = await getState(owner, session);
    if (warning.state === "removed") return { warning: warningDto(warning), duplicate: true };
    if (warning.version !== version) reject("dietary_warning_changed", 409);
    const updated = await AssistantDietaryWarning.findOneAndUpdate({ _id: id, owner, state: "active", version },
      { $set: { state: "removed" }, $unset: { text: 1 }, $inc: { version: 1 } }, { new: true, runValidators: true, session });
    if (!updated) reject("dietary_warning_changed", 409);
    await invalidateContext(chat, session); await audit(updated, "dietary_warning_removed", config, session);
    return { warning: warningDto(updated), duplicate: false };
  });
}

// Internal caller owns the transaction and must bind/save its live run to the returned contextVersion.
export async function recordDietaryWarning(run, observation, config, session) {
  requireEnabled(config); if (!session) reject("assistant_accounting_unavailable", 503);
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  fields(observation, ["subjectId", "quote"]);
  const owner = objectId(String(run.owner)); const subject = warningSubject(observation.subjectId);
  const quote = text(observation.quote, 500);
  if (quote !== observation.quote || subject !== warningSubject(run.subjectId)) reject("invalid_dietary_warning");
  const chat = await ownedSubject(owner, subject, session);
  if (String(chat._id) !== String(run.chat) || chat.contextVersion !== run.contextVersion) reject("context_changed", 409);
  const source = await AssistantMessage.findOne({ owner, chat: run.chat, run: run._id, role: "user", sequence: run.userSequence,
    expiresAt: { $gt: new Date() } }).session(session);
  if (!source || source.text !== run.input || !source.text.includes(quote) || source.subjectId?.toLowerCase() !== subject) reject("invalid_dietary_warning");
  const filter = { owner, subjectId: subject, sourceMessage: source._id };
  const existing = await AssistantDietaryWarning.findOne(filter).session(session);
  if (existing) return { warning: warningDto(existing), duplicate: true, contextVersion: chat.contextVersion };
  const [warning] = await AssistantDietaryWarning.create([{ ...filter, text: quote, source: "chat" }], { session });
  await invalidateContext(chat, session); await audit(warning, "dietary_warning_recorded", config, session);
  return { warning: warningDto(warning), duplicate: false, contextVersion: chat.contextVersion };
}
