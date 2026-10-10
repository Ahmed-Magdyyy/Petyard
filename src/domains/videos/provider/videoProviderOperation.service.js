import { videoProviderOperationTypeEnum, videoProviderOperationStatusEnum } from "../../../shared/constants/enums.js";
import { randomUUID } from "node:crypto";
import { createVideoProviderOperationRepository } from "./videoProviderOperation.repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED_RETENTION_MS = 90 * DAY_MS;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_DUE_LIMIT = 500;
const TYPES = new Set(Object.values(videoProviderOperationTypeEnum));

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function dateOrNow(now) {
  const value = now === undefined ? new Date() : now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  return value;
}

function sanitizedErrorCode(code) {
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "PROVIDER_ERROR";
}

function assertSameOperationIdentity(operation, identity) {
  if (!operation ||
      operation.type !== identity.type ||
      String(operation.assetId) !== String(identity.assetId) ||
      String(operation.coverId) !== String(identity.coverId) ||
      operation.libraryId !== identity.libraryId ||
      operation.providerGuid !== identity.providerGuid) {
    throw new Error("VIDEO_PROVIDER_OPERATION_DEDUPE_CONFLICT");
  }
  return operation;
}

export async function recordVideoProviderOperation({
  type, assetId, libraryId, providerGuid, coverId, dedupeKey, now, session, model,
}) {
  if (!TYPES.has(type)) throw new TypeError("Unknown provider operation type");
  const imageOnly = type === videoProviderOperationTypeEnum.COVER_CLEANUP;
  if (imageOnly && (!/^[a-f\d]{24}$/i.test(String(coverId)) || assetId != null || libraryId != null || providerGuid != null)) {
    throw new TypeError("Cover cleanup requires only a cover ObjectId target");
  }
  if (!imageOnly && (!assetId || coverId != null)) throw new TypeError("Stream operations require only a Stream target");
  const timestamp = dateOrNow(now);
  const identity = {
    type,
    ...(imageOnly ? { coverId: String(coverId).toLowerCase() } : { assetId,
      libraryId: requiredString(libraryId, "libraryId", 32),
      providerGuid: requiredString(providerGuid, "providerGuid", 128) }),
    dedupeKey: requiredString(dedupeKey, "dedupeKey", 160),
  };
  try {
    const operation = await createVideoProviderOperationRepository({ model }).insert(identity, timestamp, session);
    return assertSameOperationIdentity(operation, identity);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await createVideoProviderOperationRepository({ model }).findByDedupe(identity, session);
    return assertSameOperationIdentity(existing, identity);
  }
}

export async function claimVideoProviderOperationById({
  operationId, now, leaseMs = DEFAULT_LEASE_MS, model,
}) {
  if (!operationId) throw new TypeError("operationId is required");
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > DAY_MS) {
    throw new RangeError("leaseMs must be between 1 second and 24 hours");
  }
  const timestamp = dateOrNow(now);
  // Read immutable identity to form the per-target key. The claim itself remains
  // atomic and the unique index rejects a concurrent claim of another operation.
  const operation = await createVideoProviderOperationRepository({ model }).findById(operationId);
  if (!operation) return null;
  const activeTargetKey = operation.type === videoProviderOperationTypeEnum.COVER_CLEANUP
    ? `cover:${operation.coverId}` : `${operation.libraryId}:${operation.providerGuid}`;
  try {
    return await createVideoProviderOperationRepository({ model }).claim(operationId, timestamp, leaseMs, activeTargetKey, randomUUID());
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

export async function completeVideoProviderOperation({
  operationId, leaseToken, now, model,
}) {
  if (!operationId) throw new TypeError("operationId is required");
  requiredString(leaseToken, "leaseToken", 80);
  const timestamp = dateOrNow(now);
  return createVideoProviderOperationRepository({ model }).complete(operationId, leaseToken, timestamp, new Date(timestamp.getTime() + COMPLETED_RETENTION_MS));
}

export async function failVideoProviderOperation({
  operationId, leaseToken, errorCode, now, random = Math.random, model,
}) {
  if (!operationId) throw new TypeError("operationId is required");
  requiredString(leaseToken, "leaseToken", 80);
  const timestamp = dateOrNow(now);
  const current = await createVideoProviderOperationRepository({ model }).findRunning(operationId, leaseToken, timestamp);
  if (!current) return null;
  const failures = current.failedAttempts + 1;
  const needsAttention = failures >= 10;
  const jitter = random();
  if (typeof jitter !== "number" || jitter < 0 || jitter >= 1) {
    throw new RangeError("random must produce a value in [0, 1)");
  }
  const exponential = Math.min(DAY_MS, 60_000 * 2 ** Math.min(failures - 1, 20));
  const delay = needsAttention ? DAY_MS : Math.min(DAY_MS, Math.round(exponential * (0.5 + jitter)));
  return createVideoProviderOperationRepository({ model }).fail(operationId, leaseToken, timestamp, needsAttention ? videoProviderOperationStatusEnum.NEEDS_ATTENTION : videoProviderOperationStatusEnum.PENDING, failures, new Date(timestamp.getTime() + delay), sanitizedErrorCode(errorCode));
}

export async function listDueVideoProviderOperationIds({
  now, limit = 100, model,
} = {}) {
  const timestamp = dateOrNow(now);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DUE_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${MAX_DUE_LIMIT}`);
  }
  const operations = await createVideoProviderOperationRepository({ model }).listDue(timestamp, limit);
  return operations.map((operation) => String(operation._id));
}

export async function retryVideoProviderOperationNow({
  operationId, now, model,
}) {
  if (!operationId) throw new TypeError("operationId is required");
  const timestamp = dateOrNow(now);
  return createVideoProviderOperationRepository({ model }).retry(operationId, timestamp);
}

export async function recordVideoProviderEnqueueFailure({
  operationId, errorCode, now, model,
}) {
  if (!operationId) throw new TypeError("operationId is required");
  const timestamp = dateOrNow(now);
  return createVideoProviderOperationRepository({ model }).recordEnqueueFailure(operationId, timestamp, sanitizedErrorCode(errorCode));
}
