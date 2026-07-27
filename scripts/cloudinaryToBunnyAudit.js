import "@dotenvx/dotenvx/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import mongoose from "mongoose";
import { downloadBunnyObject } from "../src/shared/utils/bunnyStorage.js";
import { getPrivateImageDeliveryUrl } from "../src/shared/utils/privateImageDelivery.js";
import { createVerifiedManifestMap, isPlainRecord, parseCloudinaryImageUrl, planDocumentUrlRewrites, redactReportValue } from "./cloudinaryToBunnyRewriteDbUrls.js";

const REPORT_DIR = path.resolve("scripts/bunny-migration-reports");
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

export function parseAuditArguments(argv = process.argv.slice(2)) {
  const manifest = argv.find((arg) => arg.startsWith("--manifest="))?.slice("--manifest=".length);
  if (!manifest) throw new Error("--manifest=<verified-report.json> is required");
  return { manifest: path.resolve(manifest), verifyStorage: argv.includes("--verify-storage"), verifyPublicCdn: argv.includes("--verify-public-cdn") };
}

export function classifyUrl(value, { publicOrigin, privateOrigin } = {}) {
  if (value == null) return "null";
  if (typeof value !== "string" || !value) return "malformed";
  const cloudinary = parseCloudinaryImageUrl(value);
  if (cloudinary && !cloudinary.unsupported) return cloudinary.cloudName === "dx5n4ekk2" ? "legacy-cloudinary" : "cloudinary";
  if (cloudinary?.unsupported) return "malformed";
  try { const parsed = new URL(value); if (parsed.origin === publicOrigin) return "bunny-public"; if (parsed.origin === privateOrigin) return "bunny-private"; return "external"; } catch { return "malformed"; }
}

export async function verifyManifestStorage(entries, zoneForClass, { transport } = {}) {
  const results = [];
  for (const entry of entries) {
    const zone = zoneForClass(entry.classification);
    try { const data = await downloadBunnyObject({ ...zone, objectKey: entry.target.objectKey, transport }); results.push({ objectKey: entry.target.objectKey, status: hash(data) === entry.target.sha256 ? "verified" : "hash-mismatch" }); }
    catch { results.push({ objectKey: entry.target.objectKey, status: "missing" }); }
  }
  return results;
}

export async function verifyPublicDelivery(entries, fetchImpl = fetch) {
  const results = [];
  for (const entry of entries.filter((entry) => entry.classification === "public")) {
    try { const response = await fetchImpl(entry.target.unsignedUrl, { signal: AbortSignal.timeout(15000) }); results.push({ objectKey: entry.target.objectKey, status: response.status === 200 && response.headers.get("content-type")?.startsWith("image/") ? "verified" : "delivery-failed" }); }
    catch { results.push({ objectKey: entry.target.objectKey, status: "delivery-failed" }); }
  }
  return results;
}

export function manifestTargetUrlSet(entries) {
  return new Set(entries.map((entry) => entry.target.unsignedUrl));
}

export async function verifyPrivateDelivery(entry, { signingKey, config, fetchImpl = fetch } = {}) {
  try {
    const unsigned = await fetchImpl(entry.target.unsignedUrl, { signal: AbortSignal.timeout(15000) });
    if (unsigned.ok) return { objectKey: entry.target.objectKey, status: "unsigned-accessible" };
    if (![401, 403].includes(unsigned.status)) return { objectKey: entry.target.objectKey, status: "unsigned-check-failed" };
    const signed = getPrivateImageDeliveryUrl(entry.target.unsignedUrl, { signingKey, config });
    if ((await fetchImpl(signed, { signal: AbortSignal.timeout(15000) })).status !== 200) return { objectKey: entry.target.objectKey, status: "signed-rejected" };
    const expired = getPrivateImageDeliveryUrl(entry.target.unsignedUrl, { signingKey, now: Date.now() - 600000, config: { ...config, privateUrlTtlSeconds: 1 } });
    const expiredResponse = await fetchImpl(expired, { signal: AbortSignal.timeout(15000) });
    return { objectKey: entry.target.objectKey, status: [401, 403].includes(expiredResponse.status) ? "verified" : "expired-check-failed" };
  } catch { return { objectKey: entry.target.objectKey, status: "delivery-failed" }; }
}

