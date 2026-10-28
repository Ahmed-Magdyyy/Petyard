import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { reject } from "./assistant.errors.js";
import { getAssistantModelProfile, hasAssistantCredentials } from "../providers/assistantProvider.js";
import { PROMPT_VERSION } from "../customer/assistant.policy.js";
import { validCatalogClassification } from "../products/assistant.catalog-policy.js";

export const MONTHLY_CEILING_MICRO_USD = 50_000_000;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validReviewPolicy = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => ["version", "windowSeconds", "offTopicThreshold", "directedAbuseThreshold"].includes(key)) &&
  typeof value.version === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value.version) &&
  integer(value.windowSeconds, 60, 86400) && integer(value.offTopicThreshold, 2, 10000) && integer(value.directedAbuseThreshold, 2, 10000);
export const validCartPolicy = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === 4 && Object.keys(value).every((key) => ["version", "proposalSeconds", "rateMax", "rateWindowSeconds"].includes(key)) &&
  typeof value.version === "string" && /^[a-zA-Z0-9._-]{1,80}$/.test(value.version) &&
  integer(value.proposalSeconds, 1, 86400) && integer(value.rateMax, 1, 10000) && integer(value.rateWindowSeconds, 1, 86400);

export const cartActionsEnabled = (config) => config.enabled === true && config.productSearchEnabled === true &&
  config.cartEnabled === true && validCartPolicy(config.cartPolicy);

export function requireCartActions(config) {
  requireEnabled(config);
  if (!cartActionsEnabled(config)) reject("cart_actions_unavailable", 503);
}

export const bookingReadsEnabled = (config) => config.enabled === true && config.bookingReadsEnabled === true;
export const bookingActionsEnabled = config => bookingReadsEnabled(config) && config.bookingActionsEnabled === true && config.bookingRetentionEnabled === true;
export function requireBookingReads(config) {
  requireEnabled(config);
  if (!bookingReadsEnabled(config)) reject("booking_reads_unavailable", 503);
}

export function requireBookingActions(config) {
  requireBookingReads(config);
  if (!bookingActionsEnabled(config)) reject("booking_actions_unavailable", 503);
}

