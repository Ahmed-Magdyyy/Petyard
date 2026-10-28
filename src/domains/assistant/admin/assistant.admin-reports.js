import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AssistantAdminMessage, AssistantRun } from "../shared/assistant.models.js";
import { loadAssistantConfig, expiry, requireEnabled } from "../shared/assistant.config.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { event, transaction, unlock } from "../shared/assistant.store.js";
import { runPurposes } from "../shared/assistant.purpose.js";
import { requireBusinessRunScope } from "./assistant.admin-worker.js";
import { ADMIN_PLAN_VERSION, validateAdminPlan } from "./assistant.admin-plan.js";
import { executeAdminAnalyticsTool } from "./assistant.admin-analytics.js";
import { assertCardBounds, snapshotCard, unavailableCard, reportHeader } from "./assistant.admin-cards.js";
import { renderBusinessResponse } from "./assistant.admin-render.js";

const purpose = runPurposes.adminBusiness;
const reportsFilter = (id, more = {}) => ({ _id: id, purpose, phase: "reports", accounting: "settled", ...more });
const recoverableReportErrors = new Set(["analytics_unavailable", "analytics_arguments_invalid", "invalid_report_snapshot", "report_snapshot_too_large"]);
const plain = (value) => value?.toObject ? value.toObject() : value;
function savedPlan(run) {
  const plan = plain(run.adminPlan);
  if (plan?.version !== ADMIN_PLAN_VERSION || !Array.isArray(plan.reports) || run.attempts.length !== 1 || run.attempts[0].phase !== "plan" ||
      run.attempts[0].accounting !== "settled") reject("invalid_admin_plan", 503);
  return validateAdminPlan({ outcome: plan.outcome, language: plan.language, clarification: plan.clarification,
    reports: plan.reports.map((report) => ({ tool: report.tool,
      arguments: { compareTo: null, metric: null, warehouse: null, limit: null, ...report.arguments } })) },
  { maxChars: run.config.maxOutputChars, allowedWarehouseIds: run.adminWarehouseIds ?? [] });
}
const leaseUntil = (run) => new Date(Math.min(new Date(run.deadline).getTime(), Date.now() + 30000));
function notExpired(run, leased = false) {
  if (!run.deadline || run.deadline <= new Date()) reject("report_stage_expired", 503);
  if (leased && (!run.reportLeaseUntil || run.reportLeaseUntil <= new Date())) reject("report_claim_changed", 409);
}

async function failReports(id, error, lease = null) {
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(reportsFilter(id, lease ? { status: "dispatching", reportLease: lease }
      : { status: "queued" })).session(session);
    if (!run) return;
    run.status = "failed";
    run.publicCode = error instanceof AssistantError ? error.code : "analytics_unavailable";
    run.internalCode = run.publicCode;
    run.reportLease = null; run.reportLeaseUntil = null;
    run.expiresAt = expiry(run.config.runDays);
    await run.save({ session }); await unlock(run, session);
    await event(run.owner, "run_failed_after_dispatch", run.config, { purpose, phase: "reports", code: run.publicCode }, { session, run: run._id });
  });
}

async function claim(id, config) {
  return transaction(async (session) => {
    const run = await AssistantRun.findOne(reportsFilter(id, { status: "queued" })).session(session);
    if (!run) return null;
    await requireBusinessRunScope(run, config, session); notExpired(run);
    const plan = savedPlan(run);
    assertCardBounds(run.adminReports ?? [], config);
    run.status = "dispatching";
    run.reportLease = randomUUID(); run.reportLeaseUntil = leaseUntil(run);
    await run.save({ session });
    return { id: run._id, owner: run.owner, lease: run.reportLease, plan };
  });
}

async function liveRun(prepared, config, session = null) {
  const query = AssistantRun.findOne(reportsFilter(prepared.id, { owner: prepared.owner, status: "dispatching", reportLease: prepared.lease }))
    .maxTimeMS(5000).session(session);
  const run = session ? await query : await query.lean();
  if (!run) reject("report_claim_changed", 409);
  await requireBusinessRunScope(run, config, session); notExpired(run, true);
  if (JSON.stringify(savedPlan(run)) !== JSON.stringify(prepared.plan)) reject("context_changed", 409);
  return run;
}

async function persistCard(prepared, card, config) {
  return transaction(async (session) => {
    const run = await liveRun(prepared, config, session);
    if ((run.adminReports ?? []).some((stored) => stored.id === card.id)) return;
    const cards = [...(run.adminReports ?? []).map(plain), card]; assertCardBounds(cards, config);
    run.adminReports = cards; run.reportLeaseUntil = leaseUntil(run);
    await run.save({ session });
  });
}

