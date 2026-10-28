import { createHash } from "node:crypto";
import { UserModel } from "../../user/user.model.js";
import { AssistantAccount, AssistantChat, AssistantMemory, AssistantMessage, AssistantRun } from "../shared/assistant.models.js";
import { requireEnabled, periods, expiry } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { activeRunIdForPurpose, admitMessage, assertAccess, event, getState, settleCost, transaction, unlock } from "../shared/assistant.store.js";
import { invalidateContext, newSubject, selectInitialSubject, subjectsFor, validateActiveSubject } from "./assistant.context.js";
import { chatDto, memoryDto, messageDto, metadataDto, runDto } from "../shared/assistant.dto.js";
import { fields, memoryInput, objectId, page, subjectId, submission, text } from "../shared/assistant.validation.js";
import { recordAttempt, REFERENCE_FLOW_VERSION } from "../shared/assistant.attempts.js";
import { customerRunFilter, runPurposes } from "../shared/assistant.purpose.js";

export { getUsageReport } from "../reporting/assistant.reporting.js";
export { getOutcomeReport } from "../reporting/assistant.outcomes.js";
export { reviewObservations } from "../review/assistant.observations.js";
export { getReviewCandidates } from "../review/assistant.review-candidates.js";
export { dismissReviewCandidate } from "../review/assistant.review-dismissals.js";
export { listDietaryWarnings, editDietaryWarning, removeDietaryWarning } from "./assistant.dietary-warnings.js";

const hashInput = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function historyAccess(account, config) {
  if (account.blocked && !config.blockedHistoryAllowed) reject("ai_restricted", 403);
}

export async function getMetadata(owner, config) {
  if (!config.enabled) return metadataDto(config, null, null);
  requireEnabled(config);
  const account = await AssistantAccount.findOne({ owner }).lean();
  const activeRun = await activeRunIdForPurpose(owner, account, runPurposes.customer);
  return metadataDto(config, account ? { ...account, activeRun } : null, periods(config));
}

export async function getChat(owner, config) {
  requireEnabled(config);
  return transaction(async (session) => {
    const { account, chat } = await getState(owner, session);
    historyAccess(account, config);
    const subjects = await subjectsFor(owner, chat, config, session);
    await validateActiveSubject(chat, subjects, session);
    return chatDto(chat, subjects);
  });
}

async function historyPage(owner, { limit, before }, session = null, now = new Date(), config = null) {
  const messages = await AssistantMessage.find({ owner, sequence: { $lt: before }, expiresAt: { $gt: now } })
    .sort({ sequence: -1 }).limit(limit + 1).session(session).lean();
  const more = messages.length > limit;
  const selected = messages.slice(0, limit);
  const dtos = config && selected.some(message => message.bookingReview)
    ? await (await import("./assistant.booking-messages.js")).bookingMessageDtos(selected, owner, config) : selected.map(messageDto);
  return { messages: dtos, nextBefore: more ? selected.at(-1).sequence : null, order: "newest_first" };
}

export async function getHistory(owner, query, config) {
  requireEnabled(config);
  const pagination = page(query);
  const account = await AssistantAccount.findOne({ owner }).lean();
  if (account) historyAccess(account, config);
  return historyPage(owner, pagination, null, new Date(), config);
}

export async function reviewHistory(actorValue, ownerValue, query, config) {
  requireEnabled(config);
  const actor = objectId(String(actorValue));
  const owner = objectId(ownerValue);
  const pagination = page(query);
  const now = new Date();
  return transaction(async (session) => {
    if (!await UserModel.exists({ _id: owner, deletedAt: null }).session(session)) reject("account_not_found", 404);
    const history = await historyPage(owner, pagination, session, now);
    // Identifiable history leaves the service only after its access audit commits.
    await event(owner, "admin_chat_reviewed", config, {
      before: query.before === undefined ? null : pagination.before, limit: pagination.limit,
      returnedCount: history.messages.length, newestSequence: history.messages[0]?.sequence ?? null,
      oldestSequence: history.messages.at(-1)?.sequence ?? null,
    }, { session, actor });
    return { userId: String(owner), ...history };
  });
}

