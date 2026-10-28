import { UserModel } from "../../user/user.model.js";
import { PetModel } from "../../pet/pet.model.js";
import { AssistantAccount, AssistantChat, AssistantMessage, AssistantRun, AssistantMemory, AssistantDietaryWarning } from "../shared/assistant.models.js";
import { cartActionsEnabled, bookingActionsEnabled, bookingReadsEnabled, loadAssistantConfig, requireEnabled, expiry, costMicroUsd } from "../shared/assistant.config.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { assertAccess, event, getState, reserveCost, settleCost, transaction, unlock } from "../shared/assistant.store.js";
import { buildContextWithKnowledge, PET_CONTEXT_FIELDS, retainMemory, subjectFingerprint, subjectFromPet, subjectsFor, validateActiveSubject } from "./assistant.context.js";
import { dietaryWarningClarification, dietaryWarningObservation, validateResult } from "./assistant.policy.js";
import { recordDietaryWarning } from "./assistant.dietary-warnings.js";
import { TOPIC_TAXONOMY_VERSION } from "../reporting/assistant.topics.js";
import { createAssistantAdapter } from "../providers/assistantProvider.js";
import { AssistantProviderError } from "../providers/providerContract.js";
import { retrieveKnowledgeBatch, retrieveReviewedPassages } from "./assistant.knowledge.js";
import { beginAttempt, isFocusedReferenceRun, queuedWorkFilter, queueAnswer, recordAttempt } from "../shared/assistant.attempts.js";
import { applySubjectChange, bindRunSubject, resolveSubjectDecision, subjectClarification } from "./assistant.subjects.js";
import { enqueueAssistantReviewAlerts } from "../review/assistant.notifications.js";
import { customerRunFilter, isCustomerRun } from "../shared/assistant.purpose.js";
import { productSearchBinding, productSearchContext, productSearchIntent } from "../products/assistant.product-search.js";
import { buildCatalogSnapshot, renderCatalogResponse } from "../products/assistant.product-cards.js";
import { buildCheckoutSnapshot, renderCheckoutResponse } from "./assistant.checkout-cards.js";
import { buildBookingSnapshot, renderBookingResponse } from "./assistant.booking-cards.js";
import { bookingContextInput } from "./assistant.booking-context.js";
import { advanceBookingSelection } from "./assistant.booking-selection.js";
import { loadBookingSelection, selectionBinding, selectionCard, renderBookingSelection } from "./assistant.booking-selection-chat.js";
import { loadReferenceRetrievalConfig } from "../references/assistant.reference-config.js";
import { fenceReferenceSources } from "../references/assistant.reference-search.js";
import { bindReferenceQuery, boundReferenceQuery, canQueueReferenceAnswer, meaningClarificationReply, unwrapReferenceResult, validateNormalization } from "./assistant.reference-query.js";

const noUsage = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
async function eligibleUser(owner, run, session) {
  const user = await UserModel.findById(owner).select("role active deletedAt account_status phoneVerified passwordChangedAT").session(session).lean();
  if (!user || !user.active || user.deletedAt || user.role === "guest" || user.account_status === "banned" || !user.phoneVerified ||
      (user.passwordChangedAT && user.passwordChangedAT > run.createdAt)) reject("access_denied", 403);
}
function sameConfig(run, config) {
  requireEnabled(config);
  if (config.signature !== run.config.signature) reject("configuration_changed", 503);
}
async function failQueued(run, error, session) {
  run.status = "failed";
  run.publicCode = error instanceof AssistantError ? error.code : "assistant_unavailable";
  run.retryAt = error.retryAt ?? null;
  run.internalCode = error.code ?? "preparation_failed";
  run.expiresAt = expiry(run.config.runDays);
  await run.save({ session });
  await unlock(run, session);
  await event(run.owner, "run_failed_before_dispatch", run.config, { code: run.internalCode }, { session, run: run._id });
}

