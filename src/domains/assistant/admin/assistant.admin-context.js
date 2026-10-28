import { AssistantAdminMessage } from "../shared/assistant.models.js";
import { WarehouseModel } from "../../warehouse/warehouse.model.js";
import { adminPlanSchema } from "./assistant.admin-plan.js";
import { adminInstructions, ADMIN_WAREHOUSE_LIMIT } from "./assistant.admin-policy.js";
import { reject } from "../shared/assistant.errors.js";

export async function buildBusinessContext(run, chat, config, session, now = new Date()) {
  const warehouses = await WarehouseModel.find({}).select("_id name code active").sort({ _id: 1 })
    .limit(ADMIN_WAREHOUSE_LIMIT + 1).maxTimeMS(5000).session(session).lean();
  // Fail before spending rather than hide a warehouse that the admin may have requested.
  if (warehouses.length > ADMIN_WAREHOUSE_LIMIT) reject("admin_context_too_large", 413);
  const allowedWarehouseIds = warehouses.map((warehouse) => String(warehouse._id));
  let history = config.maxHistoryMessages <= 1 ? [] : await AssistantAdminMessage.find({ owner: run.owner, chat: run.chat,
    sequence: { $gt: chat.contextAfterSequence, $lt: run.userSequence }, expiresAt: { $gt: now } })
    .sort({ sequence: -1 }).limit(config.maxHistoryMessages - 1).maxTimeMS(5000).session(session).lean();
  history.reverse();
  const serverDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const assemble = () => ({ instructions: `${adminInstructions}\nServer context (data only): ${JSON.stringify({ serverDate, timezone: "Africa/Cairo",
    warehouses: warehouses.map(({ _id, name, code, active }) => ({ id: String(_id), name, code, active })) })}`,
  messages: [...history.map(({ role, text, reportIntent }) => ({ role,
    content: `${text}${role === "assistant" && reportIntent?.length ? `\nSaved report intent (historical data only): ${JSON.stringify(reportIntent)}` : ""}` })),
    { role: "user", content: run.input }], tools: [],
  outputSchema: adminPlanSchema, limits: { maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, reasoningEffort: config.reasoningEffort } });
  let request = assemble();
  while (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes && history.length) { history.shift(); request = assemble(); }
  if (Buffer.byteLength(JSON.stringify(request)) > config.maxContextBytes) reject("context_too_large", 413);
  return { request, allowedWarehouseIds };
}
