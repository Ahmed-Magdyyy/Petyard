import "@dotenvx/dotenvx/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import sharp from "sharp";
import cloudinary from "../src/shared/utils/cloudinary.js";
import {
  buildBunnyCdnUrl,
  downloadBunnyObject,
  getBunnyObjectKeyFromUrl,
  uploadBunnyObject,
} from "../src/shared/utils/bunnyStorage.js";

const REPORT_DIR = path.resolve("scripts/bunny-migration-reports");
const MAX_CONCURRENCY = 8;
const MAX_RECOVERY_SOURCE_BYTES = 25 * 1024 * 1024;
// Buffer.concat can briefly duplicate retained chunks, so cap retained bytes at
// 50 MiB to keep capture data below a 100 MiB peak even during concatenation.
const MAX_RECOVERY_TOTAL_BYTES = 50 * 1024 * 1024;
const MIME_BY_FORMAT = Object.freeze({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml",
});

export function parseCopyArguments(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--") && !arg.includes("=")));
  const values = Object.fromEntries(argv.filter((arg) => arg.includes("=")).map((arg) => {
    const [key, ...parts] = arg.split("="); return [key, parts.join("=")];
  }));
  const onlyPublic = flags.has("--only-public");
  const onlyInstapay = flags.has("--only-instapay");
  if (onlyPublic && onlyInstapay) throw new Error("--only-public and --only-instapay cannot be used together");
  const number = (name, fallback, max) => {
    if (values[name] == null) return fallback;
    const parsed = Number(values[name]);
    if (!Number.isInteger(parsed) || parsed < 1 || (max && parsed > max)) throw new Error(`Invalid ${name}`);
    return parsed;
  };
  const copy = flags.has("--copy");
  const verifyOnly = flags.has("--verify-only");
  const manifest = values["--manifest"] ? path.resolve(values["--manifest"]) : null;
  const recoveryReport = values["--recover-unresolved"]
    ? path.resolve(values["--recover-unresolved"])
    : null;
  if (copy && !flags.has("--confirm-bunny-write")) throw new Error("--copy requires --confirm-bunny-write");
  if (verifyOnly && !manifest) throw new Error("--verify-only requires --manifest=<report.json>");
  if (copy && verifyOnly) throw new Error("--copy and --verify-only cannot be used together");
  if (recoveryReport && !manifest) throw new Error("--recover-unresolved requires --manifest=<verified-report.json>");
  if (recoveryReport && (verifyOnly || onlyPublic || onlyInstapay || values["--limit"] != null)) {
    throw new Error("--recover-unresolved cannot be combined with verify-only, class filters, or limit");
  }
  return {
    onlyPublic,
    onlyInstapay,
    limit: number("--limit", null),
    concurrency: number("--concurrency", 4, MAX_CONCURRENCY),
    copy,
    verifyOnly,
    manifest,
    recoveryReport,
  };
}

export function classifyCloudinaryAsset(asset) {
  const publicId = asset?.public_id;
  if (typeof publicId !== "string" || !publicId) return { error: "invalid-public-id" };
  if (publicId.startsWith("petyard/")) return { classification: "public" };
  if (publicId.startsWith("instapay_screenshots/")) return { classification: "private" };
  return { error: "unsupported-public-id-root" };
}