export async function prepareRun(id, config, knowledgeBatch = null) {
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(knowledgeBatch ? queuedWorkFilter(id, knowledgeBatch) : customerRunFilter({ _id: id, status: "queued" })).session(session);
    if (!run) return null;
    // Validation failures are persisted separately; a failed reservation must roll back BOTH budget updates.
    sameConfig(run, config);
    const { account, chat } = await getState(run.owner, session);
    assertAccess(account, config);
    await eligibleUser(run.owner, run, session);
    if (String(account.activeRun) !== String(run._id)) reject("active_request_changed", 409);
    if (run.deadline <= new Date()) reject("queue_expired", 503);
    await assertRunSource(run, session);
    const subjects = await subjectsFor(run.owner, chat, config, session);
    await validateActiveSubject(chat, subjects, session);
    if (run.contextVersion !== chat.contextVersion) reject("context_changed", 409);
    const fingerprint = subjectFingerprint(subjects.find((pet) => pet.id === run.subjectId));
    if (["normalize", "answer"].includes(run.phase) && fingerprint !== run.subjectFingerprint) reject("context_changed", 409);
    run.subjectFingerprint = fingerprint;
    if (run.referenceContextExpiresAt && run.referenceContextExpiresAt <= new Date()) reject("context_changed", 409);
    if (run.phase === "normalize" && knowledgeBatch?.prepareQuery !== true) {
      queueAnswer(run);
      await run.save({ session });
      return { skippedNormalization: true };
    }
    const bookingPrevious = run.phase === "normalize" ? null : await loadBookingSelection(run, chat, config, session);
    const { request, passages, prepareQuery, contextExpiresAt } = await buildContextWithKnowledge(run, chat, subjects, config, session, new Date(), knowledgeBatch, bookingPrevious);
    run.referencePreparationRequested = prepareQuery;
    if (prepareQuery || run.phase === "normalize") run.referenceContextExpiresAt = new Date(Math.min(
      contextExpiresAt.getTime(), run.referenceContextExpiresAt?.getTime() ?? Infinity));
    run.referenceSources = [...new Map(passages.map(passage => [passage.sourceId,
      { sourceId: passage.sourceId, manifestHash: passage.version }])).values()];
    if (run.referenceSources.length) {
      if (!loadReferenceRetrievalConfig(config).enabled) reject("reference_retrieval_unavailable", 503);
      await fenceReferenceSources(run.referenceSources, session);
    }
    beginAttempt(run, await reserveCost(run.owner, config, session));
    run.status = "dispatching";
    // No retry after this durable boundary, even if the process crashes before HTTP starts.
    run.dispatchDeadline = new Date(Math.min(run.deadline.getTime(), Date.now() + config.timeoutMs + 30000));
    await run.save({ session });
    await event(run.owner, "provider_attempt_reserved", config, { attemptId: run.attempt, number: run.attempts.length, phase: run.phase, amount: run.reservation.amount,
      provider: config.provider, model: config.model, priceVersion: config.price.version }, { session, run: run._id });
    return { run: run.toObject(), request, bookingPrevious, allowedSubjects: ["user", ...subjects.map((pet) => pet.id)],
      subjectFingerprints: Object.fromEntries(subjects.map((pet) => [pet.id, subjectFingerprint(pet)])) };
  });
}

export async function failPreparation(id, error, snapshot) {
  if (!isCustomerRun(snapshot)) return;
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(queuedWorkFilter(id, snapshot)).session(session);
    if (!run) return;
    await failQueued(run, error, session);
  });
}

export async function externalWorkScope(snapshot, config, status, includeSubject = false, session = null) {
  if (!isCustomerRun(snapshot)) reject("run_not_found", 404);
  sameConfig(snapshot, config);
  const account = await AssistantAccount.findOne({ owner: snapshot.owner }).session(session).lean();
  if (!account) reject("assistant_accounting_unavailable", 503);
  assertAccess(account, config);
  await eligibleUser(snapshot.owner, snapshot, session);
  const run = await AssistantRun.findOne(status === "queued" ? queuedWorkFilter(snapshot._id, snapshot)
    : customerRunFilter({ _id: snapshot._id, status, attempt: snapshot.attempt })).session(session).lean();
  const chat = await AssistantChat.findById(snapshot.chat).session(session).lean();
  if (!run || !chat || chat.contextVersion !== snapshot.contextVersion || String(account.activeRun) !== String(run._id)) reject("context_changed", 409);
  if (run.deadline <= new Date()) reject("queue_expired", 503);
  if (run.referenceFlowVersion !== snapshot.referenceFlowVersion) reject("context_changed", 409);
  if (run.referenceContextExpiresAt && run.referenceContextExpiresAt <= new Date()) reject("context_changed", 409);
  let subject = null;
  if (run.subjectId?.startsWith("pet:")) {
    const pet = await PetModel.findOne({ _id: run.subjectId.slice(4), petOwner: run.owner }).select(PET_CONTEXT_FIELDS).session(session).lean();
    if (!pet) reject("subject_not_found", 404);
    subject = subjectFromPet(pet);
  } else if (run.subjectId?.startsWith("chat:")) {
    subject = chat.subjects.find((pet) => pet.id === run.subjectId && pet.expiresAt > new Date());
    if (!subject) reject("subject_not_found", 404);
    subject = { ...subject, saved: false };
  }
  const fingerprint = subjectFingerprint(subject);
  if ((status === "dispatching" || ["normalize", "answer"].includes(snapshot.phase)) && fingerprint !== snapshot.subjectFingerprint) reject("context_changed", 409);
  const referenceQuery = boundReferenceQuery(run);
  return { ownerId: String(run.owner), runId: String(run._id), audience: "customer", subjectId: run.subjectId,
    contextVersion: run.contextVersion, generation: run.generation, phase: run.phase,
    ...(run.referenceFlowVersion === undefined ? {} : { referenceFlowVersion: run.referenceFlowVersion }),
    species: subject?.species ?? null, profileFingerprint: fingerprint, query: run.input,
    ...(referenceQuery ? { referenceQueryState: referenceQuery.status,
      ...(referenceQuery.status === "ready" ? { searchQuery: referenceQuery.query } : {}) } : {}),
    ...(includeSubject ? { subject } : {}) };
}

