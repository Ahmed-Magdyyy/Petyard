import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import mongoose from "mongoose";
import { AssistantAccount, AssistantRun } from "../shared/assistant.models.js";
import { requireEnabled, expiry, loadAssistantConfig } from "../shared/assistant.config.js";
import { transaction, getAccount, reserveCost, settleCost, unlock, event } from "../shared/assistant.store.js";
import { recordAttempt } from "../shared/assistant.attempts.js";
import { runPurposes } from "../shared/assistant.purpose.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { requireAnalyticsActor } from "../admin/assistant.admin-access.js";
import { createAssistantAdapter } from "../providers/assistantProvider.js";
import { AssistantProviderError } from "../providers/providerContract.js";
import { ManualBundle } from "../../bundle/bundle.model.js";
import * as bundles from "../../bundle/bundle.repository.js";
import { previewFixedBundle } from "../../bundle/bundle.components.js";
import { bundleOriginalPricePiastres } from "../../bundle/bundle.product-card.js";
import { isWarehouseOperational } from "../../warehouse/warehouse.fulfillment.js";
import { readBundleEvidence, BUNDLE_SELECTION_VERSION } from "./assistant.bundle-evidence.js";
import { buildBundleGenerationRequest, bundleComponentSignature, BUNDLE_PROMPT_VERSION, validateBundlePlan } from "./assistant.bundle-plan.js";

const purpose = runPurposes.automaticBundles;
const queued = id => ({ _id: id, purpose, status: "queued", accounting: "none" });
const noUsage = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
const hash = value => createHash("sha256").update(value).digest("hex");

export function bundleGenerationConfig(config) {
  requireEnabled(config);
  if (config.bundleGenerationEnabled !== true || config.bundleCartEnabled !== true ||
      typeof config.bundleGenerationOwner !== "string" || !/^[a-f\d]{24}$/.test(config.bundleGenerationOwner)) reject("bundle_generation_disabled", 503);
  return { ...config, baseSignature: config.signature, bundleSelectionVersion: BUNDLE_SELECTION_VERSION, bundlePromptVersion: BUNDLE_PROMPT_VERSION,
    signature: hash(JSON.stringify({ base: config.signature, owner: config.bundleGenerationOwner, purpose,
      selection: BUNDLE_SELECTION_VERSION, prompt: BUNDLE_PROMPT_VERSION })) };
}

export function bundleWeek(now = new Date()) {
  const start = DateTime.fromJSDate(now, { zone: "Africa/Cairo" }).startOf("week");
  if (!start.isValid) reject("invalid_bundle_schedule", 503);
  const week = start.toISODate();
  return { week, end: start.toJSDate(), id: new mongoose.Types.ObjectId(hash(`${purpose}/${week}`).slice(0, 24)) };
}

async function requireScope(run, config, session = null) {
  const current = bundleGenerationConfig(config);
  if (run.config.signature !== current.signature || String(run.owner) !== current.bundleGenerationOwner) reject("configuration_changed", 503);
  const { user } = await requireAnalyticsActor(run.owner, { session });
  if (user.role !== "superAdmin" || user.passwordChangedAT && user.passwordChangedAT > run.createdAt) reject("access_denied", 403);
  const account = await AssistantAccount.findOne({ owner: run.owner }).session(session).maxTimeMS(5000).lean();
  if (!account || String(account.activeRun) !== String(run._id) || account.blocked) reject("active_request_changed", 409);
}

export async function enqueueWeeklyBundleGeneration(config, now = new Date()) {
  if (config.bundleGenerationEnabled !== true) return { enabled: false };
  const snapshot = bundleGenerationConfig(config), schedule = bundleWeek(now);
  // The global deterministic _id prevents a second weekly run even after owner/config changes.
  if (await AssistantRun.findById(schedule.id).select("_id").maxTimeMS(5000).lean()) return { duplicate: true };
  await bundles.requireBundleCatalogStore();
  return transaction(async session => {
    const { user } = await requireAnalyticsActor(snapshot.bundleGenerationOwner, { session });
    if (user.role !== "superAdmin") reject("access_denied", 403);
    if (await AssistantRun.findById(schedule.id).session(session)) return { duplicate: true };
    const account = await getAccount(user._id, session);
    if (account.activeRun) return { deferred: true };
    const [run] = await AssistantRun.create([{ _id: schedule.id, owner: user._id, chat: user._id, purpose,
      key: `automatic-bundles/${schedule.week}`, hash: hash(`${purpose}/${schedule.week}`), status: "queued", phase: "plan",
      input: "Automatic weekly bundle draft generation", userSequence: 0, contextVersion: 0, config: snapshot,
      bundleWindowEnd: schedule.end, deadline: new Date(now.getTime() + config.queueTimeoutMs) }], { session });
    account.activeRun = run._id; await account.save({ session });
    await event(run.owner, "bundle_generation_queued", config, { purpose, week: schedule.week }, { session, run: run._id });
    return { queued: true, runId: String(run._id) };
  });
}