async function publish(prepared, config) {
  return transaction(async (session) => {
    const run = await liveRun(prepared, config, session);
    const chat = await requireBusinessRunScope(run, config, session);
    const cards = prepared.plan.reports.map((invocation, index) => {
      const card = (run.adminReports ?? []).map(plain).find((value) => value.id === `report-${index + 1}`);
      if (!card || card.tool !== invocation.tool || !isDeepStrictEqual(card.arguments, invocation.arguments)) reject("invalid_report_snapshot", 503);
      return card;
    });
    if ((run.adminReports ?? []).length !== cards.length) reject("invalid_report_snapshot", 503);
    assertCardBounds(cards, config);
    const response = renderBusinessResponse(prepared.plan, cards, config);
    chat.nextSequence += 1;
    const [message] = await AssistantAdminMessage.create([{ owner: run.owner, chat: run.chat, run: run._id,
      sequence: chat.nextSequence, role: "assistant", ...response, reportHeaders: cards.map(reportHeader), reportIntent: prepared.plan.reports,
      expiresAt: expiry(config.historyDays) }], { session });
    run.responseMessage = message._id; run.status = "completed";
    run.reportLease = null; run.reportLeaseUntil = null; run.publicCode = null;
    run.expiresAt = expiry(config.runDays);
    await chat.save({ session }); await run.save({ session }); await unlock(run, session);
    await event(run.owner, "run_completed", config, { purpose, phase: "reports", outcome: response.outcome, reportCount: cards.length,
      successfulReports: cards.filter((card) => card.status === "success").length }, { session, run: run._id });
    return { status: "completed" };
  });
}

export async function processBusinessReports(id, { getConfig = loadAssistantConfig, executeReport = executeAdminAnalyticsTool } = {}) {
  const config = getConfig();
  if (!config.enabled) return { skipped: true };
  let prepared;
  try { prepared = await claim(id, config); }
  catch (error) {
    if (!(error instanceof AssistantError)) throw error;
    await failReports(id, error); return { status: "failed" };
  }
  if (!prepared) return { skipped: true };
  try {
    for (const [index, invocation] of prepared.plan.reports.entries()) {
      const live = await liveRun(prepared, getConfig());
      if ((live.adminReports ?? []).some((card) => card.id === `report-${index + 1}`)) continue;
      let card;
      try {
        const result = await executeReport(prepared.owner, invocation, { getConfig });
        card = snapshotCard(invocation, index, result, config, prepared.plan.reports.length);
      } catch (error) {
        if (!recoverableReportErrors.has(error.code)) throw error;
        card = unavailableCard(invocation, index, error.code);
      }
      await persistCard(prepared, card, getConfig());
    }
    return await publish(prepared, getConfig());
  } catch (error) {
    // Leave storage outages at their durable boundary; lease recovery preserves already saved cards.
    if (!(error instanceof AssistantError)) throw error;
    await failReports(id, error, prepared.lease);
    return { status: error.code === "report_claim_changed" ? "superseded" : "failed" };
  }
}

export async function recoverBusinessReports(config, now = new Date()) {
  requireEnabled(config);
  const candidates = await AssistantRun.find({ purpose, phase: "reports", accounting: "settled", $or: [
    { status: "queued", deadline: { $lte: now } }, { status: "dispatching", reportLeaseUntil: { $lte: now } },
  ] }).sort({ createdAt: 1 }).limit(100).select("_id").maxTimeMS(5000).lean();
  for (const candidate of candidates) await transaction(async (session) => {
    const run = await AssistantRun.findOne(reportsFilter(candidate._id, { status: { $in: ["queued", "dispatching"] } })).session(session);
    if (!run) return;
    if (run.deadline <= now) {
      run.status = "failed"; run.publicCode = "report_stage_expired"; run.internalCode = run.publicCode;
      run.reportLease = null; run.reportLeaseUntil = null; run.expiresAt = expiry(run.config.runDays);
      await run.save({ session }); await unlock(run, session);
      await event(run.owner, "run_failed_after_dispatch", run.config, { purpose, phase: "reports", code: run.publicCode }, { session, run: run._id });
    } else if (run.status === "dispatching" && run.reportLeaseUntil <= now) {
      run.status = "queued"; run.reportLease = null; run.reportLeaseUntil = null;
      await run.save({ session });
    }
  });
  return candidates.length;
}