// Read outside financial transactions; publication revalidates this binding under the existing settlement transaction.
export async function prepareProductSearch(prepared, result, config, { context, readProducts, readSemantic } = {}) {
  const run = prepared.run;
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  sameConfig(run, config);
  if (result?.serviceTier !== "default" || costMicroUsd(result?.usage, run.config) === null) return null;
  const valid = validateResult(result, run, config, prepared.allowedSubjects, { allowProductSearch: true,
    allowCheckoutSummary: cartActionsEnabled(config) && run.catalogContext !== undefined, allowBookingOptions: bookingReadsEnabled(config) });
  const intent = valid.productSearch;
  if (!intent || !["keep", "select"].includes(result.structured.subjectAction) ||
      (result.structured.subjectAction === "select" && result.structured.resolvedSubjectId !== run.subjectId)) return null;
  const warning = dietaryWarningObservation(result.structured, run, { kind: "publish" });
  if (warning?.kind === "clarify") return null;
  const searchContext = productSearchContext(context ?? run.catalogContext, result.structured.replyLanguage);
  let timer; let timedOut = false; const controller = new AbortController();
  try {
    const work = async () => {
      const scope = await externalWorkScope(run, config, "dispatching", true);
      resolveSubjectDecision(result.structured, run, scope.subject ? [scope.subject] : [], prepared.subjectFingerprints, config);
      const source = await AssistantMessage.findOne({ owner: run.owner, chat: run.chat, run: run._id, role: "user",
        sequence: run.userSequence, expiresAt: { $gt: new Date() } }).maxTimeMS(5000).lean();
      if (!source || source.text !== run.input || (source.subjectId ?? null) !== run.subjectId) reject("context_changed", 409);
      const binding = productSearchBinding(run, intent, searchContext, warning);
      if (intent.needsSubject) return { binding, intent, context: searchContext, result: { status: "needs_subject", products: [] } };
      const warnings = run.subjectId ? await AssistantDietaryWarning.find({ owner: run.owner, subjectId: run.subjectId, state: "active" })
        .sort({ _id: 1 }).limit(config.maxMemoryEntries + 1).maxTimeMS(5000).lean() : [];
      if (warnings.length > config.maxMemoryEntries) reject("context_too_large", 413);
      if (warning?.kind === "report") warnings.push({ subjectId: warning.subjectId, state: "active", text: warning.quote });
      if (timedOut) reject("product_search_timeout", 503);
      const lookup = readProducts ?? (await import("../products/assistant.catalog-read.js")).readAssistantCatalog;
      let outcome;
      try {
        const semantic = config.catalogSemanticEnabled === true ? { signal: controller.signal, semanticCandidates: async input => {
          if (input.warehouseId !== searchContext.warehouseId || input.query !== intent.query) reject("invalid_catalog_context");
          const retrieve = readSemantic ?? (await import("../products/assistant.catalog-semantic.js")).retrieveCatalogSemanticCandidates;
          return retrieve({ run, config, signal: controller.signal, request: { ...input, binding, species: scope.subject?.species ?? null } });
        } } : undefined;
        outcome = await lookup({ query: intent.query, ...searchContext, subject: scope.subject, warnings,
          ...(intent.constrained ? { filters: intent.filters } : {}) }, config, semantic);
        // Validate and bound the snapshot before treating an otherwise successful read as usable.
        buildCatalogSnapshot(outcome, intent, searchContext, scope.subject, result.structured.replyLanguage);
      } catch {
        outcome = { status: "unavailable", products: [] };
      }
      if (timedOut) reject("product_search_timeout", 503);
      await externalWorkScope(run, config, "dispatching");
      return { binding, intent, context: searchContext, result: outcome };
    };
    return await Promise.race([work(), new Promise((_resolve, rejectPromise) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); rejectPromise(new AssistantError("product_search_timeout", 503)); }, config.timeoutMs);
    })]);
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function knowledgeForRun(id, config, retrieve = retrieveReviewedPassages, snapshot = null) {
  const run = snapshot ?? await AssistantRun.findOne(customerRunFilter({ _id: id, status: "queued" })).lean();
  if (!isCustomerRun(run)) return null;
  const scope = await externalWorkScope(run, config, "queued");
  // Paid query embeddings own their reservation; neither search nor HTTP runs inside chat preparation.
  return retrieveKnowledgeBatch(scope, bound => retrieve(bound, { run, config }), config.timeoutMs);
}