// No numerical product policy is silently selected. Disabled imports never require secrets or a database.
export function loadAssistantConfig(env = process.env, now = new Date()) {
  if (env.ASSISTANT_ENABLED !== "true") return Object.freeze({ enabled: false,
    ...(env.ASSISTANT_REFERENCES_ENABLED === "true" ? { referenceRetentionEnabled: true } : {}),
    ...(env.ASSISTANT_BOOKING_RETENTION_ENABLED === "true" ? { bookingRetentionEnabled: true } : {}) });
  let policy;
  try { policy = JSON.parse(env.ASSISTANT_POLICY_JSON); } catch { reject("assistant_configuration_required", 503); }
  const profile = getAssistantModelProfile(policy?.provider, policy?.model);
  const bounds = {
    monthlyBudgetMicroUsd: [1, MONTHLY_CEILING_MICRO_USD], dailyBudgetMicroUsd: [1, MONTHLY_CEILING_MICRO_USD],
    dailyMessageLimit: [1, 100000], rateMax: [1, 10000], rateWindowSeconds: [1, 86400],
    maxMessageChars: [1, 8000], maxContextBytes: [1024, 18000],
    maxOutputTokens: [16, 2048], maxOutputChars: [512, 16000], timeoutMs: [1, 30000],
    maxHistoryMessages: [1, 29], maxSubjects: [1, 100], maxMemoryEntries: [1, 200], memoryValueChars: [1, 1000],
    historyDays: [1, 3650], memoryDays: [1, 3650], runDays: [1, 3650], auditDays: [1, 3650],
    queueTimeoutMs: [1000, 3600000], pollMs: [100, 60000], costMultiplierBasisPoints: [10000, 100000],
  };
  const allowed = [...Object.keys(bounds), "version", "provider", "model", "timezone", "blockedHistoryAllowed", "failureMessagePolicy",
    "clinicalMode", "maxToolRounds", "automaticRestrictions", "reasoningEffort", "openingExposure", "price", "reviewPolicy", "catalogClassification", "productSearchEnabled", "cartPolicy",
    "catalogSemanticEnabled", "catalogSemanticMinimumScore"];
  if (!policy || Object.keys(policy).some((key) => !allowed.includes(key)) || Object.entries(bounds).some(([key, range]) => !integer(policy[key], ...range)) ||
      typeof policy.version !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(policy.version) ||
      !DateTime.now().setZone(policy.timezone).isValid || typeof policy.timezone !== "string" ||
      typeof policy.blockedHistoryAllowed !== "boolean" || policy.failureMessagePolicy !== "count_accepted" ||
      policy.clinicalMode !== "education_only" || policy.maxToolRounds !== 0 ||
      policy.automaticRestrictions !== false ||
      (policy.reviewPolicy !== undefined && !validReviewPolicy(policy.reviewPolicy)) ||
      (policy.cartPolicy !== undefined && !validCartPolicy(policy.cartPolicy)) ||
      (env.ASSISTANT_CART_ENABLED === "true" && (!validCartPolicy(policy.cartPolicy) || policy.productSearchEnabled !== true)) ||
      !validCatalogClassification(policy.catalogClassification) ||
      (policy.productSearchEnabled !== undefined && typeof policy.productSearchEnabled !== "boolean") ||
      (policy.catalogSemanticEnabled !== undefined && typeof policy.catalogSemanticEnabled !== "boolean") ||
      (policy.catalogSemanticMinimumScore !== undefined && (!Number.isFinite(policy.catalogSemanticMinimumScore) || policy.catalogSemanticMinimumScore < 0 || policy.catalogSemanticMinimumScore > 1)) ||
      (policy.catalogSemanticEnabled === true && (policy.productSearchEnabled !== true || policy.catalogSemanticMinimumScore === undefined)) ||
      !profile?.reasoningEfforts.includes(policy.reasoningEffort) ||
      policy.maxMessageChars * 4 > policy.maxContextBytes ||
      policy.dailyBudgetMicroUsd > policy.monthlyBudgetMicroUsd || policy.runDays < policy.historyDays) {
    reject("assistant_configuration_required", 503);
  }
  const price = policy.price;
  const opening = policy.openingExposure;
  if (!opening || !/^\d{4}-(0[1-9]|1[0-2])$/.test(opening.month) ||
      !integer(opening.microUsd, 0, policy.monthlyBudgetMicroUsd) || typeof opening.reason !== "string" || !opening.reason.trim() || opening.reason.length > 500) {
    reject("assistant_configuration_required", 503);
  }
  if (!price || typeof price.version !== "string" || !price.version.trim() || price.coverage !== "all_context_lengths" ||
      price.contextWindowTokens !== profile.contextWindowTokens ||
      !["inputMicroUsdPerMillion", "cachedInputMicroUsdPerMillion", "cacheWriteInputMicroUsdPerMillion", "outputMicroUsdPerMillion"]
        .every((key) => integer(price[key], 0, 1_000_000_000_000)) || price.inputMicroUsdPerMillion === 0 || price.outputMicroUsdPerMillion === 0 ||
      !Number.isFinite(Date.parse(price.validFrom)) || !Number.isFinite(Date.parse(price.validUntil)) ||
      new Date(price.validFrom) > now || new Date(price.validUntil) <= now ||
      !hasAssistantCredentials(policy, env)) reject("assistant_configuration_required", 503);
  const signature = createHash("sha256").update(JSON.stringify({ policy, promptVersion: PROMPT_VERSION })).digest("hex");
  if (reservationMicroUsd(policy) > policy.dailyBudgetMicroUsd) {
    reject("assistant_configuration_required", 503);
  }
  if (policy.catalogClassification) {
    for (const value of Object.values(policy.catalogClassification)) if (Array.isArray(value)) Object.freeze(value);
    Object.freeze(policy.catalogClassification);
  }
  const adminReportMaxBytes = /^\d+$/.test(env.ASSISTANT_ADMIN_REPORT_MAX_BYTES ?? "") ? Number(env.ASSISTANT_ADMIN_REPORT_MAX_BYTES) : null;
  if (policy.cartPolicy) Object.freeze(policy.cartPolicy);
  return Object.freeze({ ...policy, promptVersion: PROMPT_VERSION, price: Object.freeze({ ...price }), enabled: true, signature,
    adminReportMaxBytes, adminEnabled: env.ASSISTANT_ADMIN_ENABLED === "true", cartEnabled: env.ASSISTANT_CART_ENABLED === "true",
    bundleCartEnabled: env.ASSISTANT_BUNDLE_CART_ENABLED === "true",
    bundleGenerationEnabled: env.ASSISTANT_BUNDLE_GENERATION_ENABLED === "true",
    bundleGenerationOwner: env.ASSISTANT_BUNDLE_GENERATION_OWNER_ID ?? null,
    referenceRetentionEnabled: env.ASSISTANT_REFERENCES_ENABLED === "true",
    bookingReadsEnabled: env.ASSISTANT_BOOKING_READS_ENABLED === "true",
    bookingActionsEnabled: env.ASSISTANT_BOOKING_ACTIONS_ENABLED === "true",
    bookingNotificationsEnabled: env.ASSISTANT_BOOKING_NOTIFICATIONS_ENABLED === "true",
    bookingRetentionEnabled: env.ASSISTANT_BOOKING_RETENTION_ENABLED === "true" });
}

