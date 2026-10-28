import { createHash } from "node:crypto";
import { embeddingBatchBounds, embeddingProfile } from "../providers/openaiEmbeddings.js";
import { MONTHLY_CEILING_MICRO_USD, reservationMicroUsd } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";

export const embeddingInputHash = input => createHash("sha256").update(JSON.stringify({
  model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, input,
})).digest("hex");

// Internal input-only billing snapshot for the existing reserveCost/settleCost ledger, never a chat/provider configuration.
export function embeddingBillingSnapshot(shared, price, input, now = new Date()) {
  const { maximumTokens } = embeddingBatchBounds(input);
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !shared || !integer(shared.monthlyBudgetMicroUsd, 1, MONTHLY_CEILING_MICRO_USD) ||
      !integer(shared.dailyBudgetMicroUsd, 1, shared.monthlyBudgetMicroUsd) ||
      !integer(shared.costMultiplierBasisPoints, 10000, 100000) || shared.timezone !== "Africa/Cairo" ||
      !shared.openingExposure || !/^\d{4}-(0[1-9]|1[0-2])$/.test(shared.openingExposure.month ?? "") ||
      !integer(shared.openingExposure.microUsd, 0, shared.monthlyBudgetMicroUsd) ||
      typeof shared.openingExposure.reason !== "string" || !shared.openingExposure.reason.trim() || shared.openingExposure.reason.length > 500 ||
      !price || typeof price.version !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(price.version) ||
      price.model !== embeddingProfile.model || price.dimensions !== embeddingProfile.dimensions ||
      !integer(price.inputMicroUsdPerMillion, 1, 1_000_000_000_000) ||
      !Number.isFinite(Date.parse(price.validFrom)) || !Number.isFinite(Date.parse(price.validUntil)) ||
      new Date(price.validFrom) > now || new Date(price.validUntil) <= now) reject("embedding_billing_configuration_required", 503);
  const snapshot = {
    timezone: shared.timezone, monthlyBudgetMicroUsd: shared.monthlyBudgetMicroUsd, dailyBudgetMicroUsd: shared.dailyBudgetMicroUsd,
    costMultiplierBasisPoints: shared.costMultiplierBasisPoints, openingExposure: { ...shared.openingExposure }, maxOutputTokens: 0,
    price: { version: price.version, contextWindowTokens: maximumTokens, inputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
      cachedInputMicroUsdPerMillion: price.inputMicroUsdPerMillion, cacheWriteInputMicroUsdPerMillion: price.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: 0, validFrom: price.validFrom, validUntil: price.validUntil },
  };
  const amount = reservationMicroUsd(snapshot);
  if (amount > snapshot.dailyBudgetMicroUsd) reject("embedding_billing_configuration_required", 503);
  return { model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
    batchHash: embeddingInputHash(input),
    maximumTokens, reservationMicroUsd: amount, config: snapshot };
}