export async function submitMessage(owner, body, key, config) {
  requireEnabled(config);
  const input = submission(body, key, config);
  const hash = hashInput({ text: input.text, subjectId: input.subjectId === undefined ? "auto" : input.subjectId,
    ...(input.catalogContext === undefined ? {} : { catalogContext: input.catalogContext }),
    ...(input.bookingContext === undefined ? {} : { bookingContext: input.bookingContext }) });
  return transaction(async (session) => {
    const existing = await AssistantRun.findOne(customerRunFilter({ owner, key })).session(session);
    if (existing) {
      const account = await AssistantAccount.findOne({ owner }).session(session);
      if (account) historyAccess(account, config);
      if (existing.hash !== hash) reject("idempotency_conflict", 409);
      return { run: runDto(existing), duplicate: true };
    }
    const { account, chat } = await getState(owner, session);
    const now = new Date();
    admitMessage(account, config, now);
    const subjects = await subjectsFor(owner, chat, config, session, now);
    await validateActiveSubject(chat, subjects, session);
    const selected = input.subjectId === undefined && chat.awaitingSubject ? null : selectInitialSubject(subjects, chat.activeSubject, input.subjectId);
    const awaiting = input.subjectId === undefined ? chat.awaitingSubject : input.subjectId === null;
    if (selected !== chat.activeSubject || awaiting !== chat.awaitingSubject) chat.contextVersion += 1;
    chat.activeSubject = selected;
    chat.awaitingSubject = awaiting;
    chat.nextSequence += 1;
    const [run] = await AssistantRun.create([{ owner, chat: chat._id, key, hash, purpose: runPurposes.customer, status: "queued", contextVersion: chat.contextVersion,
      subjectId: selected, subjectExplicit: input.subjectId !== undefined, phase: "resolve", referenceFlowVersion: REFERENCE_FLOW_VERSION, input: input.text,
      ...(input.catalogContext === undefined ? {} : { catalogContext: input.catalogContext }),
      ...(input.bookingContext === undefined ? {} : { bookingContext: input.bookingContext }),
      userSequence: chat.nextSequence, config: { ...config }, deadline: new Date(now.getTime() + config.queueTimeoutMs) }], { session });
    await AssistantMessage.create([{ owner, chat: chat._id, run: run._id, sequence: chat.nextSequence, role: "user", text: input.text,
      subjectId: selected, expiresAt: expiry(config.historyDays, now) }], { session });
    account.activeRun = run._id;
    await account.save({ session });
    await chat.save({ session });
    await event(owner, "message_accepted", config, { subjectId: selected }, { session, run: run._id });
    return { run: runDto(run), duplicate: false };
  });
}

export async function getRun(owner, id, config) {
  requireEnabled(config);
  const run = await AssistantRun.findOne(customerRunFilter({ _id: objectId(id), owner })).lean();
  if (!run) reject("run_not_found", 404);
  const account = await AssistantAccount.findOne({ owner }).lean();
  if (account) historyAccess(account, config);
  const message = run.responseMessage ? await AssistantMessage.findOne({ _id: run.responseMessage, owner, chat: run.chat, run: run._id,
    role: "assistant", expiresAt: { $gt: new Date() } }).lean() : null;
  return { run: runDto(run), message: message ? messageDto(message) : null };
}

export async function changeSubject(owner, body, config, create = false) {
  requireEnabled(config);
  fields(body, create ? ["name", "species"] : ["subjectId"]);
  return transaction(async (session) => {
    const { account, chat } = await getState(owner, session);
    assertAccess(account, config);
    if (account.activeRun) reject("active_request", 409);
    let subjects = await subjectsFor(owner, chat, config, session);
    await validateActiveSubject(chat, subjects, session);
    if (create) {
      if (subjects.length >= config.maxSubjects) reject("subject_limit", 409);
      const subject = newSubject(body, config);
      chat.subjects = chat.subjects.filter((pet) => pet.expiresAt > new Date());
      chat.subjects.push(subject);
      subjects = [...subjects, { ...subject, saved: false }];
      chat.activeSubject = subject.id;
    } else chat.activeSubject = selectInitialSubject(subjects, chat.activeSubject, subjectId(body.subjectId));
    chat.contextVersion += 1;
    chat.awaitingSubject = chat.activeSubject === null;
    await chat.save({ session });
    return chatDto(chat, subjects);
  });
}