export function assertSafePublicId(publicId) {
  if (typeof publicId !== "string" || !publicId || publicId.includes("\\") || /[?#\0-\x1f]/.test(publicId)) throw new Error("Unsafe Cloudinary public ID");
  const segments = publicId.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe Cloudinary public ID");
  return publicId;
}

export function profileForAsset(asset, classification) {
  if (classification === "private") return "proof";
  return /^(petyard\/categories|petyard\/subcategories)\//.test(asset.public_id) ? "tile" : "standard";
}

export function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
export function sha256Text(value) { return sha256(Buffer.from(value, "utf8")); }

export function createRecoveryByteBudget(maxBytes = MAX_RECOVERY_TOTAL_BYTES) {
  let usedBytes = 0;
  return {
    get usedBytes() { return usedBytes; },
    reserve(byteLength) {
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || usedBytes + byteLength > maxBytes) {
        const error = new Error("recovery-capture-total-byte-limit");
        error.retryable = false;
        throw error;
      }
      usedBytes += byteLength;
    },
    release(byteLength) {
      usedBytes = Math.max(0, usedBytes - Number(byteLength || 0));
    },
  };
}

export function releaseRecoveryCaptures(captures, byteBudget) {
  for (const capture of captures ?? []) {
    if (capture?.kind !== "captured" || !Buffer.isBuffer(capture.buffer)) continue;
    byteBudget.release(capture.buffer.length);
    capture.buffer = null;
  }
}

export async function withRecoveryCaptureCleanup(captures, byteBudget, operation) {
  try {
    return await operation();
  } finally {
    releaseRecoveryCaptures(captures, byteBudget);
  }
}

export async function readResponseBufferLimited(response, {
  maxBytes = MAX_RECOVERY_SOURCE_BYTES,
  byteBudget = createRecoveryByteBudget(),
} = {}) {
  const advertised = response.headers.get("content-length");
  const contentLength = advertised == null ? null : Number(advertised);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    const error = new Error("recovery-source-too-large");
    error.retryable = false;
    throw error;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let retainedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (retainedBytes + chunk.length > maxBytes) {
        const error = new Error("recovery-source-too-large");
        error.retryable = false;
        throw error;
      }
      byteBudget.reserve(chunk.length);
      retainedBytes += chunk.length;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, retainedBytes);
  } catch (error) {
    await reader.cancel().catch(() => {});
    byteBudget.release(retainedBytes);
    throw error;
  }
}

export function sourceSort(resources) { return [...resources].sort((a, b) => a.public_id.localeCompare(b.public_id)); }

export function findPreflightBlockers(resources) {
  const counts = new Map();
  for (const asset of resources) {
    counts.set(asset?.public_id, (counts.get(asset?.public_id) || 0) + 1);
  }
  return resources.map((asset) => {
    const classification = classifyCloudinaryAsset(asset);
    if (classification.error) return classification.error;
    try { assertSafePublicId(asset.public_id); } catch { return "unsafe-public-id"; }
    if (counts.get(asset.public_id) > 1) return "duplicate-source-identity";
    if (!MIME_BY_FORMAT[String(asset.format || "").toLowerCase()]) return "unsupported-source-format";
    return null;
  });
}

export function validatePreviousManifest(report, { env, classes }) {
  if (!report || !Array.isArray(report.entries)) throw new Error("Invalid previous copy manifest");
  const selectedClasses = new Set(classes);
  for (const entry of report.entries) {
    if (!selectedClasses.has(entry?.classification)) continue;
    const zone = getZoneConfiguration(env, entry.classification);
    if (entry?.target?.zone !== zone.zone || typeof entry?.target?.sha256 !== "string") {
      throw new Error("Previous manifest target configuration does not match current configuration");
    }
    const objectKey = getBunnyObjectKeyFromUrl({
      url: entry.target.unsignedUrl,
      cdnBaseUrl: zone.cdnBaseUrl,
      allowedRoot: zone.root,
    });
    if (objectKey !== entry.target.objectKey) {
      throw new Error("Previous manifest target URL does not match its object key");
    }
  }
  return report;
}

export function getZoneConfiguration(env, classification) {
  const prefix = classification === "private" ? "BUNNY_PRIVATE" : "BUNNY_PUBLIC";
  const zone = env[`${prefix}_STORAGE_ZONE`];
  const accessKey = env[`${prefix}_STORAGE_ACCESS_KEY`];
  const endpoint = env[`${prefix}_STORAGE_ENDPOINT`];
  const cdnBaseUrl = env[`${prefix}_CDN_BASE_URL`];
  if (![zone, accessKey, endpoint, cdnBaseUrl].every((value) => typeof value === "string" && value.trim())) throw new Error(`${prefix} Bunny configuration is incomplete`);
  const root = classification === "private" ? "instapay_screenshots" : "petyard";
  return { zone: zone.trim(), accessKey: accessKey.trim(), endpoint: endpoint.trim(), cdnBaseUrl: cdnBaseUrl.trim(), root };
}

