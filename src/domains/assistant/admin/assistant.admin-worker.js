import { randomUUID } from "node:crypto";
import { AssistantAccount, AssistantAdminChat, AssistantRun } from "../shared/assistant.models.js";
import { loadAssistantConfig, requireEnabled, expiry } from "../shared/assistant.config.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { event, reserveCost, settleCost, transaction, unlock } from "../shared/assistant.store.js";
import { requireAnalyticsActor } from "./assistant.admin-access.js";
import { buildBusinessContext } from "./assistant.admin-context.js";
import { businessConfigSnapshot } from "./assistant.admin-policy.js";
import { ADMIN_PLAN_VERSION, validateAdminPlan } from "./assistant.admin-plan.js";
import { recordAttempt } from "../shared/assistant.attempts.js";
import { runPurposes } from "../shared/assistant.purpose.js";
import { createAssistantAdapter } from "../providers/assistantProvider.js";
import { AssistantProviderError } from "../providers/providerContract.js";

const purpose = runPurposes.adminBusiness;
const noUsage = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 });
const queuedFilter = (id) => ({ _id: id, purpose, phase: "plan", status: "queued", accounting: "none" });

function sameConfig(run, config) {
  requireEnabled(config);
  const expected = businessConfigSnapshot(config);
  if (run.config.signature !== expected.signature || run.config.adminPromptVersion !== expected.adminPromptVersion ||
      run.config.adminPlanVersion !== expected.adminPlanVersion || run.config.adminRenderVersion !== expected.adminRenderVersion) reject("configuration_changed", 503);
}

export async function requireBusinessRunScope(run, config, session = null) {
  sameConfig(run, config);
  const { user } = await requireAnalyticsActor(run.owner, { session });
  if (user.passwordChangedAT && user.passwordChangedAT > run.createdAt) reject("access_denied", 403);
  const account = await AssistantAccount.findOne({ owner: run.owner }).session(session).maxTimeMS(5000).lean();
  const chat = await AssistantAdminChat.findOne({ _id: run.chat, owner: run.owner }).session(session).maxTimeMS(5000);
  if (!account || String(account.activeRun) !== String(run._id)) reject("active_request_changed", 409);
  if (account.blocked) reject("ai_restricted", 403);
  if (!chat || chat.contextVersion !== run.contextVersion) reject("context_changed", 409);
  return chat;
}

async function failRun(run, error, session, afterDispatch) {
  run.status = "failed";
  run.publicCode = error instanceof AssistantError ? error.code : "assistant_response_unavailable";
  run.internalCode = error.code ?? "admin_planning_failed";
  run.retryAt = error.retryAt ?? null;
  run.expiresAt = expiry(run.config.runDays);
  if (afterDispatch) recordAttempt(run);
  await run.save({ session });
  await unlock(run, session);
  await event(run.owner, afterDispatch ? "run_failed_after_dispatch" : "run_failed_before_dispatch", run.config,
    { purpose, code: run.internalCode }, { session, run: run._id });
}

export async function prepareBusinessPlan(id, config) {
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(queuedFilter(id)).session(session);
    if (!run) return null;
    if (run.attempts.length || run.attempt || run.reservation) reject("assistant_attempt_limit", 503);
    const chat = await requireBusinessRunScope(run, config, session);
    if (!run.deadline || run.deadline <= new Date()) reject("queue_expired", 503);
    const { request, allowedWarehouseIds } = await buildBusinessContext(run, chat, config, session);
    // Reserve through the same global and per-owner ledger used by customer chat.
    run.reservation = await reserveCost(run.owner, config, session);
    run.accounting = "reserved";
    run.attempt = randomUUID();
    run.attempts.push({ id: run.attempt, number: 1, phase: "plan", contextVersion: run.contextVersion,
      reservation: run.reservation, accounting: "reserved", dispatchedAt: new Date() });
    run.adminWarehouseIds = allowedWarehouseIds;
    run.status = "dispatching";
    run.dispatchDeadline = new Date(Date.now() + config.timeoutMs + 30000);
    await run.save({ session });
    await event(run.owner, "provider_attempt_reserved", config, { purpose, attemptId: run.attempt, number: 1, phase: "plan",
      amount: run.reservation.amount, provider: config.provider, model: config.model, priceVersion: config.price.version }, { session, run: run._id });
    return { run: run.toObject(), request };
  });
}

async function failPreparation(id, error) {
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(queuedFilter(id)).session(session);
    if (!run || run.attempts.length || run.attempt || run.reservation) return;
    await failRun(run, error, session, false);
  });
}

