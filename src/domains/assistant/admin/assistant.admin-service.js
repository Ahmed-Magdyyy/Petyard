import { createHash } from "node:crypto";
import { AssistantAccount, AssistantAdminChat, AssistantAdminMessage, AssistantRun } from "../shared/assistant.models.js";
import { requireAnalyticsActor } from "./assistant.admin-access.js";
import { businessConfigSnapshot } from "./assistant.admin-policy.js";
import { requireEnabled, periods, expiry } from "../shared/assistant.config.js";
import { AssistantError, reject, businessNotices } from "../shared/assistant.errors.js";
import { messageDto, runDto, usageLimitsDto } from "../shared/assistant.dto.js";
import { fields, objectId, page, submission } from "../shared/assistant.validation.js";
import { activeRunIdForPurpose, admitMessage, event, getAccount, initializeAdminAssistantStore, transaction } from "../shared/assistant.store.js";
import { runPurposes } from "../shared/assistant.purpose.js";
import { reportHeader, reportCardDto } from "./assistant.admin-cards.js";

const purpose = runPurposes.adminBusiness;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const historyAllowed = (config) => config.blockedHistoryAllowed === true;
const businessMessageDto = (value) => {
  const { subjectId, ...dto } = messageDto(value);
  return value.outcome ? { ...dto, language: value.language, outcome: value.outcome, reportHeaders: (value.reportHeaders ?? []).map(reportHeader) } : dto;
};
const businessRunDto = (value) => {
  const { subjectId, ...dto } = runDto(value);
  return ["daily_spending_limit", "monthly_budget_limit"].includes(value.publicCode) ? { ...dto, message: businessNotices.limited } : dto;
};

// Actor identity comes from authenticated backend context, never the message body.
async function authorized(actorValue, config, operation, allowBlocked = false) {
  try {
    requireEnabled(config);
    const actor = objectId(String(actorValue));
    await requireAnalyticsActor(actor, { allowBlocked });
    const result = await operation(actor);
    requireEnabled(config);
    await requireAnalyticsActor(actor, { allowBlocked });
    return result;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    reject("assistant_unavailable", 503);
  }
}

async function businessState(actor, session) {
  const account = await getAccount(actor, session);
  const chat = await AssistantAdminChat.findOneAndUpdate({ owner: actor }, { $setOnInsert: { owner: actor } }, { upsert: true, new: true, session });
  return { account, chat };
}

export async function getBusinessMetadata(actorValue, config) {
  return authorized(actorValue, config, async (actor) => {
    const account = await AssistantAccount.findOne({ owner: actor }).select("blocked day dayMessages activeRun").maxTimeMS(5000).lean();
    let configured = true;
    try { businessConfigSnapshot(config); } catch (error) { if (!(error instanceof AssistantError)) throw error; configured = false; }
    return { identity: "Petyard's business assistant", available: configured && !account?.blocked,
      state: account?.blocked ? "restricted" : configured ? "available" : "unavailable",
      limits: usageLimitsDto(config, account, periods(config)), activeRunId: await activeRunIdForPurpose(actor, account, purpose),
      capabilities: { history: true, polling: true, streaming: false, analytics: true, bundleActions: false } };
  }, true);
}

export async function getBusinessChat(actorValue, config) {
  return authorized(actorValue, config, async (actor) => {
    await initializeAdminAssistantStore();
    return transaction(async (session) => {
      await requireAnalyticsActor(actor, { session, allowBlocked: historyAllowed(config) });
      const { account, chat } = await businessState(actor, session);
      return { id: String(chat._id), contextVersion: chat.contextVersion,
        activeRunId: await activeRunIdForPurpose(actor, account, purpose, session) };
    });
  }, historyAllowed(config));
}

export async function getBusinessHistory(actorValue, query, config) {
  const pagination = page(query);
  return authorized(actorValue, config, async (actor) => {
    const messages = await AssistantAdminMessage.find({ owner: actor, sequence: { $lt: pagination.before }, expiresAt: { $gt: new Date() } })
      .sort({ sequence: -1 }).limit(pagination.limit + 1).maxTimeMS(5000).lean();
    const selected = messages.slice(0, pagination.limit);
    return { messages: selected.map(businessMessageDto), nextBefore: messages.length > pagination.limit ? selected.at(-1).sequence : null,
      order: "newest_first" };
  }, historyAllowed(config));
}

export async function submitBusinessMessage(actorValue, body, clientKey, config) {
  requireEnabled(config);
  fields(body, ["text"]);
  const input = submission(body, clientKey, config);
  const key = `admin-business/${input.key}`;
  const inputHash = hash({ purpose, text: input.text });
  return authorized(actorValue, config, async (actor) => {
    await initializeAdminAssistantStore();
    const result = await transaction(async (session) => {
      const access = await requireAnalyticsActor(actor, { session, allowBlocked: historyAllowed(config) });
      const existing = await AssistantRun.findOne({ owner: actor, key, purpose }).session(session);
      if (existing) {
        if (existing.hash !== inputHash) reject("idempotency_conflict", 409);
        return { run: businessRunDto(existing), duplicate: true };
      }
      if (access.account?.blocked) reject("ai_restricted", 403);
      const configSnapshot = businessConfigSnapshot(config);
      const { account, chat } = await businessState(actor, session);
      const now = new Date();
      admitMessage(account, config, now);
      chat.nextSequence += 1;
      const [run] = await AssistantRun.create([{ owner: actor, chat: chat._id, purpose, key, hash: inputHash, status: "queued", phase: "plan",
        input: input.text, userSequence: chat.nextSequence, contextVersion: chat.contextVersion, config: configSnapshot,
        deadline: new Date(now.getTime() + config.queueTimeoutMs) }], { session });
      await AssistantAdminMessage.create([{ owner: actor, chat: chat._id, run: run._id, sequence: chat.nextSequence,
        role: "user", text: input.text, expiresAt: expiry(config.historyDays, now) }], { session });
      account.activeRun = run._id;
      await account.save({ session }); await chat.save({ session });
      await event(actor, "message_accepted", config, { purpose }, { session, run: run._id });
      return { run: businessRunDto(run), duplicate: false };
    });
    if (!result.duplicate) await requireAnalyticsActor(actor);
    return result;
  }, historyAllowed(config));
}

export async function getBusinessRun(actorValue, id, config) {
  const runId = objectId(id);
  return authorized(actorValue, config, async (actor) => {
    const run = await AssistantRun.findOne({ _id: runId, owner: actor, purpose }).maxTimeMS(5000).lean();
    if (!run) reject("run_not_found", 404);
    const message = run.responseMessage ? await AssistantAdminMessage.findOne({ _id: run.responseMessage, owner: actor,
      chat: run.chat, run: run._id, role: "assistant", expiresAt: { $gt: new Date() } }).maxTimeMS(5000).lean() : null;
    return { run: businessRunDto(run), message: message ? businessMessageDto(message) : null,
      reports: run.status === "completed" && message ? (run.adminReports ?? []).map(reportCardDto) : [] };
  }, historyAllowed(config));
}
