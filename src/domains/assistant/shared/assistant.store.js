import mongoose from "mongoose";
import { DateTime } from "luxon";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantChat, AssistantEvent,
  AssistantRun, assistantModels } from "./assistant.models.js";
import { expiry, periods, costMicroUsd, reservationMicroUsd } from "./assistant.config.js";
import { reject } from "./assistant.errors.js";
import { NotificationOutboxModel } from "../../notification/notificationOutbox.model.js";
import { customerRunFilter, runPurposes } from "./assistant.purpose.js";

let initialized;
let adminInitialized;
export async function initializeAssistantStore() {
  if (mongoose.connection.readyState !== 1) reject("assistant_accounting_unavailable", 503);
  initialized ??= (async () => {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") reject("assistant_transactions_required", 503);
    for (const model of [...Object.values(assistantModels), NotificationOutboxModel]) { await model.createCollection(); await model.createIndexes(); }
  })().catch((error) => { initialized = undefined; throw error; });
  return initialized;
}

export async function initializeAdminAssistantStore() {
  await initializeAssistantStore();
  adminInitialized ??= (async () => {
    for (const model of [AssistantAdminChat, AssistantAdminMessage]) { await model.createCollection(); await model.createIndexes(); }
  })().catch((error) => { adminInitialized = undefined; throw error; });
  return adminInitialized;
}

export async function transaction(callback) {
  await initializeAssistantStore();
  const session = await mongoose.startSession();
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await session.withTransaction(() => callback(session), {
          readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
        });
      } catch (error) { if (error.code !== 11000 || attempt >= 1) throw error; }
    }
  } finally { await session.endSession(); }
}

export async function getAccount(owner, session) {
  return AssistantAccount.findOneAndUpdate({ owner }, { $setOnInsert: { owner } }, { upsert: true, new: true, session });
}

export async function activeRunIdForPurpose(owner, account, purpose, session = null) {
  if (!Object.values(runPurposes).includes(purpose)) reject("invalid_request");
  if (!account?.activeRun) return null;
  const filter = { _id: account.activeRun, owner };
  const run = await AssistantRun.findOne(purpose === runPurposes.customer ? customerRunFilter(filter) : { ...filter, purpose })
    .select("_id").maxTimeMS(5000).session(session).lean();
  return run ? String(run._id) : null;
}

export async function getState(owner, session) {
  const account = await getAccount(owner, session);
  const chat = await AssistantChat.findOneAndUpdate({ owner }, { $setOnInsert: { owner } }, { upsert: true, new: true, session });
  return { account, chat };
}

export function assertAccess(account, config) {
  if (!config.enabled) reject("assistant_disabled", 503);
  if (account.blocked) reject("ai_restricted", 403);
}

export function admitMessage(account, config, now = new Date()) {
  assertAccess(account, config);
  if (account.activeRun) reject("active_request", 409);
  const period = periods(config, now);
  if (account.day !== period.day) { account.day = period.day; account.dayMessages = 0; }
  if (account.dayMessages >= config.dailyMessageLimit) reject("daily_message_limit", 429, period.dayReset);
  const rateReset = account.rateStart ? new Date(account.rateStart.getTime() + config.rateWindowSeconds * 1000) : now;
  if (!account.rateStart || rateReset <= now) { account.rateStart = now; account.rateCount = 0; }
  if (account.rateCount >= config.rateMax) reject("request_rate_limit", 429, new Date(account.rateStart.getTime() + config.rateWindowSeconds * 1000));
  account.rateCount += 1;
  account.dayMessages += 1;
  return period;
}

export async function event(owner, type, config, detail = {}, { session, run = null, actor = null } = {}) {
  const [record] = await AssistantEvent.create([{ owner, type, detail, run, actor, expiresAt: expiry(config.auditDays) }], { session });
  return record._id;
}

export async function reserveCost(owner, config, session, now = new Date()) {
  const period = periods(config, now);
  const amount = reservationMicroUsd(config);
  const control = await AssistantBudget.findOneAndUpdate({ _id: "control" },
    { $setOnInsert: { periodEnd: new Date("9999-01-01"), billingTimezone: config.timezone, openingExposure: config.openingExposure } }, { upsert: true, new: true, session });
  // A timezone change must be reconciled deliberately; it cannot open a second overlapping monthly allowance.
  const opening = control.openingExposure;
  if (control.frozen || control.billingTimezone !== config.timezone || !opening ||
      opening.month !== config.openingExposure.month || opening.microUsd !== config.openingExposure.microUsd) reject("assistant_accounting_unavailable", 503);
  const entries = [
    { id: `global:${period.month}`, limit: config.monthlyBudgetMicroUsd, end: period.monthReset, code: "monthly_budget_limit",
      opening: DateTime.fromISO(period.month).setZone(config.timezone).toFormat("yyyy-MM") === opening.month ? opening.microUsd : 0 },
    { id: `user:${owner}:${period.day}`, limit: config.dailyBudgetMicroUsd, end: period.dayReset, code: "daily_spending_limit" },
  ];
  for (const entry of entries) {
    await AssistantBudget.updateOne({ _id: entry.id }, { $setOnInsert: { periodEnd: entry.end, spent: entry.opening ?? 0 } }, { upsert: true, session });
    const updated = await AssistantBudget.updateOne({ _id: entry.id, frozen: false,
      $expr: { $lte: [{ $add: ["$spent", "$reserved", amount] }, entry.limit] } }, { $inc: { reserved: amount } }, { session });
    if (updated.modifiedCount !== 1) reject(entry.code, 429, entry.end);
  }
  return { amount, budgetIds: entries.map((entry) => entry.id), priceVersion: config.price.version,
    month: period.month, day: period.day, reservedAt: now };
}

// Caller fences settlement by attempt + accounting state inside the same transaction.
export async function settleCost(run, usage, session, { chargeReservation = false } = {}) {
  if (run.accounting !== "reserved" || !run.reservation) return false;
  const actual = chargeReservation ? run.reservation.amount : costMicroUsd(usage, run.config);
  if (actual === null) return false;
  for (const id of run.reservation.budgetIds) {
    const result = await AssistantBudget.updateOne({ _id: id, reserved: { $gte: run.reservation.amount } },
      { $inc: { reserved: -run.reservation.amount, spent: actual } }, { session });
    if (result.modifiedCount !== 1) reject("assistant_accounting_unavailable", 503);
  }
  if (actual > run.reservation.amount) await AssistantBudget.updateOne({ _id: "control" }, { $set: { frozen: true } }, { session });
  run.accounting = chargeReservation ? "charged_reservation" : "settled";
  run.usage = usage ?? null;
  run.chargedMicroUsd = actual;
  return true;
}

export async function unlock(run, session) {
  await AssistantAccount.updateOne({ owner: run.owner, activeRun: run._id }, { $set: { activeRun: null } }, { session });
}
