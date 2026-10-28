import { DateTime } from "luxon";
import { AssistantBudget, AssistantRun } from "../shared/assistant.models.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { fields } from "../shared/assistant.validation.js";
import { topicKeys, TOPIC_TAXONOMY_VERSION, summarizeTopics } from "./assistant.topics.js";
import { runPurposes } from "../shared/assistant.purpose.js";

const statuses = ["queued", "dispatching", "completed", "failed", "uncertain"];
const tokenFields = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningTokens"];
const QUERY_TIMEOUT_MS = 5000;
const MODEL_GROUP_LIMIT = 100;

export function usageReportPeriod(query, timezone, now = new Date()) {
  fields(query, ["month"]);
  const local = DateTime.fromJSDate(now).setZone(timezone);
  const month = query.month ?? local.toFormat("yyyy-MM");
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) reject("invalid_report_period");
  const start = DateTime.fromISO(`${month}-01`, { zone: timezone }).startOf("month");
  if (!local.isValid || !start.isValid || start > local) reject("invalid_report_period");
  const end = start.plus({ months: 1 });
  return { month, start, end, observedThrough: end < local ? end : local,
    current: start.hasSame(local, "month") };
}

const dayExpression = (date, timezone) => ({ $dateToString: { format: "%Y-%m-%d", date, timezone } });
const identifierExpression = (path) => ({ $cond: [{ $eq: [{ $type: path }, "string"] },
  { $cond: [{ $regexMatch: { input: path, regex: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$" } }, path, null] }, null] });

export function usageReportPipeline(period, timezone, now) {
  const window = { $gte: period.start.toJSDate(), $lt: period.observedThrough.toJSDate() };
  const tokenSums = {};
  for (const field of tokenFields) {
    const value = `$attempts.usage.${field}`;
    tokenSums[`${field}Known`] = { $sum: { $cond: [{ $isNumber: value }, value, 0] } };
    tokenSums[`${field}Unknown`] = { $sum: { $cond: [{ $isNumber: value }, 0, 1] } };
  }
  const latency = "$attempts.latencyMs";
  const validLatency = { $and: [{ $isNumber: latency }, { $gte: [latency, 0] }, { $lte: [latency, Number.MAX_SAFE_INTEGER] }] };
  const knownLatency = { $cond: [validLatency, latency, null] };
  return [
    { $match: { $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { $or: [{ createdAt: window }, { "attempts.dispatchedAt": window }] },
    ] } },
    // No transcripts, quotes, pet identifiers or internal provider payloads leave the aggregation.
    { $project: { createdAt: 1, owner: 1, purpose: 1, status: 1, "attempts.dispatchedAt": 1, "attempts.usage": 1, "attempts.latencyMs": 1,
      "topic.key": 1, "topic.taxonomyVersion": 1,
      provider: identifierExpression("$config.provider"), model: identifierExpression("$config.model"),
      promptVersion: identifierExpression("$config.promptVersion") } },
    { $facet: {
      daily: [
        { $match: { createdAt: window, purpose: { $ne: runPurposes.automaticBundles } } },
        { $group: { _id: dayExpression("$createdAt", timezone), acceptedMessages: { $sum: 1 },
          users: { $addToSet: "$owner" },
          ...Object.fromEntries(statuses.map((status) => [status, { $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] } }])) } },
        { $project: { _id: 1, acceptedMessages: 1, uniqueUsers: { $size: "$users" },
          ...Object.fromEntries(statuses.map((status) => [status, 1])) } },
      ],
      users: [{ $match: { createdAt: window, purpose: { $ne: runPurposes.automaticBundles } } }, { $group: { _id: "$owner" } }, { $count: "count" }],
      topics: [
        { $match: { createdAt: window, purpose: { $ne: runPurposes.automaticBundles } } },
        { $group: { _id: { $cond: [{ $and: [
          { $eq: ["$status", "completed"] }, { $eq: ["$topic.taxonomyVersion", TOPIC_TAXONOMY_VERSION] },
          { $in: ["$topic.key", topicKeys] },
        ] }, "$topic.key", "unknown"] }, count: { $sum: 1 } } },
      ],
      attempts: [
        { $unwind: "$attempts" }, { $match: { "attempts.dispatchedAt": window } },
        { $group: { _id: dayExpression("$attempts.dispatchedAt", timezone), providerAttempts: { $sum: 1 }, ...tokenSums } },
      ],
      models: [
        { $unwind: "$attempts" }, { $match: { "attempts.dispatchedAt": window } },
        { $group: { _id: { provider: "$provider", model: "$model", promptVersion: "$promptVersion" },
          providerAttempts: { $sum: 1 }, ...tokenSums,
          latencyKnown: { $sum: { $cond: [validLatency, 1, 0] } },
          latencyMean: { $avg: knownLatency }, latencyMin: { $min: knownLatency }, latencyMax: { $max: knownLatency } } },
        { $sort: { providerAttempts: -1, "_id.provider": 1, "_id.model": 1, "_id.promptVersion": 1 } },
        { $limit: MODEL_GROUP_LIMIT + 1 },
      ],
    } },
  ];
}

function usageDto(row = {}) {
  return Object.fromEntries(tokenFields.map((field) => [field, {
    knownTokens: row[`${field}Known`] ?? 0, unknownAttempts: row[`${field}Unknown`] ?? 0,
  }]));
}

export async function getUsageReport(query, config, now = new Date()) {
  requireEnabled(config);
  const period = usageReportPeriod(query, config.timezone, now);
  const globalId = `global:${period.start.toUTC().toISO()}`;
  const [aggregation, records] = await Promise.all([
    AssistantRun.aggregate(usageReportPipeline(period, config.timezone, now)).option({ maxTimeMS: QUERY_TIMEOUT_MS }),
    AssistantBudget.find({ _id: { $in: ["control", globalId] } })
      .select("_id spent reserved frozen billingTimezone openingExposure").maxTimeMS(QUERY_TIMEOUT_MS).lean(),
  ]);
  const control = records.find((record) => record._id === "control");
  const budget = records.find((record) => record._id === globalId);
  if ((control && control.billingTimezone !== config.timezone) || (budget && !control)) reject("assistant_accounting_unavailable", 503);
  const result = aggregation[0] ?? { daily: [], users: [], attempts: [] };
  const messages = new Map(result.daily.map((row) => [row._id, row]));
  const attempts = new Map(result.attempts.map((row) => [row._id, row]));
  const daily = [];
  const totals = { acceptedMessages: 0, uniqueUsers: result.users[0]?.count ?? 0,
    statuses: Object.fromEntries(statuses.map((status) => [status, 0])), providerAttempts: 0, tokenUsage: usageDto() };
  for (let day = period.start; day <= period.observedThrough && day < period.end; day = day.plus({ days: 1 })) {
    const date = day.toFormat("yyyy-MM-dd");
    const row = messages.get(date) ?? {};
    const usage = attempts.get(date) ?? {};
    const entry = { date, acceptedMessages: row.acceptedMessages ?? 0, uniqueUsers: row.uniqueUsers ?? 0,
      statuses: Object.fromEntries(statuses.map((status) => [status, row[status] ?? 0])),
      providerAttempts: usage.providerAttempts ?? 0, tokenUsage: usageDto(usage) };
    daily.push(entry);
    totals.acceptedMessages += entry.acceptedMessages;
    totals.providerAttempts += entry.providerAttempts;
    for (const status of statuses) totals.statuses[status] += entry.statuses[status];
    for (const field of tokenFields) {
      totals.tokenUsage[field].knownTokens += entry.tokenUsage[field].knownTokens;
      totals.tokenUsage[field].unknownAttempts += entry.tokenUsage[field].unknownAttempts;
    }
  }
  return {
    month: period.month, timezone: config.timezone, generatedAt: now.toISOString(),
    period: { start: period.start.toUTC().toISO(), endExclusive: period.end.toUTC().toISO(),
      observedThrough: period.observedThrough.toUTC().toISO() },
    coverage: { source: "retained_run_records", completeness: "not_guaranteed", configuredRunRetentionDays: config.runDays,
      consistency: "independent_reads", attemptDefinition: "reserved_dispatch_attempts_not_confirmed_remote_calls" },
    totals, daily, topics: summarizeTopics(result.topics ?? [], totals.acceptedMessages),
    models: { source: "retained_dispatch_attempts", limit: MODEL_GROUP_LIMIT,
      truncated: (result.models?.length ?? 0) > MODEL_GROUP_LIMIT,
      groups: (result.models ?? []).slice(0, MODEL_GROUP_LIMIT).map((row) => ({
        provider: row._id.provider, model: row._id.model, promptVersion: row._id.promptVersion,
        providerAttempts: row.providerAttempts, tokenUsage: usageDto(row),
        latency: { knownAttempts: row.latencyKnown, unknownAttempts: row.providerAttempts - row.latencyKnown,
          meanMs: row.latencyMean, minMs: row.latencyMin, maxMs: row.latencyMax },
      })) },
    budget: { source: "durable_global_ledger", initialized: Boolean(budget), currency: "USD", unit: "microUSD",
      accountedMicroUsd: budget?.spent ?? null, reservedMicroUsd: budget?.reserved ?? null,
      currentPolicyLimitMicroUsd: period.current ? config.monthlyBudgetMicroUsd : null,
      remainingUnderCurrentPolicyMicroUsd: period.current && budget
        ? Math.max(0, config.monthlyBudgetMicroUsd - budget.spent - budget.reserved) : null,
      frozen: Boolean(control?.frozen || budget?.frozen),
      openingExposureMicroUsd: budget && control?.openingExposure
        ? (control.openingExposure.month === period.month ? control.openingExposure.microUsd : 0) : null,
      actualInvoiceMicroUsd: null },
  };
}