export async function enumerateCloudinaryResources({ prefix, adminApi = cloudinary.api }) {
  const resources = [];
  let nextCursor;
  do {
    const page = await adminApi.resources({ type: "upload", resource_type: "image", prefix, max_results: 500, next_cursor: nextCursor });
    resources.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);
  return sourceSort(resources);
}

const RECOVERABLE_SNAPSHOT_COLLECTIONS = new Set(["favorites", "carts", "orders"]);
const RECOVERABLE_SNAPSHOT_PATH = /^items\.\d+\.productImageUrl$/;

function parseRecoverySourceUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  const [, cloudName, resourceType, deliveryType, ...rest] = parsed.pathname.split("/");
  if (resourceType !== "image" || deliveryType !== "upload") return null;
  const versionIndex = rest.findIndex((part) => /^v\d+$/.test(part));
  let identity;
  try {
    identity = (versionIndex >= 0 ? rest.slice(versionIndex + 1) : rest)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (!identity.length) return null;
  const filename = identity.at(-1);
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) return null;
  identity[identity.length - 1] = filename.slice(0, extensionIndex);
  return {
    cloudName,
    publicId: identity.join("/"),
    version: versionIndex >= 0 ? Number(rest[versionIndex].slice(1)) : null,
  };
}

export function groupUnresolvedSources(report, { cloudName = process.env.CLOUDINARY_CLOUD_NAME } = {}) {
  if (!report || !Array.isArray(report.unresolved)) throw new Error("Invalid DB rewrite report");
  const groups = new Map();
  for (const item of report.unresolved) {
    if (
      item?.reason !== "unresolved-source-public-id" ||
      !RECOVERABLE_SNAPSHOT_COLLECTIONS.has(item?.collection) ||
      !RECOVERABLE_SNAPSHOT_PATH.test(item?.path || "") ||
      typeof item?.publicId !== "string" ||
      !item.publicId.startsWith("petyard/")
    ) {
      throw new Error("DB rewrite report contains an unsupported unresolved source");
    }
    const parsed = parseRecoverySourceUrl(item.value);
    if (!parsed || parsed.cloudName !== cloudName || parsed.publicId !== item.publicId) {
      throw new Error("DB rewrite report unresolved source identity mismatch");
    }
    const group = groups.get(item.publicId) || { publicId: item.publicId, sourceCloud: cloudName, urls: new Set() };
    group.urls.add(item.value);
    groups.set(item.publicId, group);
  }
  return [...groups.values()]
    .map((group) => ({ publicId: group.publicId, sourceCloud: group.sourceCloud, urls: [...group.urls].sort() }))
    .sort((left, right) => left.publicId.localeCompare(right.publicId));
}

export function createRecoveryProvenance(previousManifest, recoveryReport, {
  cloudName = process.env.CLOUDINARY_CLOUD_NAME,
} = {}) {
  if (
    !previousManifest ||
    !Array.isArray(previousManifest.entries) ||
    previousManifest.entries.length === 0 ||
    previousManifest.entries.some((entry) => !["verified", "skipped-existing-identical"].includes(entry?.status))
  ) {
    throw new Error("Recovery requires a fully verified parent manifest");
  }
  if (previousManifest.recoveryProvenance || (previousManifest.confirmedUnavailableSources?.length ?? 0) > 0) {
    throw new Error("Recovery parent must not contain prior recovery metadata");
  }
  const parentManifestHash = sha256Text(JSON.stringify(previousManifest));
  const validReport =
    recoveryReport?.mode === "dry-run" &&
    recoveryReport?.manifestHash === parentManifestHash &&
    recoveryReport?.updatedDocuments === 0 &&
    recoveryReport?.conflicts === 0 &&
    typeof recoveryReport?.database?.host === "string" &&
    recoveryReport.database.host &&
    typeof recoveryReport?.database?.name === "string" &&
    recoveryReport.database.name &&
    Array.isArray(recoveryReport?.unresolved) &&
    recoveryReport.unresolved.length > 0 &&
    recoveryReport?.unresolvedSourceUrls === recoveryReport.unresolved.length &&
    typeof cloudName === "string" &&
    cloudName &&
    previousManifest?.sourceCloud === cloudName;
  if (!validReport) throw new Error("Recovery report is not bound to the verified parent manifest and dry-run database");
  return {
    version: 1,
    parentManifestHash,
    recoveryReportHash: sha256Text(JSON.stringify(recoveryReport)),
    database: {
      host: recoveryReport.database.host,
      name: recoveryReport.database.name,
    },
    sourceCloud: cloudName,
  };
}