async function fail(run, error, session) {
  run.status = "failed";
  run.publicCode = error instanceof AssistantError ? error.code : "bundle_generation_unavailable";
  run.internalCode = error.code ?? "bundle_generation_failed";
  run.retryAt = error.retryAt ?? null;
  run.expiresAt = expiry(Math.max(run.config.runDays, 8));
  if (run.attempt) recordAttempt(run);
  await run.save({ session }); await unlock(run, session);
  await event(run.owner, run.attempt ? "run_failed_after_dispatch" : "run_failed_before_dispatch", run.config,
    { purpose, code: run.internalCode }, { session, run: run._id });
}

export async function prepareBundleGeneration(id, config, evidenceReader = readBundleEvidence) {
  const candidate = await AssistantRun.findOne(queued(id)).maxTimeMS(5000).lean();
  if (!candidate) return null;
  await requireScope(candidate, config);
  if (!candidate.deadline || candidate.deadline <= new Date()) reject("queue_expired", 503);
  const context = buildBundleGenerationRequest(await evidenceReader(candidate.bundleWindowEnd), config);
  return transaction(async session => {
    const run = await AssistantRun.findOne(queued(id)).session(session);
    if (!run) return null;
    await requireScope(run, config, session);
    if (run.attempts.length || run.attempt || run.reservation) reject("assistant_attempt_limit", 503);
    if (!run.deadline || run.deadline <= new Date()) reject("queue_expired", 503);
    run.bundleSourceJson = JSON.stringify({ evidence: context.evidence, discovery: context.discovery });
    const viable = context.evidence.warehouses.some(warehouse => new Set(context.evidence.offers.filter(offer =>
      offer.availability.some(row => row.warehouseId === warehouse.id && row.availableUnits > 0)).map(offer => offer.productId)).size >= 2);
    if (!viable) {
      run.status = "completed"; run.bundleDraftIds = []; run.expiresAt = expiry(Math.max(run.config.runDays, 8));
      await run.save({ session }); await unlock(run, session);
      await event(run.owner, "run_completed", run.config, { purpose, draftCount: 0 }, { session, run: run._id });
      return null;
    }
    run.reservation = await reserveCost(run.owner, config, session);
    run.accounting = "reserved"; run.attempt = randomUUID();
    run.attempts.push({ id: run.attempt, number: 1, phase: "plan", contextVersion: 0,
      reservation: run.reservation, accounting: "reserved", dispatchedAt: new Date() });
    run.status = "dispatching"; run.dispatchDeadline = new Date(Date.now() + config.timeoutMs + 30000);
    await run.save({ session });
    await event(run.owner, "provider_attempt_reserved", config, { purpose, attemptId: run.attempt, number: 1, phase: "plan",
      amount: run.reservation.amount, provider: config.provider, model: config.model, priceVersion: config.price.version }, { session, run: run._id });
    return { run: run.toObject(), request: context.request };
  });
}

export async function finishBundleGeneration(prepared, result, error, { dispatched = true, currentConfig } = {}) {
  if (prepared.run.purpose !== purpose) return null;
  return transaction(async session => {
    const run = await AssistantRun.findOne({ _id: prepared.run._id, owner: prepared.run.owner, purpose,
      attempt: prepared.run.attempt, status: { $in: ["dispatching", "uncertain"] }, accounting: "reserved" }).session(session);
    if (!run) return null;
    const usage = !dispatched ? noUsage : result && result.serviceTier !== "default" ? null : result?.usage ?? error?.usage ?? null;
    const settled = await settleCost(run, usage, session);
    run.providerRequestId = result?.providerRequestId ?? error?.providerRequestId ?? null;
    run.latencyMs = result?.latencyMs ?? error?.latencyMs ?? null;
    run.internalCode = error?.code ?? null; recordAttempt(run);
    if (!settled) {
      run.status = "uncertain"; run.publicCode = "request_needs_review";
      await run.save({ session });
      await event(run.owner, "provider_charge_uncertain", run.config, { purpose }, { session, run: run._id });
      return run;
    }
    let drafts, source;
    try {
      await requireScope(run, currentConfig ?? { enabled: false }, session);
      if (error) throw error;
      if (result?.serviceTier !== "default" || result?.finishReason !== "completed" || result?.toolCalls?.length) reject("invalid_bundle_plan", 503);
      source = JSON.parse(run.bundleSourceJson);
      drafts = validateBundlePlan(result.structured, source.evidence, run.config.maxOutputChars);
    } catch (failure) { await fail(run, failure, session); return run; }
    await bundles.requireBundleCatalogStore();
    const existing = await ManualBundle.find({ status: { $in: ["draft", "published", "paused"] } }).select("components")
      .limit(5001).maxTimeMS(5000).session(session).lean();
    if (existing.length > 5000) reject("bundle_review_store_unavailable", 503);
    const signatures = new Set(existing.map(row => bundleComponentSignature(row.components.map(component => ({ productId: String(component.productId),
      productType: component.productType, variantId: component.variantId == null ? null : String(component.variantId), quantity: component.quantity })))));
    const accepted = [];
    try {
      for (const draft of drafts) {
        if (signatures.has(draft.evidence.signature)) continue;
        const products = await bundles.findBundleProducts(draft.components.map(component => component.productId));
        const warehouses = await bundles.findBundleWarehouses(source.evidence.warehouses.map(row => row.id));
        // Validate every proposal before inserting any, so ordinary stock changes can settle known usage without partial drafts.
        if (bundleOriginalPricePiastres(draft.components, products) <= 0) reject("bundle_price_changed", 409);
        if (!warehouses.some(warehouse => isWarehouseOperational(warehouse) && previewFixedBundle({ components: draft.components,
          pricePiastres: 0, warehouseId: String(warehouse._id), products }).availableBundles > 0)) reject("bundle_stock_changed", 409);
        accepted.push(draft);
      }
    } catch (failure) {
      if (!(failure instanceof AssistantError) && !/^BUNDLE_/.test(failure.code ?? "")) throw failure;
      await fail(run, failure, session); return run;
    }
    const draftIds = [];
    for (const draft of accepted) {
      const { evidence, ...definition } = draft;
      const draftId = new mongoose.Types.ObjectId();
      await ManualBundle.create([{ _id: draftId, ...definition, origin: "ai", status: "draft", revision: 1,
        createdBy: run.owner, updatedBy: run.owner,
        aiEvidenceJson: JSON.stringify({ ...evidence, runId: String(run._id), discovery: source.discovery,
          source: { provider: run.config.provider, model: run.config.model, reasoningEffort: run.config.reasoningEffort,
            promptVersion: BUNDLE_PROMPT_VERSION, generatedAt: new Date().toISOString() } }) }], { session });
      draftIds.push(draftId);
    }
    run.bundleDraftIds = draftIds; run.status = "completed"; run.publicCode = null; run.internalCode = null;
    run.expiresAt = expiry(Math.max(run.config.runDays, 8)); recordAttempt(run);
    await run.save({ session }); await unlock(run, session);
    await event(run.owner, "run_completed", run.config, { purpose, draftCount: draftIds.length }, { session, run: run._id });
    return run;
  });
}