const checkoutBinding = (run, context) => productSearchBinding(run, { action: "checkout_summary" }, context, null);
export async function assertRunSource(run, session = null) {
  const source = await AssistantMessage.findOne({ owner: run.owner, chat: run.chat, run: run._id, role: "user",
    sequence: run.userSequence, expiresAt: { $gt: new Date() } }).session(session).maxTimeMS(5000).lean();
  if (!source || source.text !== run.input || (source.subjectId ?? null) !== run.subjectId) reject("context_changed", 409);
}

// Uses the admitted chat run, not a nested cart admission or a retryable financial transaction.
export async function prepareCheckoutSummary(prepared, result, config, { readCheckout } = {}) {
  const run = prepared.run;
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  sameConfig(run, config);
  if (result?.serviceTier !== "default" || costMicroUsd(result?.usage, run.config) === null) return null;
  const valid = validateResult(result, run, config, prepared.allowedSubjects, {
    allowProductSearch: config.productSearchEnabled === true && run.catalogContext !== undefined,
    allowCheckoutSummary: cartActionsEnabled(config) && run.catalogContext !== undefined, allowBookingOptions: bookingReadsEnabled(config) });
  if (!valid.checkoutSummary || !["keep", "select"].includes(result.structured.subjectAction) ||
      (result.structured.subjectAction === "select" && result.structured.resolvedSubjectId !== run.subjectId) ||
      dietaryWarningObservation(result.structured, run, { kind: "publish" })?.kind === "clarify") return null;
  const context = productSearchContext(run.catalogContext, result.structured.replyLanguage);
  const fallback = () => buildCheckoutSnapshot({ status: "unavailable", warehouseId: context.warehouseId }, context.warehouseId);
  let timer; let timedOut = false;
  const work = async () => {
    const scope = await externalWorkScope(run, config, "dispatching", true);
    resolveSubjectDecision(result.structured, run, scope.subject ? [scope.subject] : [], prepared.subjectFingerprints, config);
    await assertRunSource(run);
    let snapshot;
    if (!context.warehouseId) snapshot = buildCheckoutSnapshot({ status: "needs_location", warehouseId: null }, null);
    else {
      if (timedOut) reject("checkout_summary_timeout", 503);
      const read = readCheckout ?? (await import("../../checkout/checkout.preview.js")).previewUserCheckoutService;
      try { snapshot = buildCheckoutSnapshot(await read({ userId: String(run.owner), warehouseId: context.warehouseId, lang: context.language }), context.warehouseId); }
      catch { snapshot = fallback(); }
    }
    if (timedOut) reject("checkout_summary_timeout", 503);
    await externalWorkScope(run, config, "dispatching");
    return { binding: checkoutBinding(run, context), snapshot };
  };
  try {
    return await Promise.race([work(), new Promise((_resolve, rejectPromise) => {
      timer = setTimeout(() => { timedOut = true; rejectPromise(new AssistantError("checkout_summary_timeout", 503)); }, config.timeoutMs);
    })]);
  } catch (error) {
    if (error.code !== "checkout_summary_timeout") throw error;
    return { binding: checkoutBinding(run, context), snapshot: fallback() };
  } finally { clearTimeout(timer); }
}

const bookingContext = run => bookingContextInput(run.bookingContext ?? { location: null });
const bookingBinding = (run, language, intent, previous) => productSearchBinding(run, { action: "booking_options", language, intent, previous }, bookingContext(run), null);