export function requireEnabled(config) {
  if (!config.enabled) reject("assistant_disabled", 503);
  if (new Date(config.price.validUntil) <= new Date()) reject("assistant_configuration_required", 503);
  return config;
}

export function periods(config, now = new Date()) {
  const local = DateTime.fromJSDate(now).setZone(config.timezone);
  const day = local.startOf("day");
  const month = local.startOf("month");
  return { day: day.toUTC().toISO(), month: month.toUTC().toISO(),
    dayReset: day.plus({ days: 1 }).toJSDate(), monthReset: month.plus({ months: 1 }).toJSDate() };
}

export function reservationMicroUsd(config) {
  const amount = costMicroUsd({ inputTokens: config.price?.contextWindowTokens, outputTokens: config.maxOutputTokens }, config, true);
  if (amount === null) reject("assistant_accounting_unavailable", 503);
  return amount;
}

export function costMicroUsd(usage, config, reserve = false) {
  // Settlement uses the admitted run's saved billing limits, even after its model/profile changes.
  const contextWindowTokens = config.price?.contextWindowTokens;
  if (!integer(contextWindowTokens, 1, Number.MAX_SAFE_INTEGER) || !usage || !integer(usage.inputTokens, 0, contextWindowTokens) ||
      !integer(usage.outputTokens, 0, config.maxOutputTokens)) return null;
  const price = config.price;
  const maxInputRate = Math.max(price.inputMicroUsdPerMillion, price.cachedInputMicroUsdPerMillion, price.cacheWriteInputMicroUsdPerMillion);
  let input = BigInt(usage.inputTokens) * BigInt(maxInputRate);
  if (!reserve && [usage.cachedInputTokens, usage.cacheWriteInputTokens].every((v) => integer(v, 0, usage.inputTokens)) &&
      usage.cachedInputTokens + usage.cacheWriteInputTokens <= usage.inputTokens) {
    input = BigInt(usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens) * BigInt(price.inputMicroUsdPerMillion)
      + BigInt(usage.cachedInputTokens) * BigInt(price.cachedInputMicroUsdPerMillion)
      + BigInt(usage.cacheWriteInputTokens) * BigInt(price.cacheWriteInputMicroUsdPerMillion);
  }
  const scaled = (input + BigInt(usage.outputTokens) * BigInt(price.outputMicroUsdPerMillion)) * BigInt(config.costMultiplierBasisPoints);
  const result = Number((scaled + 9_999_999_999n) / 10_000_000_000n);
  if (!Number.isSafeInteger(result)) reject("assistant_accounting_unavailable", 503);
  return result;
}

export const expiry = (days, now = new Date()) => new Date(now.getTime() + days * 86400000);