export async function verifyRecoveryBaseEntries(previousManifest, {
  concurrency = 4,
  env = process.env,
  transport,
  now,
  onProgress,
} = {}) {
  const entries = await runBounded(previousManifest.entries, concurrency, async (entry, index) => {
    const verified = await verifyManifestEntry(entry, { env, transport, now });
    onProgress?.(index + 1, previousManifest.entries.length);
    return verified;
  });
  if (entries.some((entry) => entry.status !== "verified")) {
    throw new Error("Recovery blocked because an inherited Bunny object failed verification");
  }
  return entries;
}

function cloudinaryErrorStatus(error) {
  return Number(error?.http_code || error?.error?.http_code || error?.response?.status || 0);
}

async function fetchRecoveryCandidate(url, fetchImpl = fetch, byteBudget = createRecoveryByteBudget()) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let retainedBuffer = null;
    try {
      const requestUrl = new URL(url);
      if (attempt > 0) requestUrl.searchParams.set("petyard_recovery_attempt", `${Date.now()}-${attempt}`);
      const response = await fetchImpl(requestUrl.toString(), { signal: AbortSignal.timeout(15000), redirect: "follow" });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        if (attempt === 2) return { status: 404, attempts: attempt + 1 };
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Retryable recovery source status ${response.status}`);
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, error: "unexpected-delivery-status" };
      }
      const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        await response.body?.cancel().catch(() => {});
        return { status: 200, error: "delivery-response-is-not-an-image" };
      }
      const buffer = await readResponseBufferLimited(response, { byteBudget });
      retainedBuffer = buffer;
      if (!buffer.length) return { status: 200, error: "delivery-response-is-not-an-image" };
      const metadata = await sharp(buffer).metadata();
      const format = String(metadata.format || "").toLowerCase();
      if (!MIME_BY_FORMAT[format]) {
        byteBudget.release(buffer.length);
        retainedBuffer = null;
        return { status: 200, error: "unsupported-recovered-image-format" };
      }
      return { status: 200, attempts: attempt + 1, buffer, format, width: metadata.width ?? null, height: metadata.height ?? null };
    } catch (error) {
      if (retainedBuffer?.length) byteBudget.release(retainedBuffer.length);
      lastError = error;
      if (error?.retryable === false) return { status: 0, error: error.message };
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return { status: 0, error: "recovery-source-request-failed" };
}

export async function captureUnresolvedGroup(group, {
  adminApi = cloudinary.api,
  fetchImpl = fetch,
  byteBudget = createRecoveryByteBudget(),
  now = () => new Date().toISOString(),
} = {}) {
  let adminAsset = null;
  try {
    adminAsset = await adminApi.resource(group.publicId, { resource_type: "image", type: "upload" });
  } catch (error) {
    if (cloudinaryErrorStatus(error) !== 404) {
      return { kind: "blocked", publicId: group.publicId, error: "cloudinary-admin-lookup-failed" };
    }
  }

  if (adminAsset) {
    if (adminAsset.public_id !== group.publicId) {
      return { kind: "blocked", publicId: group.publicId, error: "cloudinary-admin-identity-mismatch" };
    }
    const candidate = await fetchRecoveryCandidate(adminAsset.secure_url, fetchImpl, byteBudget);
    if (candidate.status !== 200 || candidate.error) {
      return { kind: "blocked", publicId: group.publicId, error: candidate.error || "cloudinary-admin-delivery-failed" };
    }
    return {
      kind: "captured",
      source: "cloudinary-admin",
      capturedAt: now(),
      captureAttempts: candidate.attempts,
      buffer: candidate.buffer,
      asset: {
        ...adminAsset,
        format: candidate.format,
        bytes: candidate.buffer.length,
        width: candidate.width,
        height: candidate.height,
      },
    };
  }

  let available = null;
  for (const url of group.urls) {
    const result = await fetchRecoveryCandidate(url, fetchImpl, byteBudget);
    if (![200, 404].includes(result.status) || result.error) {
      return { kind: "blocked", publicId: group.publicId, error: result.error || "recovery-source-probe-failed" };
    }
    if (result.status === 200) {
      available = { url, result };
      break;
    }
  }
  if (!available) {
    return {
      kind: "unavailable",
      record: {
        publicId: group.publicId,
        sourceCloud: group.sourceCloud,
        classification: "public",
        status: "confirmed-unavailable",
        adminStatus: 404,
        deliveryStatus: 404,
        deliveryAttempts: 3,
        urlSha256: group.urls.map(sha256Text).sort(),
        confirmedAt: now(),
      },
    };
  }

  const parsed = parseRecoverySourceUrl(available.url);
  const asset = {
    public_id: group.publicId,
    resource_type: "image",
    secure_url: available.url,
    format: available.result.format,
    version: parsed?.version ?? null,
    bytes: available.result.buffer.length,
    width: available.result.width,
    height: available.result.height,
  };
  return {
    kind: "captured",
    source: "delivery-cache",
    capturedAt: now(),
    captureAttempts: available.result.attempts,
    buffer: available.result.buffer,
    asset,
  };
}

export async function materializeCapturedRecovery(capture, {
  env = process.env,
  copy = false,
  transport,
  now = () => new Date().toISOString(),
} = {}) {
  if (capture?.kind !== "captured" || !Buffer.isBuffer(capture.buffer) || !capture.buffer.length) {
    return { kind: "blocked", publicId: capture?.asset?.public_id || null, error: "invalid-recovery-capture" };
  }
  const entry = await copyOneAsset(capture.asset, {
    env,
    copy,
    transport,
    downloadSource: async () => capture.buffer,
    now,
  });
  return {
    kind: "entry",
    entry: {
      ...entry,
      recovery: {
        source: capture.source,
        capturedAt: capture.capturedAt,
        sourceSha256: sha256(capture.buffer),
        sourceByteLength: capture.buffer.length,
        captureAttempts: capture.captureAttempts,
      },
    },
  };
}

export async function recoverUnresolvedGroup(group, options = {}) {
  const captured = await captureUnresolvedGroup(group, options);
  if (captured.kind !== "captured") return captured;
  return materializeCapturedRecovery(captured, options);
}

export async function transformAsset(buffer, asset, profile) {
  const sourceFormat = String(asset.format || "").toLowerCase();
  const sourceContentType = MIME_BY_FORMAT[sourceFormat];
  if (!sourceContentType) throw new Error("unsupported-source-format");
  if (profile === "proof" || sourceFormat === "gif" || sourceFormat === "svg") {
    return { buffer, format: sourceFormat, contentType: sourceContentType };
  }
  const resize = profile === "tile" ? { width: 480, fit: "inside", withoutEnlargement: true } : { width: 1920, height: 1080, fit: "inside", withoutEnlargement: true };
  const transformed = await sharp(buffer).resize(resize).webp({ quality: 80 }).toBuffer();
  return { buffer: transformed, format: "webp", contentType: "image/webp" };
}

export function createManifestEntry(asset, { classification, profile, target, sourceSha256 }) {
  return {
    source: {
      cloudName: (() => { try { return new URL(asset.secure_url).pathname.split("/")[1]; } catch { return null; } })(),
      resourceType: "image", deliveryType: "upload", publicId: asset.public_id, format: asset.format || null,
      version: asset.version ?? null, secureUrl: asset.secure_url, bytes: asset.bytes ?? null, width: asset.width ?? null, height: asset.height ?? null,
    },
    classification,
    target,
    sourceSha256,
    status: "planned",
    copiedAt: null,
    verifiedAt: null,
    error: null,
  };
}

async function fetchBuffer(url, transport = fetch) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await transport(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        if (response.status !== 429 && response.status < 500) {
          const error = new Error(`Source download failed with ${response.status}`);
          error.retryable = false;
          throw error;
        }
        throw new Error(`Retryable source download status ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function copyOneAsset(asset, { env = process.env, copy = false, transport, downloadSource = fetchBuffer, now = () => new Date().toISOString() } = {}) {
  const classificationResult = classifyCloudinaryAsset(asset);
  if (classificationResult.error) return { source: { publicId: asset?.public_id || null }, status: "blocked", error: classificationResult.error };
  try {
    assertSafePublicId(asset.public_id);
    if (asset.resource_type && asset.resource_type !== "image") throw new Error("unsupported-resource-type");
    const classification = classificationResult.classification;
    const profile = profileForAsset(asset, classification);
    const zone = getZoneConfiguration(env, classification);
    const original = await downloadSource(asset.secure_url);
    const transformed = await transformAsset(original, asset, profile);
    const objectKey = `${asset.public_id}.${transformed.format}`;
    const target = { zone: zone.zone, profile, logicalPublicId: asset.public_id, objectKey, format: transformed.format, contentType: transformed.contentType, unsignedUrl: buildBunnyCdnUrl({ cdnBaseUrl: zone.cdnBaseUrl, objectKey }), bytes: transformed.buffer.length, sha256: sha256(transformed.buffer) };
    const entry = createManifestEntry(asset, { classification, profile, target, sourceSha256: sha256(original) });
    let existing;
    try {
      existing = await downloadBunnyObject({ ...zone, objectKey, transport });
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
      existing = null;
    }
    if (existing) {
      if (sha256(existing) === target.sha256) return { ...entry, status: "skipped-existing-identical", verifiedAt: now() };
      return { ...entry, status: "collision", error: "existing-target-bytes-differ" };
    }
    if (!copy) return entry;
    await uploadBunnyObject({ ...zone, objectKey, buffer: transformed.buffer, contentType: transformed.contentType, transport });
    const verified = await downloadBunnyObject({ ...zone, objectKey, transport });
    if (sha256(verified) !== target.sha256) return { ...entry, status: "failed", copiedAt: now(), error: "post-upload-hash-mismatch" };
    return { ...entry, status: "verified", copiedAt: now(), verifiedAt: now() };
  } catch (error) { return { source: { publicId: asset?.public_id || null }, status: "failed", error: error instanceof Error ? error.message.replace(/(?:AccessKey|token|secret|key)=?[^\s,]*/gi, "[redacted]") : "copy-failed" }; }
}

export async function verifyManifestEntry(
  entry,
  { env = process.env, transport, now = () => new Date().toISOString() } = {},
) {
  try {
    if (
      !entry?.source?.publicId ||
      !entry?.classification ||
      !entry?.target?.objectKey ||
      !/^[a-f0-9]{64}$/.test(entry?.target?.sha256 || "")
    ) {
      throw new Error("invalid-manifest-entry");
    }
    const zone = getZoneConfiguration(env, entry.classification);
    const stored = await downloadBunnyObject({
      ...zone,
      objectKey: entry.target.objectKey,
      transport,
    });
    if (sha256(stored) !== entry.target.sha256) {
      return { ...entry, status: "failed", error: "target-hash-mismatch" };
    }
    return {
      ...entry,
      status: "verified",
      verifiedAt: now(),
      error: null,
    };
  } catch (error) {
    return {
      ...entry,
      status: "failed",
      error: error?.statusCode === 404 ? "target-missing" : "target-verification-failed",
    };
  }
}

export function previousVerifiedEntryForAsset(previousManifest, asset) {
  const entry = previousManifest?.entries?.find((candidate) => candidate?.source?.publicId === asset?.public_id);
  if (!entry || !["verified", "skipped-existing-identical"].includes(entry.status)) return null;
  const source = entry.source || {};
  const unchanged = source.secureUrl === asset.secure_url
    && source.format === (asset.format || null)
    && source.version === (asset.version ?? null);
  return unchanged ? entry : null;
}

export async function resumeCopyEntry(asset, {
  previousManifest,
  copy,
  env = process.env,
  transport,
  downloadSource = fetchBuffer,
} = {}) {
  const previous = previousVerifiedEntryForAsset(previousManifest, asset);
  if (!previous) return copyOneAsset(asset, { copy, env, transport, downloadSource });
  const verified = await verifyManifestEntry(previous, { env, transport });
  if (verified.status === "verified") return { ...verified, status: "skipped-existing-identical" };
  return copyOneAsset(asset, { copy, env, transport, downloadSource });
}

export async function runBounded(items, concurrency, worker) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); }
  }));
  return results;
}