async function writeAuditReport(report) { await fs.mkdir(REPORT_DIR, { recursive: true }); const output = path.join(REPORT_DIR, `audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`); return output; }

export async function main(argv = process.argv.slice(2)) {
  const options = parseAuditArguments(argv); const manifest = JSON.parse(await fs.readFile(options.manifest, "utf8")); const map = createVerifiedManifestMap(manifest);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  try {
    const publicOrigin = process.env.BUNNY_PUBLIC_CDN_BASE_URL; const privateOrigin = process.env.BUNNY_PRIVATE_CDN_BASE_URL;
    const counts = {}; const countsByCollection = {}; const missingManifestTargets = []; const unresolved = []; const entries = [...map.values()];
    const manifestUrls = manifestTargetUrlSet(entries);
    for (const { name } of await connection.connection.db.listCollections().toArray()) {
      countsByCollection[name] = {};
      for await (const document of connection.connection.db.collection(name).find({})) {
        const planned = planDocumentUrlRewrites(document, map); unresolved.push(...planned.unresolved.map((item) => ({ collection: name, ...item })));
        const scan = (value) => { if (typeof value === "string" || value == null) { const type = classifyUrl(value, { publicOrigin, privateOrigin }); counts[type] = (counts[type] || 0) + 1; countsByCollection[name][type] = (countsByCollection[name][type] || 0) + 1; if ((type === "bunny-public" || type === "bunny-private") && !manifestUrls.has(value)) missingManifestTargets.push({ collection: name, value }); } else if (Array.isArray(value)) value.forEach(scan); else if (isPlainRecord(value)) Object.values(value).forEach(scan); };
        scan(document);
      }
    }
    const report = { mode: "audit", database: { host: connection.connection.host, name: connection.connection.name }, manifestPath: options.manifest, counts, countsByCollection, unresolved, missingManifestTargets };
    if (options.verifyStorage) report.storage = await verifyManifestStorage(entries, (classification) => ({ zone: classification === "private" ? process.env.BUNNY_PRIVATE_STORAGE_ZONE : process.env.BUNNY_PUBLIC_STORAGE_ZONE, accessKey: classification === "private" ? process.env.BUNNY_PRIVATE_STORAGE_ACCESS_KEY : process.env.BUNNY_PUBLIC_STORAGE_ACCESS_KEY, endpoint: classification === "private" ? process.env.BUNNY_PRIVATE_STORAGE_ENDPOINT : process.env.BUNNY_PUBLIC_STORAGE_ENDPOINT }));
    if (options.verifyPublicCdn) report.publicDelivery = await verifyPublicDelivery(entries);
    const privateSample = entries.filter((entry) => entry.classification === "private").sort((a, b) => a.target.objectKey.localeCompare(b.target.objectKey))[0];
    if (privateSample) {
      if (!process.env.BUNNY_PRIVATE_TOKEN_KEY) throw new Error("BUNNY_PRIVATE_TOKEN_KEY is required for private audit verification");
      report.privateDelivery = await verifyPrivateDelivery(privateSample, { signingKey: process.env.BUNNY_PRIVATE_TOKEN_KEY, config: { private: { cdnBaseUrl: privateOrigin }, privateUrlTtlSeconds: Number(process.env.BUNNY_PRIVATE_URL_TTL_SECONDS || 300) } });
    }
    const output = await writeAuditReport(report); console.log(`Audit report written: ${output}`);
    if (unresolved.length || missingManifestTargets.length || report.storage?.some((entry) => entry.status !== "verified") || report.publicDelivery?.some((entry) => entry.status !== "verified") || (report.privateDelivery && report.privateDelivery.status !== "verified")) process.exitCode = 1;
    return report;
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(redactReportValue(error.message)); process.exitCode = 1; });
