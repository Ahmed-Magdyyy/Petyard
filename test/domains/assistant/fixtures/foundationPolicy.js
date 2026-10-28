import { loadAssistantConfig } from "../../../../src/domains/assistant/shared/assistant.config.js";

// Synthetic TEST values only. These are not approved launch limits or provider prices.
export function testPolicy(overrides = {}) {
  return { version: "test-only-v1", provider: "openai", model: "gpt-6-luna", timezone: "Africa/Cairo",
    monthlyBudgetMicroUsd: 50_000_000, dailyBudgetMicroUsd: 10_000_000, dailyMessageLimit: 10,
    rateMax: 5, rateWindowSeconds: 60, maxMessageChars: 1000, maxContextBytes: 18000,
    maxOutputTokens: 512, maxOutputChars: 4000, timeoutMs: 1000, maxHistoryMessages: 10, maxSubjects: 10,
    maxMemoryEntries: 20, memoryValueChars: 300, historyDays: 7, memoryDays: 30, runDays: 30, auditDays: 30,
    queueTimeoutMs: 60000, pollMs: 1000, costMultiplierBasisPoints: 11000, maxToolRounds: 0,
    blockedHistoryAllowed: false, failureMessagePolicy: "count_accepted", clinicalMode: "education_only", reasoningEffort: "low", automaticRestrictions: false,
    openingExposure: { month: "2026-10", microUsd: 0, reason: "Synthetic isolated tests only" },
    price: { version: "synthetic-test-price", coverage: "all_context_lengths", contextWindowTokens: 1_050_000,
      validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z",
      inputMicroUsdPerMillion: 1_000_000, cachedInputMicroUsdPerMillion: 100_000,
      cacheWriteInputMicroUsdPerMillion: 2_000_000, outputMicroUsdPerMillion: 4_000_000 }, ...overrides };
}
export const testConfig = (overrides) => loadAssistantConfig({ ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "local-test-never-a-real-key",
  ASSISTANT_ADMIN_REPORT_MAX_BYTES: "65536",
  ASSISTANT_ADMIN_ENABLED: "true",
  ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy(overrides)) });
export const structuredReply = (extras = {}) => ({ reply: "I can help with pet care.", scope: "pet_care", primaryTopic: "unknown", languageAssessment: "none", memoryKey: "none", memoryValue: "",
  memorySubjectId: "", sourceQuote: "", subjectAction: "keep", resolvedSubjectId: "", subjectName: "", subjectNameQuote: "",
  subjectSpecies: "", subjectSpeciesQuote: "", replyLanguage: "en", dietaryWarningAction: "none", dietaryWarningSubjectId: "", dietaryWarningQuote: "",
  productSearch: { action: "none", query: "", minimumPackageWeightGrams: null, maximumPriceMinor: null, sourceQuote: "", options: [] }, checkoutSummary: "none", ...extras,
  bookingOptions: typeof extras.bookingOptions === "object" ? extras.bookingOptions : { action: extras.bookingOptions ?? "none", services: [], locationId: "", date: "", hour24: null, sourceQuote: "" } });
export const knownUsage = Object.freeze({ inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningTokens: 5, totalTokens: 120 });
export const reviewOnlyPolicy = Object.freeze({ version: "review-only-v1", windowSeconds: 86400, offTopicThreshold: 5, directedAbuseThreshold: 3 });
