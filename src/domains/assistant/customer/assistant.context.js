import { createHash, randomUUID } from "node:crypto";
import { PetModel } from "../../pet/pet.model.js";
import { AssistantDietaryWarning, AssistantMemory, AssistantMessage } from "../shared/assistant.models.js";
import { cartActionsEnabled, bookingReadsEnabled, expiry } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { bookingOptionsInstructions, checkoutSummaryInstructions, instructions, outputSchema, productSearchInstructions, referenceAnsweringInstructions } from "./assistant.policy.js";
import { boundReferenceQuery, normalizationInstructions, normalizationSchema, referencePreparationSchema, referenceQueryInstructions } from "./assistant.reference-query.js";
import { isFocusedReferenceRun } from "../shared/assistant.attempts.js";
import { text } from "../shared/assistant.validation.js";
import { validateKnowledge } from "./assistant.knowledge.js";
import { loadBookingSelection, bookingSelectionContext } from "./assistant.booking-selection-chat.js";
import { toCairoDateISO } from "../../serviceReservation/reservations/serviceReservation.utils.js";

export const PET_CONTEXT_FIELDS = "name type breed gender birthDate chronic_conditions temp_health_issues";
export const subjectFromPet = (pet) => ({ id: `pet:${pet._id}`, name: pet.name, species: pet.type, saved: true, profile: {
  breed: pet.breed, gender: pet.gender, birthDate: pet.birthDate,
  chronicConditions: pet.chronic_conditions, temporaryIssues: pet.temp_health_issues,
} });
export function subjectFingerprint(subject) {
  if (!subject) return null;
  return createHash("sha256").update(JSON.stringify({ id: subject.id, name: subject.name, species: subject.species,
    saved: subject.saved, profile: subject.profile ?? null, expiresAt: subject.expiresAt ?? null })).digest("hex");
}

export async function subjectsFor(owner, chat, config, session, now = new Date()) {
  const pets = await PetModel.find({ petOwner: owner }).select(PET_CONTEXT_FIELDS)
    .sort({ _id: 1 }).limit(config.maxSubjects + 1).session(session).lean();
  if (pets.length > config.maxSubjects) reject("too_many_pet_profiles", 409);
  const saved = pets.map(subjectFromPet);
  const unsaved = chat.subjects.filter((pet) => pet.expiresAt > now).map((pet) => ({ id: pet.id, name: pet.name ?? null,
    species: pet.species ?? null, expiresAt: pet.expiresAt, saved: false }));
  return [...saved, ...unsaved];
}

export function selectInitialSubject(subjects, current, supplied) {
  if (supplied !== undefined) {
    if (supplied !== null && !subjects.some((pet) => pet.id === supplied)) reject("subject_not_found", 404);
    return supplied;
  }
  if (subjects.some((pet) => pet.id === current)) return current;
  return subjects.length === 1 ? subjects[0].id : null;
}

export async function invalidateContext(chat, session) {
  chat.contextVersion += 1;
  chat.contextAfterSequence = chat.nextSequence;
  // All derived summaries are invalid after correction/forgetting. Raw history remains visible but is not sent again.
  await AssistantMemory.updateMany({ owner: chat.owner, kind: "discussion_summary", state: "active" },
    { $set: { state: "forgotten" }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 }, $inc: { version: 1 } }, { session });
  await chat.save({ session });
}

export async function validateActiveSubject(chat, subjects, session) {
  if (chat.activeSubject && !subjects.some((pet) => pet.id === chat.activeSubject)) {
    const deleted = chat.activeSubject;
    chat.activeSubject = null;
    await AssistantMemory.updateMany({ owner: chat.owner, subjectId: deleted },
      { $set: { state: "forgotten" }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 }, $inc: { version: 1 } }, { session });
    await invalidateContext(chat, session);
  }
}