export function summarizeEntries(entries) {
  return entries.reduce((summary, entry) => { summary.statuses[entry.status] = (summary.statuses[entry.status] || 0) + 1; const key = entry.classification || "unknown"; summary.classes[key] = (summary.classes[key] || 0) + 1; if (entry.target?.format) summary.formats[entry.target.format] = (summary.formats[entry.target.format] || 0) + 1; if (entry.target?.profile) summary.profiles[entry.target.profile] = (summary.profiles[entry.target.profile] || 0) + 1; return summary; }, { statuses: {}, classes: {}, formats: {}, profiles: {} });
}

export async function writeCopyReport(report, { directory = REPORT_DIR, now = new Date() } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const name = `copy-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  const output = path.join(directory, name);
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCopyArguments(argv);
  const classes = options.onlyPublic ? ["public"] : options.onlyInstapay ? ["private"] : ["public", "private"];
  const startedAt = new Date().toISOString();
  let previousManifest = null;
  if (options.manifest) {
    previousManifest = validatePreviousManifest(
      JSON.parse(await fs.readFile(options.manifest, "utf8")),
      { env: process.env, classes },
    );
  }

  let entries;
  let confirmedUnavailableSources = Array.isArray(previousManifest?.confirmedUnavailableSources)
    ? [...previousManifest.confirmedUnavailableSources]
    : [];
  let recoveryProvenance = previousManifest?.recoveryProvenance ?? null;
  if (options.recoveryReport) {
    const recoverySource = JSON.parse(await fs.readFile(options.recoveryReport, "utf8"));
    recoveryProvenance = createRecoveryProvenance(previousManifest, recoverySource);
    const groups = groupUnresolvedSources(recoverySource);
    const recoveryByteBudget = createRecoveryByteBudget();
    const captures = await runBounded(groups, options.concurrency, (group) =>
      captureUnresolvedGroup(group, { byteBudget: recoveryByteBudget }),
    );
    const { baseEntries, recovered } = await withRecoveryCaptureCleanup(
      captures,
      recoveryByteBudget,
      async () => {
        const blockedCapture = captures.find((capture) => capture.kind === "blocked");
        if (blockedCapture) throw new Error(`Recovery capture blocked: ${blockedCapture.error}`);
        const baseEntries = await verifyRecoveryBaseEntries(previousManifest, {
          concurrency: options.concurrency,
          onProgress: (completed, total) => {
            if (completed % 25 === 0 || completed === total) console.log(`Verified inherited ${completed}/${total}`);
          },
        });
        const recovered = await runBounded(captures, options.concurrency, (capture) =>
          capture.kind === "captured"
            ? materializeCapturedRecovery(capture, { env: process.env, copy: options.copy })
            : capture,
        );
        return { baseEntries, recovered };
      },
    );
    const existingPublicIds = new Set(baseEntries.map((entry) => entry?.source?.publicId).filter(Boolean));
    const recoveryEntries = [];
    for (const result of recovered) {
      if (result.kind === "unavailable") {
        confirmedUnavailableSources.push(result.record);
        continue;
      }
      const entry = result.kind === "entry"
        ? result.entry
        : { source: { publicId: result.publicId }, classification: "public", status: "blocked", error: result.error };
      if (existingPublicIds.has(entry?.source?.publicId)) throw new Error("Recovery source already exists in previous manifest");
      existingPublicIds.add(entry?.source?.publicId);
      recoveryEntries.push(entry);
    }
    const unavailableIds = new Set();
    confirmedUnavailableSources = confirmedUnavailableSources
      .sort((left, right) => left.publicId.localeCompare(right.publicId))
      .filter((record) => {
        if (unavailableIds.has(record.publicId)) throw new Error("Duplicate confirmed unavailable public ID");
        unavailableIds.add(record.publicId);
        if (existingPublicIds.has(record.publicId)) throw new Error("Unavailable source also exists in manifest entries");
        return true;
      });
    entries = [...baseEntries, ...recoveryEntries]
      .sort((left, right) => left.source.publicId.localeCompare(right.source.publicId));
  } else if (options.verifyOnly) {
    const eligible = previousManifest.entries
      .filter((entry) => classes.includes(entry.classification))
      .sort((left, right) => left.source.publicId.localeCompare(right.source.publicId));
    const selected = options.limit ? eligible.slice(0, options.limit) : eligible;
    entries = await runBounded(selected, options.concurrency, (entry, index) =>
      verifyManifestEntry(entry).then((result) => {
        if ((index + 1) % 25 === 0) console.log(`Processed ${index + 1}/${selected.length}`);
        return result;
      }),
    );
  } else {
    const resources = sourceSort((await Promise.all(classes.map((classification) =>
      enumerateCloudinaryResources({
        prefix: classification === "public" ? "petyard/" : "instapay_screenshots/",
      })))).flat());
    const blockers = findPreflightBlockers(resources);
    const blockedClasses = new Set(
      resources
        .map((asset, index) => blockers[index] ? classifyCloudinaryAsset(asset).classification : null)
        .filter(Boolean),
    );
    const selectedPairs = resources
      .map((asset, index) => ({ asset, blocker: blockers[index] }))
      .slice(0, options.limit || resources.length);
    entries = await runBounded(selectedPairs, options.concurrency, ({ asset, blocker }, index) => {
      const classification = classifyCloudinaryAsset(asset).classification;
      const classBlocked = options.copy && blockedClasses.has(classification);
      const work = blocker || classBlocked
        ? Promise.resolve({
            source: { publicId: asset?.public_id || null },
            classification,
            status: "blocked",
            error: blocker || "class-blocked-by-preflight",
          })
        : resumeCopyEntry(asset, {
            previousManifest,
            copy: options.copy,
            env: process.env,
          });
      return work.then((entry) => {
        if ((index + 1) % 25 === 0) console.log(`Processed ${index + 1}/${selectedPairs.length}`);
        return entry;
      });
    });
  }

  console.log(`Processed ${entries.length}/${entries.length}`);
  const totals = entries.reduce((result, entry) => {
    result.sourceBytes += Number(entry.source?.bytes || 0);
    result.targetBytes += Number(entry.target?.bytes || 0);
    return result;
  }, { sourceBytes: 0, targetBytes: 0 });
  const counts = summarizeEntries(entries);
  const mode = options.recoveryReport
    ? options.copy ? "recovery-copy" : "recovery-plan"
    : options.verifyOnly ? "verify-only"
      : options.copy ? "copy" : "plan";
  const report = {
    mode,
    sourceCloud: process.env.CLOUDINARY_CLOUD_NAME || null,
    targetZones: classes.map((classification) => getZoneConfiguration(process.env, classification).zone),
    startedAt,
    completedAt: new Date().toISOString(),
    options: {
      ...options,
      manifest: options.manifest ? path.basename(options.manifest) : null,
      recoveryReport: options.recoveryReport ? path.basename(options.recoveryReport) : null,
    },
    counts,
    totals,
    failureSummaries: Object.fromEntries(
      Object.entries(counts.statuses).filter(([status]) => !["planned", "verified", "skipped-existing-identical"].includes(status)),
    ),
    recoveryProvenance,
    confirmedUnavailableSources,
    entries,
  };
  const output = await writeCopyReport(report);
  console.log(`Copy report written: ${output}`);
  if (entries.some((entry) => !["planned", "verified", "skipped-existing-identical"].includes(entry.status))) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