export async function listMemory(owner, config) {
  requireEnabled(config);
  return transaction(async (session) => {
    const { chat } = await getState(owner, session);
    const subjects = await subjectsFor(owner, chat, config, session);
    await validateActiveSubject(chat, subjects, session);
    const memories = await AssistantMemory.find({ owner, subjectId: { $in: ["user", ...subjects.map((pet) => pet.id)] },
      $or: [{ state: "forgotten" }, { validUntil: { $gt: new Date() } }] }).sort({ updatedAt: -1 })
      .limit(config.maxSubjects * 4 + 4).session(session).lean();
    return { memories: memories.map(memoryDto) };
  });
}

export async function saveMemory(owner, body, config) {
  requireEnabled(config);
  const input = memoryInput(body, config);
  return transaction(async (session) => {
    const { chat } = await getState(owner, session);
    const subjects = await subjectsFor(owner, chat, config, session);
    if (input.subjectId !== "user" && !subjects.some((pet) => pet.id === input.subjectId)) reject("subject_not_found", 404);
    const filter = { owner, subjectId: input.subjectId, key: input.key };
    const existing = await AssistantMemory.findOne(filter).session(session);
    if ((!existing || existing.state === "forgotten") && await AssistantMemory.countDocuments({ owner, state: "active" }).session(session) >= config.maxMemoryEntries) reject("memory_limit", 409);
    // Invalidate before writing so a corrected discussion summary remains active.
    await invalidateContext(chat, session);
    const memory = await AssistantMemory.findOneAndUpdate(filter, { $set: { ...input, state: "active", sourceMessage: null,
      sourceQuote: null, validUntil: expiry(config.memoryDays), expiresAt: expiry(config.memoryDays) }, $inc: { version: 1 } }, { upsert: true, new: true, session });
    await event(owner, "memory_saved", config, { subjectId: input.subjectId, key: input.key }, { session });
    return memoryDto(memory);
  });
}

export async function forgetMemory(owner, id, config) {
  requireEnabled(config);
  return transaction(async (session) => {
    const memory = await AssistantMemory.findOne({ _id: objectId(id), owner }).session(session);
    if (!memory) reject("memory_not_found", 404);
    const { chat } = await getState(owner, session);
    await invalidateContext(chat, session);
    memory.state = "forgotten";
    memory.value = undefined;
    memory.sourceMessage = undefined;
    memory.sourceQuote = undefined;
    memory.expiresAt = undefined;
    memory.version += 1;
    await memory.save({ session });
    await event(owner, "memory_forgotten", config, { subjectId: memory.subjectId, key: memory.key }, { session });
    return { memory: memoryDto(memory), contextVersion: chat.contextVersion, historyDeleted: false };
  });
}

export async function restrictAccount(actor, ownerValue, body, config) {
  requireEnabled(config);
  fields(body, ["blocked", "reason"]);
  if (typeof body.blocked !== "boolean") reject("invalid_request");
  const reason = text(body.reason, 500);
  const owner = objectId(ownerValue);
  return transaction(async (session) => {
    if (!await UserModel.exists({ _id: owner, deletedAt: null }).session(session)) reject("account_not_found", 404);
    const account = await AssistantAccount.findOneAndUpdate({ owner }, { $set: { blocked: body.blocked, reason },
      $inc: { restrictionVersion: 1 } }, { upsert: true, new: true, session });
    await event(owner, body.blocked ? "manual_ai_block" : "manual_ai_restore", config, { reason }, { session, actor });
    return { userId: String(owner), blocked: account.blocked, version: account.restrictionVersion };
  });
}

export async function reconcileRun(actor, id, body, config) {
  requireEnabled(config);
  fields(body, ["resolution", "reason"]);
  if (body.resolution !== "charge_reserved") reject("invalid_resolution");
  const reason = text(body.reason, 500);
  return transaction(async (session) => {
    const run = await AssistantRun.findById(objectId(id)).session(session);
    if (!run) reject("run_not_found", 404);
    if (run.accounting === "charged_reservation") return { run: runDto(run), duplicate: true };
    if (run.status !== "uncertain" || run.accounting !== "reserved") reject("run_not_reconcilable", 409);
    await settleCost(run, null, session, { chargeReservation: true });
    recordAttempt(run);
    run.status = "failed";
    run.publicCode = "request_closed_after_review";
    run.expiresAt = expiry(run.purpose === runPurposes.automaticBundles ? Math.max(run.config.runDays, 8) : run.config.runDays);
    await run.save({ session });
    await unlock(run, session);
    await event(run.owner, "uncertain_run_charged_reservation", config, { reason }, { session, actor, run: run._id });
    return { run: runDto(run), duplicate: false };
  });
}
