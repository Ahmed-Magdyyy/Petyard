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
  if (copy && !flags.has("--confirm-bunny-write")) throw new Error("--copy requires --confirm-bunny-write");
  if (verifyOnly && !manifest) throw new Error("--verify-only requires --manifest=<report.json>");
  if (copy && verifyOnly) throw new Error("--copy and --verify-only cannot be used together");
  return { onlyPublic, onlyInstapay, limit: number("--limit", null), concurrency: number("--concurrency", 4, MAX_CONCURRENCY), copy, verifyOnly, manifest };
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
  if (options.verifyOnly) {
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
  const report = {
    mode: options.verifyOnly ? "verify-only" : options.copy ? "copy" : "plan",
    sourceCloud: process.env.CLOUDINARY_CLOUD_NAME || null,
    targetZones: classes.map((classification) => getZoneConfiguration(process.env, classification).zone),
    startedAt,
    completedAt: new Date().toISOString(),
    options: { ...options, manifest: options.manifest ? path.basename(options.manifest) : null },
    counts,
    totals,
    failureSummaries: Object.fromEntries(
      Object.entries(counts.statuses).filter(([status]) => !["planned", "verified", "skipped-existing-identical"].includes(status)),
    ),
    entries,
  };
  const output = await writeCopyReport(report);
  console.log(`Copy report written: ${output}`);
  if (entries.some((entry) => !["planned", "verified", "skipped-existing-identical"].includes(entry.status))) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
