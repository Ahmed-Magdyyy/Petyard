import { getMediaConfiguration } from "../../../shared/utils/mediaConfig.js";
import { reject } from "../shared/assistant.errors.js";
import { embeddingBillingSnapshot } from "./assistant.embedding-billing.js";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";

export function loadReferenceConfig(env = process.env) {
  if (env.ASSISTANT_ENABLED !== "true" || env.ASSISTANT_REFERENCES_ENABLED !== "true") return { enabled: false };
  let limits;
  try { limits = JSON.parse(env.ASSISTANT_REFERENCE_LIMITS_JSON); } catch { reject("reference_configuration_required", 503); }
  const maximums = { maxFileBytes: 64 * 1024 * 1024, maxTextBytes: 8 * 1024 * 1024,
    maxPages: 2000, maxArchiveEntries: 10000, maxExpandedBytes: 128 * 1024 * 1024, timeoutMs: 60000 };
  if (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).length !== Object.keys(maximums).length ||
      Object.entries(maximums).some(([key, max]) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > max)) {
    reject("reference_configuration_required", 503);
  }
  let media;
  try { media = getMediaConfiguration(env); } catch { reject("reference_configuration_required", 503); }
  if (media.privateProvider !== "bunny" || !media.private || media.private.zone === media.public?.zone) {
    reject("reference_private_storage_required", 503);
  }
  return { enabled: true, limits: Object.freeze({ ...limits }), storage: { ...media.private, timeoutMs: media.storageTimeoutMs } };
}

export function requireReferences(config) {
  if (config?.enabled !== true || !config.limits || !config.storage) reject("reference_uploads_unavailable", 503);
  return config;
}

export function loadReferenceIndexingConfig(referenceConfig, shared, env = process.env, now = new Date()) {
  if (referenceConfig?.enabled !== true || shared?.enabled !== true || env.ASSISTANT_REFERENCE_INDEXING_ENABLED !== "true") return { enabled: false };
  requireReferences(referenceConfig);
  return loadEmbeddingConfig(shared, env, now);
}

export function loadReferenceRetrievalConfig(shared, env = process.env, now = new Date()) {
  if (shared?.enabled !== true || env.ASSISTANT_REFERENCES_ENABLED !== "true" || env.ASSISTANT_REFERENCE_RETRIEVAL_ENABLED !== "true") return { enabled: false };
  return loadEmbeddingConfig(shared, env, now);
}

export function loadEmbeddingConfig(shared, env = process.env, now = new Date()) {
  let price;
  try { price = JSON.parse(env.ASSISTANT_EMBEDDING_PRICE_JSON); } catch { reject("embedding_billing_configuration_required", 503); }
  const keys = ["version", "model", "dimensions", "inputMicroUsdPerMillion", "validFrom", "validUntil"];
  if (!price || Object.keys(price).length !== keys.length || Object.keys(price).some(key => !keys.includes(key)) ||
      !Number.isSafeInteger(shared.timeoutMs) || shared.timeoutMs < 1 || shared.timeoutMs > 30000) reject("embedding_billing_configuration_required", 503);
  embeddingBillingSnapshot(shared, price, Array(embeddingProfile.maxItems).fill("Configuration validation only"), now);
  return Object.freeze({ enabled: true, price: Object.freeze({ ...price }), timeoutMs: shared.timeoutMs });
}