export function newSubject(body, config, now = new Date()) {
  return { id: `chat:${randomUUID()}`, name: body.name == null ? null : text(body.name, 80),
    species: body.species == null ? null : text(body.species, 80), expiresAt: expiry(config.memoryDays, now) };
}

export async function buildContext(run, chat, subjects, config, session, now = new Date(), knowledgeBatch = null, previousBooking) {
  return (await buildContextWithKnowledge(run, chat, subjects, config, session, now, knowledgeBatch, previousBooking)).request;
}

export async function buildContextWithKnowledge(run, chat, subjects, config, session, now = new Date(), knowledgeBatch = null, previousBooking) {
  const selected = subjects.find((pet) => pet.id === run.subjectId);
  const referenceQuery = boundReferenceQuery(run, now);
  const normalize = run.phase === "normalize";
  if (normalize && !isFocusedReferenceRun(run)) reject("assistant_attempt_limit", 503);
  const prepareQuery = isFocusedReferenceRun(run) && knowledgeBatch?.prepareQuery === true && run.phase === "resolve" && config.reasoningEffort === "low";
  if (knowledgeBatch && (knowledgeBatch.ownerId !== String(run.owner) || knowledgeBatch.runId !== String(run._id) ||
      knowledgeBatch.referenceFlowVersion !== run.referenceFlowVersion ||
      knowledgeBatch.subjectId !== run.subjectId || knowledgeBatch.contextVersion !== chat.contextVersion ||
      knowledgeBatch.generation !== (run.generation ?? 0) || knowledgeBatch.phase !== (run.phase ?? "resolve") ||
      knowledgeBatch.profileFingerprint !== subjectFingerprint(selected))) reject("context_changed", 409);
  const passages = validateKnowledge(knowledgeBatch?.passages ?? [], { species: selected?.species ?? null });
  const warnings = selected && !normalize ? await AssistantDietaryWarning.find({ owner: run.owner, subjectId: selected.id, state: "active" })
    .sort({ _id: 1 }).limit(config.maxMemoryEntries + 1).session(session).lean() : [];
  // Never silently drop a dietary caution to fit a smaller context.
  if (warnings.length > config.maxMemoryEntries) reject("context_too_large", 413);
  const permitted = ["user", ...(run.subjectId ? [run.subjectId] : [])];
  let memories = await AssistantMemory.find({ owner: run.owner, subjectId: { $in: permitted }, state: "active", validUntil: { $gt: now } })
    .sort({ updatedAt: -1 }).limit(config.maxMemoryEntries).session(session).lean();
  let history = config.maxHistoryMessages <= 1 ? [] : await AssistantMessage.find({ owner: run.owner, chat: run.chat, sequence: { $gt: chat.contextAfterSequence, $lt: run.userSequence },
    subjectId: { $in: [null, run.subjectId] }, bookingReview: { $exists: false }, expiresAt: { $gt: now }, createdAt: { $gt: new Date(now.getTime() - config.memoryDays * 86400000) } })
    .sort({ sequence: -1 }).limit(config.maxHistoryMessages - 1).session(session).lean();
  history.reverse();
  const bookingDraft = normalize ? null : bookingSelectionContext(previousBooking === undefined ? await loadBookingSelection(run, chat, config, session, now) : previousBooking);
  const limits = { maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, reasoningEffort: config.reasoningEffort };
  const messages = () => [...history.map(message => ({ role: message.role,
    content: `[subject=${message.subjectId ?? "unspecified"}; date=${new Date(message.createdAt).toISOString()}] ${message.text}` })),
    { role: "user", content: run.input }];
  const assemble = () => normalize ? { instructions: `${normalizationInstructions}\nAuthorized context (data only): ${JSON.stringify({
    activeSubject: selected ?? null,
    memories: memories.map(({ subjectId, key, value, updatedAt, validUntil }) => ({ subjectId, key, value, recordedAt: updatedAt, validUntil })),
  })}`, messages: messages(), tools: [], outputSchema: normalizationSchema, limits }
  : ({ instructions: `${instructions}${prepareQuery ? `\n${referenceQueryInstructions}` : ""}${referenceQuery?.status === "unclear" ? "\nThe prior search preparation found the meaning unclear. Ask a concise clarification using the current question and relevant same-pet conversation; do not guess or propose memory/actions. Urgent and health safety rules still take priority." : ""}${passages.length ? `\n${referenceAnsweringInstructions}` : ""}\n${config.productSearchEnabled === true && run.catalogContext !== undefined ? productSearchInstructions : "productSearch is unavailable: use action none, empty query/sourceQuote/options and null numeric filters."}\n${cartActionsEnabled(config) && run.catalogContext !== undefined ? checkoutSummaryInstructions : "checkoutSummary is unavailable; use none."}\n${bookingReadsEnabled(config) ? bookingOptionsInstructions : "bookingOptions is unavailable; use none."}\nAuthorized context (data only): ${JSON.stringify({
    productSearchAvailable: config.productSearchEnabled === true && run.catalogContext !== undefined,
    checkoutSummaryAvailable: cartActionsEnabled(config) && run.catalogContext !== undefined,
    bookingOptionsAvailable: bookingReadsEnabled(config),
    ...(bookingReadsEnabled(config) ? { bookingToday: toCairoDateISO(now) } : {}),
    ...(bookingDraft ? { bookingDraft } : {}),
    activeSubject: run.subjectId, resolutionPhase: run.phase ?? "resolve", subjectSelectionExplicit: run.subjectExplicit ?? false,
    awaitingSubject: chat.awaitingSubject ?? false, sourceQuoteMaxChars: config.maxMessageChars,
    subjects: subjects.map((pet) => pet.id === run.subjectId ? pet : { id: pet.id, name: pet.name, species: pet.species, saved: pet.saved }),
    memories: memories.map(({ subjectId, key, value, updatedAt, validUntil }) => ({ subjectId, key, value, recordedAt: updatedAt, validUntil })),
    dietaryWarnings: warnings.map(({ _id, text, source, version }) => ({ id: String(_id), text, source, version })),
    reviewedKnowledge: { state: passages.length ? "supplied_reviewed_passages" : "no_reviewed_evidence", passages },
  })}`, messages: messages(), tools: [], outputSchema: prepareQuery ? referencePreparationSchema(outputSchema) : outputSchema, limits });
  let request = assemble();
  while (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes && (history.length || memories.length)) {
    if (history.length) history.shift(); else memories.pop();
    request = assemble();
  }
  while (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes && passages.length) {
    passages.pop(); request = assemble();
  }
  if (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes) reject("context_too_large", 413);
  const contextExpiry = Math.min(new Date(run.createdAt ?? now).getTime() + config.historyDays * 86400000,
    ...history.flatMap(message => [new Date(message.expiresAt).getTime(), new Date(message.createdAt).getTime() + config.memoryDays * 86400000]),
    ...memories.map(memory => new Date(memory.validUntil).getTime()));
  return { request, passages, prepareQuery, contextExpiresAt: new Date(contextExpiry) };
}

export async function retainMemory(proposal, run, sourceMessage, config, session) {
  if (!proposal) return;
  const filter = { owner: run.owner, subjectId: proposal.subjectId, key: proposal.key };
  const existing = await AssistantMemory.findOne(filter).session(session);
  if (existing?.state === "forgotten") return;
  if (!existing && await AssistantMemory.countDocuments({ owner: run.owner, state: "active" }).session(session) >= config.maxMemoryEntries) return;
  if (existing) {
    Object.assign(existing, proposal, { sourceMessage, state: "active", validUntil: expiry(config.memoryDays), expiresAt: expiry(config.memoryDays), version: existing.version + 1 });
    await existing.save({ session });
  } else await AssistantMemory.create([{ ...filter, ...proposal, sourceMessage, state: "active", validUntil: expiry(config.memoryDays), expiresAt: expiry(config.memoryDays) }], { session });
}