export async function prepareBookingOptions(prepared, result, config, { readBookingOptions } = {}) {
  const run = prepared.run;
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  sameConfig(run, config);
  if (result?.serviceTier !== "default" || costMicroUsd(result?.usage, run.config) === null) return null;
  const valid = validateResult(result, run, config, prepared.allowedSubjects, {
    allowProductSearch: config.productSearchEnabled === true && run.catalogContext !== undefined,
    allowCheckoutSummary: cartActionsEnabled(config) && run.catalogContext !== undefined, allowBookingOptions: bookingReadsEnabled(config) });
  if (!valid.bookingOptions || !["keep", "select"].includes(result.structured.subjectAction) ||
    result.structured.subjectAction === "select" && result.structured.resolvedSubjectId !== run.subjectId ||
    dietaryWarningObservation(result.structured, run, { kind: "publish" })?.kind === "clarify") return null;
  const chat = await AssistantChat.findById(run.chat).lean();
  if (!chat) reject("context_changed", 409);
  const previous = await loadBookingSelection(run, chat, config);
  if (prepared.bookingPrevious !== undefined && JSON.stringify(previous) !== JSON.stringify(prepared.bookingPrevious)) reject("context_changed", 409);
  const context = bookingContext(run), binding = bookingBinding(run, result.structured.replyLanguage, result.structured.bookingOptions, previous);
  const fallback = () => ({ binding, snapshot: buildBookingSnapshot({ status: "unavailable" }) });
  let timer, timedOut = false;
  const work = async () => {
    const scope = await externalWorkScope(run, config, "dispatching", true);
    resolveSubjectDecision(result.structured, run, scope.subject ? [scope.subject] : [], prepared.subjectFingerprints, config);
    await assertRunSource(run);
    let snapshot;
    if (!context.location) snapshot = buildBookingSnapshot({ status: "needs_location" });
    else {
      if (timedOut) reject("booking_options_timeout", 503);
      const read = readBookingOptions ?? (await import("./assistant.booking-discovery.js")).readChatBookingOptions;
      try {
        const value = await read(run.owner, { location: context.location, language: result.structured.replyLanguage }, config);
        snapshot = buildBookingSnapshot({ ...value, status: value.eligible === true
          ? value.services?.some(service => service.options?.length) && value.locations?.length ? "ready" : "empty"
          : value.reason === "booking_location_required" ? "needs_location" : "ineligible" }, { actionsAllowed: bookingActionsEnabled(config) });
      } catch { snapshot = fallback().snapshot; }
    }
    if (timedOut) reject("booking_options_timeout", 503);
    await externalWorkScope(run, config, "dispatching");
    return { binding, snapshot };
  };
  try {
    return await Promise.race([work(), new Promise((_resolve, rejectTimeout) => {
      timer = setTimeout(() => { timedOut = true; rejectTimeout(new AssistantError("booking_options_timeout", 503)); }, config.timeoutMs);
    })]);
  } catch (error) { if (error.code !== "booking_options_timeout") throw error; return fallback(); }
  finally { clearTimeout(timer); }
}