export async function processBundleGeneration(id, { getConfig = loadAssistantConfig, adapterFactory = createAssistantAdapter,
  evidenceReader = readBundleEvidence } = {}) {
  const config = getConfig();
  if (!config.enabled || config.bundleGenerationEnabled !== true) return { skipped: true };
  let prepared;
  try { prepared = await prepareBundleGeneration(id, config, evidenceReader); }
  catch (error) {
    await transaction(async session => { const run = await AssistantRun.findOne(queued(id)).session(session); if (run) await fail(run, error, session); });
    return { failedBeforeDispatch: true };
  }
  if (!prepared) return { skipped: true };
  let adapter;
  try {
    adapter = adapterFactory(config);
    const live = await AssistantRun.findOne({ _id: id, purpose, attempt: prepared.run.attempt, status: "dispatching", accounting: "reserved" })
      .maxTimeMS(5000).lean();
    if (!live || live.dispatchDeadline <= new Date()) reject("context_changed", 409);
    await requireScope(live, getConfig());
  } catch (error) {
    await finishBundleGeneration(prepared, null, error, { dispatched: false, currentConfig: { enabled: false } });
    return { failedBeforeDispatch: true };
  }
  let result, error;
  try {
    result = await adapter.generate(prepared.request);
    if (result.serviceTier !== "default") {
      error = new AssistantProviderError("unverified_service_tier", { providerRequestId: result.providerRequestId, chargeExposure: "unknown" });
      result = null;
    }
  } catch (failure) { error = failure; }
  let currentConfig;
  try { currentConfig = getConfig(); } catch { currentConfig = { enabled: false }; }
  const run = await finishBundleGeneration(prepared, result, error, { currentConfig });
  return { status: run?.status ?? "already_settled" };
}

export async function recoverBundleGenerations(config, now = new Date()) {
  const candidates = await AssistantRun.find({ purpose, $or: [
    { status: "dispatching", dispatchDeadline: { $lte: now } }, { status: "queued", accounting: "none", deadline: { $lte: now } },
  ] }).select("_id").sort({ createdAt: 1 }).limit(100).maxTimeMS(5000).lean();
  for (const candidate of candidates) await transaction(async session => {
    const run = await AssistantRun.findOne({ _id: candidate._id, purpose }).session(session);
    if (run?.status === "queued" && run.accounting === "none" && !run.attempts.length && run.deadline <= now) {
      await fail(run, new AssistantError("queue_expired", 503), session);
    } else if (run?.status === "dispatching" && run.accounting === "reserved" && run.dispatchDeadline <= now) {
      run.status = "uncertain"; run.publicCode = "request_needs_review"; run.internalCode = "worker_dispatch_interrupted";
      recordAttempt(run); await run.save({ session });
      await event(run.owner, "interrupted_attempt_needs_review", run.config, { purpose }, { session, run: run._id });
    }
  });
  return candidates.length;
}
