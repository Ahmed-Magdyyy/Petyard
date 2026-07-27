import "@dotenvx/dotenvx/config";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import mongoose from "mongoose";

const REPORT_DIR = path.resolve("scripts/bunny-migration-reports");
const CLOUDS = new Set(["dxemmiorv", "dx5n4ekk2"]);

export function parseRewriteArguments(argv = process.argv.slice(2)) {
  const value = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const manifest = value("--manifest"); const rollbackReport = value("--rollback-report"); const apply = argv.includes("--apply");
  if (Boolean(manifest) === Boolean(rollbackReport)) throw new Error("Provide exactly one of --manifest or --rollback-report");
  if (apply && manifest && !argv.includes("--confirm-live-db-rewrite")) throw new Error("--apply requires --confirm-live-db-rewrite");
  if (apply && rollbackReport && !argv.includes("--confirm-live-db-rollback")) throw new Error("--apply requires --confirm-live-db-rollback");
  return { manifest: manifest && path.resolve(manifest), rollbackReport: rollbackReport && path.resolve(rollbackReport), apply };
}

export function parseCloudinaryImageUrl(value) {
  if (typeof value !== "string" || !value) return null;
  let parsed; try { parsed = new URL(value); } catch { return null; }
  if (parsed.hostname !== "res.cloudinary.com") return null;
  if (parsed.protocol !== "https:") return { unsupported: true, reason: "non-https-cloudinary-url" };
  if (parsed.port || parsed.username || parsed.password) return { unsupported: true, reason: "malformed-cloudinary-image-url" };
  const [, cloudName, resourceType, deliveryType, ...rest] = parsed.pathname.split("/");
  if (!CLOUDS.has(cloudName)) return { unsupported: true, reason: "unknown-cloudinary-cloud" };
  if (resourceType !== "image" || deliveryType !== "upload" || !rest.length) return { unsupported: true, reason: "unsupported-cloudinary-resource" };
  const versionIndex = rest.findIndex((part) => /^v\d+$/.test(part));
  const encodedIdentity = versionIndex >= 0 ? rest.slice(versionIndex + 1) : rest;
  let identity;
  try {
    identity = encodedIdentity.map((part) => decodeURIComponent(part));
  } catch {
    return { unsupported: true, reason: "malformed-cloudinary-image-url" };
  }
  if (!identity.length || identity.some((part) => !part || part === "." || part === ".." || part.includes("/") || /\\/.test(part) || /[\0-\x1f?#]/.test(part))) return { unsupported: true, reason: "malformed-cloudinary-image-url" };
  const filename = identity.at(-1); const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) return { unsupported: true, reason: "missing-cloudinary-format" };
  identity[identity.length - 1] = filename.slice(0, extensionIndex);
  return { cloudName, publicId: identity.join("/"), value };
}

export function createVerifiedManifestMap(report) {
  if (!report || !Array.isArray(report.entries)) throw new Error("Invalid migration manifest");
  const result = new Map();
  for (const entry of report.entries) {
    const validStatus = entry?.status === "verified" || entry?.status === "skipped-existing-identical";
    if (!validStatus || !entry?.source?.publicId || !entry?.target?.unsignedUrl || !/^[a-f0-9]{64}$/.test(entry?.target?.sha256 || "")) continue;
    if (result.has(entry.source.publicId)) throw new Error("Duplicate verified public ID in migration manifest");
    const target = new URL(entry.target.unsignedUrl);
    if (target.protocol !== "https:" || target.search || target.hash) throw new Error("Invalid verified target URL in migration manifest");
    result.set(entry.source.publicId, entry);
  }
  return result;
}

export function getManifestCompletenessErrors(report) {
  if (!report || !Array.isArray(report.entries) || report.entries.length === 0) return ["manifest-has-no-entries"];
  const errors = [];
  const seen = new Set();
  for (const entry of report.entries) {
    const sourceId = entry?.source?.publicId;
    const complete = ["verified", "skipped-existing-identical"].includes(entry?.status)
      && typeof sourceId === "string" && sourceId
      && ["public", "private"].includes(entry?.classification)
      && typeof entry?.target?.zone === "string" && entry.target.zone
      && typeof entry?.target?.unsignedUrl === "string"
      && /^[a-f0-9]{64}$/.test(entry?.target?.sha256 || "")
      && typeof entry?.target?.objectKey === "string" && entry.target.objectKey;
    if (!complete) errors.push("manifest-entry-not-verified-and-complete");
    if (sourceId && seen.has(sourceId)) errors.push("manifest-has-duplicate-source-public-id");
    if (sourceId) seen.add(sourceId);
  }
  return errors;
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function planDocumentUrlRewrites(document, manifestMap, { pathPrefix = "" } = {}) {
  const changes = []; const unresolved = [];
  const stats = { scannedStringFields: 0, externalUrlsIgnored: 0 };
  const visit = (value, currentPath) => {
    if (typeof value === "string") {
      stats.scannedStringFields += 1;
      const parsed = parseCloudinaryImageUrl(value);
      if (!parsed) {
        try {
          const external = new URL(value);
          if (external.protocol === "https:" || external.protocol === "http:") stats.externalUrlsIgnored += 1;
        } catch {}
        return;
      }
      if (parsed.unsupported) { unresolved.push({ path: currentPath, value, reason: parsed.reason }); return; }
      const entry = manifestMap.get(parsed.publicId);
      if (!entry) { unresolved.push({ path: currentPath, value, publicId: parsed.publicId, reason: "unresolved-source-public-id" }); return; }
      changes.push({ path: currentPath, before: value, after: entry.target.unsignedUrl, classification: entry.classification, cloudName: parsed.cloudName }); return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, currentPath ? `${currentPath}.${index}` : String(index)));
    else if (isPlainRecord(value)) Object.entries(value).forEach(([key, item]) => visit(item, currentPath ? `${currentPath}.${key}` : key));
  };
  visit(document, pathPrefix);
  return { changes, unresolved, stats };
}

export function buildForwardOperation(collection, document, changes) {
  const filter = { _id: document._id }; const set = {};
  for (const change of changes) { filter[change.path] = change.before; set[change.path] = change.after; }
  return { updateOne: { filter, update: { $set: set } } };
}

export function planRollbackField(currentValue, field) {
  if (currentValue === field.after) return { action: "restore", before: field.after, after: field.before };
  if (currentValue === field.before) return { action: "already-restored" };
  return { action: "conflict" };
}

export function redactReportValue(value) { return typeof value === "string" ? value.replace(/(mongodb(?:\+srv)?:\/\/)[^\s"']+/gi, "$1[redacted]") : value; }

async function readJson(filePath) { return JSON.parse(await fs.readFile(filePath, "utf8")); }
async function writeReport(report) { await fs.mkdir(REPORT_DIR, { recursive: true }); const output = path.join(REPORT_DIR, `db-rewrite-${new Date().toISOString().replace(/[:.]/g, "-")}.json`); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`); return output; }
function databaseIdentity(connection) { return { host: connection.connection.host, name: connection.connection.name }; }

export async function buildForwardPlan(connection, manifestMap) {
  const plan = []; const unresolved = []; let documents = 0;
  let scannedStringFields = 0; let externalUrlsIgnored = 0;
  const byCollection = {};
  const collections = await connection.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    const collection = connection.connection.db.collection(name);
    const cursor = collection.find({});
    for await (const document of cursor) {
      documents += 1; const result = planDocumentUrlRewrites(document, manifestMap);
      byCollection[name] ||= { documents: 0, changedDocuments: 0, changedFields: 0 };
      byCollection[name].documents += 1;
      scannedStringFields += result.stats.scannedStringFields;
      externalUrlsIgnored += result.stats.externalUrlsIgnored;
      unresolved.push(...result.unresolved.map((entry) => ({ collection: name, documentId: String(document._id), ...entry })));
      if (result.changes.length) {
        byCollection[name].changedDocuments += 1;
        byCollection[name].changedFields += result.changes.length;
        plan.push({ collection: name, documentId: String(document._id), changes: result.changes, operation: buildForwardOperation(name, document, result.changes) });
      }
    }
  }
  return { plan, unresolved, documents, scannedStringFields, externalUrlsIgnored, byCollection };
}

export async function applyForwardPlan(connection, plan, { batchSize = 100 } = {}) {
  const results = [];
  for (const group of Map.groupBy(plan, (entry) => entry.collection).values()) {
    const collection = connection.connection.db.collection(group[0].collection);
    for (let index = 0; index < group.length; index += batchSize) {
      const batch = group.slice(index, index + batchSize);
      try {
        const result = await collection.bulkWrite(batch.map((entry) => entry.operation), { ordered: false });
        results.push({ collection: group[0].collection, matched: result.matchedCount, modified: result.modifiedCount, expected: batch.length });
      } catch (error) {
        results.push({ collection: group[0].collection, matched: 0, modified: 0, expected: batch.length, error: "bulk-write-failed" });
      }
    }
  }
  return results;
}

export async function buildRollbackPlan(connection, report) {
  if (!report || !Array.isArray(report.changedFields)) throw new Error("Invalid apply report for rollback");
  const plan = []; const summary = { restored: 0, alreadyRestored: 0, missingDocument: 0, conflicts: 0 };
  for (const field of report.changedFields) {
    if (!field?.collection || !field?.documentId || typeof field.path !== "string" || typeof field.before !== "string" || typeof field.after !== "string") throw new Error("Invalid rollback field record");
    const collection = connection.connection.db.collection(field.collection);
    const document = await collection.findOne({ _id: new mongoose.Types.ObjectId(field.documentId) }, { projection: { [field.path]: 1 } });
    if (!document) { summary.missingDocument += 1; continue; }
    const current = field.path.split(".").reduce((value, key) => value?.[key], document);
    const decision = planRollbackField(current, field);
    if (decision.action === "restore") { summary.restored += 1; plan.push({ collection: field.collection, field, operation: { updateOne: { filter: { _id: document._id, [field.path]: field.after }, update: { $set: { [field.path]: field.before } } } } }); }
    else if (decision.action === "already-restored") summary.alreadyRestored += 1;
    else summary.conflicts += 1;
  }
  return { plan, summary };
}

export async function applyRollbackPlan(connection, plan, { batchSize = 100 } = {}) {
  const results = [];
  for (const group of Map.groupBy(plan, (entry) => entry.collection).values()) {
    const collection = connection.connection.db.collection(group[0].collection);
    for (let index = 0; index < group.length; index += batchSize) {
      const batch = group.slice(index, index + batchSize);
      try {
        const result = await collection.bulkWrite(batch.map((entry) => entry.operation), { ordered: false });
        results.push({ collection: group[0].collection, matched: result.matchedCount, modified: result.modifiedCount, expected: batch.length });
      } catch (error) {
        results.push({ collection: group[0].collection, matched: 0, modified: 0, expected: batch.length, error: "bulk-write-failed" });
      }
    }
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRewriteArguments(argv);
  const sourceReport = await readJson(options.manifest || options.rollbackReport);
  if (options.apply && options.manifest) {
    const manifestErrors = getManifestCompletenessErrors(sourceReport);
    if (manifestErrors.length) throw new Error("Refusing apply: migration manifest is not fully verified and complete");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const manifestHash = crypto.createHash("sha256").update(JSON.stringify(sourceReport)).digest("hex");
  const connection = await mongoose.connect(process.env.MONGO_URI);
  try {
    const database = databaseIdentity(connection); console.log(`Connected to database ${database.host}/${database.name}`);
    if (options.rollbackReport) {
      if (!sourceReport.database?.host || !sourceReport.database?.name) throw new Error("Rollback report database identity is required");
      if (sourceReport.database.host !== database.host || sourceReport.database.name !== database.name) throw new Error("Rollback report database identity does not match the connected database");
      const rollback = await buildRollbackPlan(connection, sourceReport);
      const results = options.apply ? await applyRollbackPlan(connection, rollback.plan) : [];
      const report = {
        mode: options.apply ? "rollback-apply" : "rollback-dry-run", database,
        rollbackReportPath: options.rollbackReport, rollbackReportHash: manifestHash,
        ...rollback.summary, updatedDocuments: results, changedFields: rollback.plan.map((entry) => entry.field),
      };
      const output = await writeReport(report); console.log(`Rollback report written: ${output}`);
      if (rollback.summary.conflicts || rollback.summary.missingDocument || results.some((result) => result.matched !== result.expected || result.modified !== result.expected)) process.exitCode = 1;
      return report;
    }
    const manifestMap = createVerifiedManifestMap(sourceReport); const forward = await buildForwardPlan(connection, manifestMap);
    if (options.apply && forward.unresolved.length) throw new Error("Refusing apply: unresolved Cloudinary URLs are present");
    const results = options.apply ? await applyForwardPlan(connection, forward.plan) : [];
    const changedFields = forward.plan.flatMap((entry) =>
      entry.changes.map((change) => ({
        collection: entry.collection,
        documentId: entry.documentId,
        ...change,
      })),
    );
    const report = {
      mode: options.apply ? "apply" : "dry-run",
      database,
      manifestPath: options.manifest,
      manifestHash,
      scannedCollections: Object.keys(forward.byCollection).length,
      scannedDocuments: forward.documents,
      scannedStringFields: forward.scannedStringFields,
      changedDocuments: forward.plan.length,
      changedFieldCount: changedFields.length,
      changesByCollection: forward.byCollection,
      publicBunnyReplacements: changedFields.filter((field) => field.classification === "public").length,
      privateBunnyReplacements: changedFields.filter((field) => field.classification === "private").length,
      legacyCloudReplacements: changedFields.filter((field) => field.cloudName === "dx5n4ekk2").length,
      externalUrlsIgnored: forward.externalUrlsIgnored,
      unresolvedSourceUrls: forward.unresolved.length,
      conflicts: results.reduce((sum, result) => sum + Math.max(0, result.expected - result.matched), 0),
      updatedDocuments: results.reduce((sum, result) => sum + result.modified, 0),
      changedFields,
      unresolved: forward.unresolved,
      results,
    };
    const output = await writeReport(report); console.log(`Rewrite report written: ${output}`);
    if (forward.unresolved.length || results.some((result) => result.matched !== result.expected || result.modified !== result.expected)) process.exitCode = 1;
    return report;
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(redactReportValue(error.message)); process.exitCode = 1; });