export async function finishRun(prepared, result, error, { dispatched = true, currentConfig, productSearchBatch = null, checkoutBatch = null, bookingBatch = null } = {}) {
  if (!isCustomerRun(prepared.run)) return null;
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(customerRunFilter({ _id: prepared.run._id, attempt: prepared.run.attempt,
      status: { $in: ["dispatching", "uncertain"] }, accounting: "reserved" })).session(session);
    if (!run) return null;
    const config = run.config;
    const usage = dispatched ? (result?.usage ?? error?.usage ?? null) : noUsage;
    const settled = await settleCost(run, usage, session);
    run.providerRequestId = result?.providerRequestId ?? error?.providerRequestId ?? null;
    run.latencyMs = result?.latencyMs ?? error?.latencyMs ?? null;
    run.internalCode = error?.code ?? null;
    recordAttempt(run);
    if (!settled) {
      run.status = "uncertain";
      run.publicCode = "request_needs_review";
      await run.save({ session });
      await event(run.owner, "provider_charge_uncertain", config, { code: run.internalCode }, { session, run: run._id });
      return run;
    }
    const { account, chat } = await getState(run.owner, session);
    let valid;
    let decision;
    let warning;
    let catalog;
    let checkout;
    let booking;
    let bookingSelection;
    let meaningClarification = false;
    try {
      sameConfig(run, currentConfig ?? config);
      assertAccess(account, currentConfig ?? config);
      await eligibleUser(run.owner, run, session);
      const subjects = await subjectsFor(run.owner, chat, config, session);
      await validateActiveSubject(chat, subjects, session);
      if (chat.contextVersion !== run.contextVersion) reject("context_changed", 409);
      if (String(account.activeRun) !== String(run._id)) reject("active_request_changed", 409);
      if (run.deadline <= new Date()) reject("queue_expired", 503);
      if (run.referenceContextExpiresAt && run.referenceContextExpiresAt <= new Date()) reject("context_changed", 409);
      await assertRunSource(run, session);
      if (subjectFingerprint(subjects.find((pet) => pet.id === run.subjectId)) !== run.subjectFingerprint) reject("context_changed", 409);
      if (error) throw error;
      if (run.phase === "normalize") {
        if (!isFocusedReferenceRun(run)) reject("assistant_attempt_limit", 503);
        const query = validateNormalization(result);
        queueAnswer(run);
        bindReferenceQuery(run, query, run.referenceContextExpiresAt);
        await run.save({ session });
        return run;
      }
      if (run.referenceSources?.length) {
        if (!loadReferenceRetrievalConfig(currentConfig ?? config).enabled) reject("reference_retrieval_unavailable", 503);
        await fenceReferenceSources(run.referenceSources, session);
      }
      const allowProductSearch = config.productSearchEnabled === true && run.catalogContext !== undefined;
      valid = validateResult(result, run, config, prepared.allowedSubjects.filter((id) => id === "user" || subjects.some((pet) => pet.id === id)), { allowProductSearch,
        allowCheckoutSummary: cartActionsEnabled(config) && run.catalogContext !== undefined, allowBookingOptions: bookingReadsEnabled(currentConfig ?? config) });
      decision = resolveSubjectDecision(result.structured, run, subjects, prepared.subjectFingerprints, config);
      warning = dietaryWarningObservation(result.structured, run, decision);
      if (decision.kind === "change") {
        await applySubjectChange(decision, run, chat, subjects, config, session);
        queueAnswer(run);
        // Search wording prepared with the previous pet's context cannot be rebound to the new pet.
        run.referenceQuery = undefined;
        await run.save({ session });
        await event(run.owner, "subject_resolved", config, { subjectId: run.subjectId }, { session, run: run._id });
        return run;
      }
      if (run.referencePreparationRequested && canQueueReferenceAnswer(run, result, valid, decision, warning)) {
        queueAnswer(run, "normalize");
        await run.save({ session });
        return run;
      }
      if (result.referenceAction === "prepare") reject("invalid_reference_query", 503);
      meaningClarification = decision.kind === "publish" && valid.scope === "pet_care" &&
        (result.referenceAction === "clarify" || boundReferenceQuery(run)?.status === "unclear");
      if (meaningClarification) {
        if (valid.productSearch || valid.checkoutSummary || valid.bookingOptions || warning?.kind === "report") reject("invalid_reference_query", 503);
        valid.reply = meaningClarificationReply(result.structured.replyLanguage);
        valid.memory = null;
      }
      if (decision.kind === "clarify") {
        valid.reply = subjectClarification(result.structured.replyLanguage);
        valid.memory = null;
      }
      if (warning?.kind === "clarify") {
        valid.reply = dietaryWarningClarification(result.structured.replyLanguage);
        valid.memory = null;
      }
      if (["clarify", "urgent"].includes(decision.kind)) {
        valid.memory = null;
        if (!run.subjectExplicit) {
          await bindRunSubject(run, chat, null, session, { awaiting: true });
          run.subjectFingerprint = null;
        }
      }
      if (valid.productSearch && decision.kind === "publish" && warning?.kind !== "clarify") {
        const context = productSearchContext(run.catalogContext, result.structured.replyLanguage);
        if (!productSearchBatch || productSearchBatch.binding !== productSearchBinding(run, valid.productSearch, context, warning)) reject("context_changed", 409);
        const source = await AssistantMessage.findOne({ owner: run.owner, chat: run.chat, run: run._id, role: "user", sequence: run.userSequence,
          expiresAt: { $gt: new Date() } }).session(session);
        if (!source || source.text !== run.input || (source.subjectId ?? null) !== run.subjectId) reject("context_changed", 409);
        if (productSearchBatch.result.products?.some(card => card.type === "BUNDLE") && (currentConfig ?? config).bundleCartEnabled !== true) reject("bundle_cart_actions_unavailable", 503);
        catalog = buildCatalogSnapshot(productSearchBatch.result, valid.productSearch, context, subjects.find((pet) => pet.id === run.subjectId), result.structured.replyLanguage);
        const response = renderCatalogResponse(catalog, result.structured.replyLanguage);
        valid.reply = valid.scope === "health" ? `${valid.reply}\n\n${response}` : response;
      }
      if (valid.checkoutSummary && decision.kind === "publish" && warning?.kind !== "clarify") {
        const context = productSearchContext(run.catalogContext, result.structured.replyLanguage);
        if (!checkoutBatch || checkoutBatch.binding !== checkoutBinding(run, context)) reject("context_changed", 409);
        await assertRunSource(run, session);
        checkout = buildCheckoutSnapshot(checkoutBatch.snapshot, context.warehouseId, checkoutBatch.snapshot.generatedAt);
        valid.reply = renderCheckoutResponse(checkout, result.structured.replyLanguage);
        valid.memory = null;
      }
      if (valid.bookingOptions && decision.kind === "publish" && warning?.kind !== "clarify") {
        const previous = await loadBookingSelection(run, chat, currentConfig ?? config, session);
        if (prepared.bookingPrevious !== undefined && JSON.stringify(previous) !== JSON.stringify(prepared.bookingPrevious)) reject("context_changed", 409);
        if (!bookingBatch || bookingBatch.binding !== bookingBinding(run, result.structured.replyLanguage, result.structured.bookingOptions, previous)) reject("context_changed", 409);
        await assertRunSource(run, session);
        const snapshot = bookingBatch.snapshot;
        booking = buildBookingSnapshot({ ...snapshot, eligible: ["ready", "empty"].includes(snapshot.status), governorateCode: "alexandria" },
          { actionsAllowed: snapshot.action !== null && bookingActionsEnabled(currentConfig ?? config), generatedAt: snapshot.generatedAt });
        valid.reply = renderBookingResponse(booking, result.structured.replyLanguage);
        const proposal = result.structured.bookingOptions;
        const selected = advanceBookingSelection({ intent: { ...proposal, action: proposal.action === "read" ? "none" : proposal.action },
          latestInput: run.input, catalog: booking, binding: selectionBinding(run), previous: previous?.state ?? null });
        bookingSelection = JSON.stringify(selected.state);
        if (Buffer.byteLength(bookingSelection) > 4096) reject("invalid_booking_selection", 503);
        if (["collecting", "choice_unavailable", "selection_complete"].includes(selected.status) &&
          (proposal.action !== "read" || previous)) valid.reply = renderBookingSelection(selectionCard(bookingSelection, booking, run.subjectId), result.structured.replyLanguage);
        valid.memory = null;
      }
      if (!valid.reply.trim()) reject("invalid_assistant_result", 503);
      if (valid.reply.length > config.maxOutputChars) reject("invalid_assistant_result", 503);
    } catch (failure) {
      valid = null;
      run.status = "failed";
      run.publicCode = failure instanceof AssistantError ? failure.code : "assistant_response_unavailable";
      run.internalCode = failure.code ?? "invalid_result";
    }
    if (valid) {
      if (warning?.kind === "report") {
        // Persistence/audit failure must abort settlement and publication together, never commit a partial warning.
        const captured = await recordDietaryWarning(run, { subjectId: warning.subjectId, quote: warning.quote }, config, session);
        run.contextVersion = captured.contextVersion;
        chat.contextVersion = captured.contextVersion;
        if (!captured.duplicate) chat.contextAfterSequence = chat.nextSequence;
      }
      chat.nextSequence += 1;
      const [message] = await AssistantMessage.create([{ owner: run.owner, chat: run.chat, run: run._id, sequence: chat.nextSequence,
        role: "assistant", text: valid.reply, subjectId: run.subjectId, expiresAt: expiry(config.historyDays),
        ...(catalog ? { catalogJson: JSON.stringify(catalog) } : {}), ...(checkout ? { checkoutJson: JSON.stringify(checkout) } : {}),
        ...(booking ? { bookingJson: JSON.stringify(booking), bookingSelectionJson: bookingSelection } : {}) }], { session });
      run.responseMessage = message._id;
      run.status = "completed";
      run.topic = { key: valid.primaryTopic, taxonomyVersion: TOPIC_TAXONOMY_VERSION };
      run.publicCode = decision.kind === "clarify" ? "subject_clarification_required"
        : warning?.kind === "clarify" ? "dietary_warning_clarification_required" : meaningClarification ? "meaning_clarification_required" : null;
      const source = await AssistantMessage.findOne({ run: run._id, owner: run.owner, role: "user" }).session(session);
      if (source) await retainMemory(valid.memory, run, source._id, config, session);
      await chat.save({ session });
      await AssistantAccount.updateOne({ owner: run.owner }, { $inc: { reviewEvidenceVersion: 1 } }, { session });
      await event(run.owner, "run_completed", config, { scope: valid.scope, languageAssessment: valid.languageAssessment,
        languageAssessmentVerified: false }, { session, run: run._id });
      await enqueueAssistantReviewAlerts({ owner: run.owner, signal: valid, config, session });
    } else await event(run.owner, "run_failed_after_dispatch", config, { code: run.internalCode }, { session, run: run._id });
    run.expiresAt = expiry(config.runDays);
    recordAttempt(run);
    await run.save({ session });
    await unlock(run, session);
    return run;
  });
}