export async function finishBusinessPlan(prepared, result, error, { dispatched = true, currentConfig } = {}) {
  if (prepared.run.purpose !== purpose) return null;
  return transaction(async (session) => {
    const run = await AssistantRun.findOne({ _id: prepared.run._id, owner: prepared.run.owner, purpose, phase: "plan", attempt: prepared.run.attempt,
      status: { $in: ["dispatching", "uncertain"] }, accounting: "reserved" }).session(session);
    if (!run) return null;
    const settled = await settleCost(run, dispatched ? (result?.usage ?? error?.usage ?? null) : noUsage, session);
    run.providerRequestId = result?.providerRequestId ?? error?.providerRequestId ?? null;
    run.latencyMs = result?.latencyMs ?? error?.latencyMs ?? null;
    run.internalCode = error?.code ?? null;
    recordAttempt(run);
    if (!settled) {
      run.status = "uncertain";
      run.publicCode = "request_needs_review";
      await run.save({ session });
      await event(run.owner, "provider_charge_uncertain", run.config, { purpose, code: run.internalCode }, { session, run: run._id });
      return run;
    }
    let plan;
    try {
      await requireBusinessRunScope(run, currentConfig ?? { enabled: false }, session);
      if (error) throw error;
      if (result?.finishReason !== "completed" || result?.serviceTier !== "default" || result?.toolCalls?.length) reject("invalid_admin_plan", 503);
      plan = validateAdminPlan(result?.structured, { maxChars: run.config.maxOutputChars, allowedWarehouseIds: run.adminWarehouseIds ?? [] });
    } catch (failure) { await failRun(run, failure, session, true); return run; }
    run.adminPlan = { version: ADMIN_PLAN_VERSION, ...plan };
    run.phase = "reports";
    run.status = "queued";
    run.publicCode = null;
    run.internalCode = null;
    run.dispatchDeadline = null;
    run.deadline = new Date(Date.now() + run.config.queueTimeoutMs);
    recordAttempt(run);
    await run.save({ session });
    await event(run.owner, "admin_plan_ready", run.config, { purpose, outcome: plan.outcome, reportCount: plan.reports.length }, { session, run: run._id });
    // Keep the active lock until the backend executes/renders this saved plan. No second model call.
    return run;
  });
}

export async function processBusinessPlan(id, { getConfig = loadAssistantConfig, adapterFactory = createAssistantAdapter } = {}) {
  const config = getConfig();
  if (!config.enabled) return { skipped: true };
  let prepared;
  try { prepared = await prepareBusinessPlan(id, config); }
  catch (error) { await failPreparation(id, error); return { failedBeforeDispatch: true }; }
  if (!prepared) return { skipped: true };
  let adapter;
  try {
    adapter = adapterFactory(config);
    const live = await AssistantRun.findOne({ _id: id, owner: prepared.run.owner, purpose, phase: "plan", status: "dispatching",
      attempt: prepared.run.attempt, accounting: "reserved" }).maxTimeMS(5000).lean();
    if (!live || live.dispatchDeadline <= new Date()) reject("context_changed", 409);
    await requireBusinessRunScope(live, getConfig());
  } catch (error) {
    await finishBusinessPlan(prepared, null, error, { dispatched: false, currentConfig: { enabled: false } });
    return { failedBeforeDispatch: true };
  }
  let result;
  let error;
  try {
    result = await adapter.generate(prepared.request);
    if (result.serviceTier !== "default") {
      error = new AssistantProviderError("unverified_service_tier", { providerRequestId: result.providerRequestId, chargeExposure: "unknown" });
      result = null;
    }
  } catch (failure) { error = failure; }
  let currentConfig;
  try { currentConfig = getConfig(); } catch { currentConfig = { enabled: false }; }
  // A settlement failure leaves the reservation/dispatch record durable. Never retry the paid call.
  const run = await finishBusinessPlan(prepared, result, error, { currentConfig });
  return { status: run?.status ?? "already_settled", phase: run?.phase ?? null };
}

export async function recoverBusinessPlans(config, now = new Date()) {
  requireEnabled(config);
  const candidates = await AssistantRun.find({ purpose, phase: "plan", $or: [
    { status: "dispatching", dispatchDeadline: { $lte: now } }, { status: "queued", accounting: "none", deadline: { $lte: now } },
  ] }).sort({ createdAt: 1 }).limit(100).select("_id").maxTimeMS(5000).lean();
  for (const candidate of candidates) await transaction(async (session) => {
    const run = await AssistantRun.findOne({ _id: candidate._id, purpose, phase: "plan" }).session(session);
    if (!run) return;
    if (run.status === "queued" && run.accounting === "none" && !run.attempts.length && run.deadline <= now) {
      await failRun(run, new AssistantError("queue_expired", 503), session, false);
    } else if (run.status === "dispatching" && run.accounting === "reserved" && run.dispatchDeadline <= now) {
      run.status = "uncertain";
      run.publicCode = "request_needs_review";
      run.internalCode = "worker_dispatch_interrupted";
      recordAttempt(run);
      await run.save({ session });
      await event(run.owner, "interrupted_attempt_needs_review", run.config, { purpose }, { session, run: run._id });
    }
  });
  return candidates.length;
}