export async function recoverAssistantRuns(config, now = new Date()) {
  const candidates = await AssistantRun.find(customerRunFilter({ status: "dispatching", dispatchDeadline: { $lte: now } })).sort({ dispatchDeadline: 1 }).limit(100).select("_id").lean();
  for (const candidate of candidates) await transaction(async (session) => {
    const run = await AssistantRun.findOne(customerRunFilter({ _id: candidate._id, status: "dispatching", dispatchDeadline: { $lte: now } })).session(session);
    if (!run) return;
    run.status = "uncertain";
    run.publicCode = "request_needs_review";
    run.internalCode = "worker_dispatch_interrupted";
    recordAttempt(run);
    await run.save({ session });
    await event(run.owner, "interrupted_attempt_needs_review", run.config, {}, { session, run: run._id });
  });
  // Logical expiry is enforced in queries. Scrub expired values while retaining suppression and financial records.
  await AssistantMemory.updateMany({ state: "active", validUntil: { $lte: now } },
    { $set: { state: "forgotten" }, $unset: { value: 1, sourceMessage: 1, sourceQuote: 1, expiresAt: 1 }, $inc: { version: 1 } });
  return candidates.length;
}

export async function processAssistantRun(id, { getConfig = loadAssistantConfig, adapterFactory = createAssistantAdapter,
  retrieveKnowledge = retrieveReviewedPassages, readProducts, readSemantic, readCheckout, readBookingOptions } = {}) {
  // Only the marked resolve/normalize/answer sequence permits three attempts; no HTTP retries.
  for (let step = 0; step < 3; step += 1) {
    const config = getConfig();
    if (!config.enabled) return { skipped: true };
    const queued = await AssistantRun.findOne(customerRunFilter({ _id: id, status: "queued" })).lean();
    if (!queued) return { skipped: true };
    let prepared;
    try {
      const knowledgeBatch = await knowledgeForRun(id, config, retrieveKnowledge, queued);
      if (!knowledgeBatch) return { skipped: true };
      prepared = await prepareRun(id, getConfig(), knowledgeBatch);
    } catch (error) { await failPreparation(id, error, queued); return { failedBeforeDispatch: true }; }
    if (!prepared) return { skipped: true };
    if (prepared.skippedNormalization) continue;
    let adapter;
    try { adapter = adapterFactory(config); await externalWorkScope(prepared.run, getConfig(), "dispatching"); }
    catch (error) { await finishRun(prepared, null, error, { dispatched: false, currentConfig: { enabled: false } }); return { failedBeforeDispatch: true }; }
    let result;
    let error;
    try {
      result = await adapter.generate(prepared.request);
      if (result.serviceTier !== "default") {
        error = new AssistantProviderError("unverified_service_tier", { providerRequestId: result.providerRequestId, chargeExposure: "unknown" });
        result = null;
      } else result = unwrapReferenceResult(result, prepared.run.referencePreparationRequested === true);
    } catch (failure) { error = failure; }
    // Settlement failure leaves durable dispatching/reservation state for recovery, never retries HTTP.
    let currentConfig;
    try { currentConfig = getConfig(); } catch { currentConfig = { enabled: false }; }
    let productSearchBatch = null;
    let checkoutBatch = null;
    let bookingBatch = null;
    let canReadTools = false;
    try { canReadTools = prepared.run.phase !== "normalize" && result?.referenceAction !== "prepare" && result?.referenceAction !== "clarify" &&
      boundReferenceQuery(prepared.run)?.status !== "unclear"; }
    catch (failure) { error ??= failure; }
    if (!error && result && canReadTools && currentConfig.productSearchEnabled === true && prepared.run.catalogContext !== undefined) {
      try { productSearchBatch = await prepareProductSearch(prepared, result, currentConfig, { readProducts, readSemantic }); }
      catch (failure) {
        if (failure.code === "product_search_timeout") {
          const intent = productSearchIntent(result.structured, prepared.run);
          const context = productSearchContext(prepared.run.catalogContext, result.structured.replyLanguage);
          const warning = dietaryWarningObservation(result.structured, prepared.run, { kind: "publish" });
          productSearchBatch = { binding: productSearchBinding(prepared.run, intent, context, warning), result: { status: "unavailable", products: [] } };
        } else error = failure;
      }
    }
    if (!error && result && canReadTools && cartActionsEnabled(currentConfig) && prepared.run.catalogContext !== undefined) {
      try { checkoutBatch = await prepareCheckoutSummary(prepared, result, currentConfig, { readCheckout }); }
      catch (failure) { error = failure; }
    }
    if (!error && result && canReadTools && bookingReadsEnabled(currentConfig)) {
      try { bookingBatch = await prepareBookingOptions(prepared, result, currentConfig, { readBookingOptions }); }
      catch (failure) { error = failure; }
    }
    try { currentConfig = getConfig(); } catch { currentConfig = { enabled: false }; }
    const run = await finishRun(prepared, result, error, { currentConfig, productSearchBatch, checkoutBatch, bookingBatch });
    if (run?.status !== "queued" || !["normalize", "answer"].includes(run.phase)) return { status: run?.status ?? "already_settled" };
  }
  return { status: "queued" };
}

export async function drainAssistantRuns(options = {}) {
  const config = (options.getConfig ?? loadAssistantConfig)();
  if (!config.enabled) return { enabled: false, processed: 0 };
  requireEnabled(config);
  await recoverAssistantRuns(config);
  const candidates = await AssistantRun.find(customerRunFilter({ status: "queued" })).sort({ createdAt: 1 }).limit(25).select("_id").lean();
  for (const candidate of candidates) await processAssistantRun(candidate._id, options);
  return { enabled: true, processed: candidates.length };
}
