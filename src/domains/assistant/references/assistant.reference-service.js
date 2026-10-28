import { createHash, randomUUID } from "node:crypto";
import { roles } from "../../../shared/constants/enums.js";
import { reject } from "../shared/assistant.errors.js";
import { fields, objectId, text } from "../shared/assistant.validation.js";
import { requireReferences } from "./assistant.reference-config.js";
import { AssistantReference, assertReferenceStore } from "./assistant.reference.model.js";
import { inspectReferenceFile } from "./assistant.reference-file.js";
import { createReferenceStorage, sourceObjectKey } from "./assistant.reference-storage.js";
import { referenceVectorIndex } from "./assistant.reference-passage.model.js";
import { referencePassageVersion } from "./assistant.reference-passages.js";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";

const messages = {
  reference_uploads_unavailable: "Reference uploads are currently unavailable.",
  reference_configuration_required: "Reference processing needs server configuration.",
  reference_private_storage_required: "Private reference storage is not configured.",
  reference_store_unavailable: "Reference records are currently unavailable.",
  reference_file_required: "Select one nonempty reference file.",
  reference_file_too_large: "The file exceeds the allowed upload size.",
  reference_text_too_large: "The document exceeds the allowed text size.",
  reference_invalid_filename: "Use a filename without folder paths or control characters.",
  reference_unsupported_format: "Use searchable PDF, DOCX, Markdown or UTF-8 plain text.",
  reference_format_mismatch: "The file content or declared type does not match its extension.",
  reference_invalid_encoding: "Save the text document using UTF-8 encoding.",
  reference_invalid_text: "The text file contains unsupported binary characters.",
  reference_no_readable_text: "No readable text was found. Upload a searchable version.",
  reference_invalid_document: "The document could not be read. Upload a valid supported copy.",
  reference_password_protected: "Upload an unlocked copy of this document.",
  reference_unsupported_content: "The document contains an unsupported structure or active content.",
  reference_archive_too_large: "The expanded Word document exceeds processing limits.",
  reference_too_many_pages: "The PDF exceeds the allowed page count.",
  reference_processing_limit: "The document exceeded processing resources.",
  reference_processing_timeout: "The document took too long to process. You can retry.",
  reference_processing_cancelled: "Document processing was cancelled.",
  reference_processing_failed: "Document processing could not finish. You can retry.",
  reference_preparation_invalid: "The extracted source could not be prepared safely. Review the document and its source details.",
  reference_too_many_passages: "The document exceeds the supported number of reference excerpts.",
  reference_processing_interrupted: "Processing was interrupted. You can retry.",
  reference_storage_failed: "The private file could not be stored. Upload the same file again.",
  reference_source_unavailable: "The saved source could not be read. You can retry.",
  reference_source_changed: "The saved file failed its integrity check. It needs investigation.",
  reference_reupload_required: "Upload the same file again to finish storing it.",
  reference_changed: "The reference changed. Refresh its details before trying again.",
  reference_retry_unavailable: "This reference cannot be retried in its current state.",
  reference_not_found: "The reference was not found.",
  reference_index_wait: "Reference indexing is waiting for server setup or a temporary dependency. It will try again later.",
  reference_search_wait: "Reference passages are stored, but search verification is not finished. Processing will check again later.",
  reference_embedding_budget_wait: "Reference indexing is waiting for the existing assistant spending allowance to become available.",
  reference_embedding_needs_review: "An embedding request has an uncertain result or charge. Processing is paused for investigation; do not upload another copy.",
  reference_embedding_failed: "An embedding request failed. Processing is paused for investigation.",
  reference_indexing_invalid: "The saved reference or processing details failed verification. Processing is paused for investigation.",
  reference_indexing_access: "The uploader no longer has permission to process this reference. Processing is paused.",
  reference_activation_unavailable: "This reference is not ready for approval. Refresh its details and review its processing status.",
  reference_activation_check_failed: "Current search coverage could not be verified. The reference was not activated. Refresh its details before trying again.",
  request_rate_limit: "Too many reference requests. Wait before trying again.",
};
const retryable = new Set(["reference_processing_failed", "reference_processing_timeout", "reference_processing_interrupted", "reference_source_unavailable", "request_rate_limit"]);
export function referenceFailure(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : "reference_processing_failed";
  return { code, message: messages[code], retryable: retryable.has(code) };
}
export function referenceActor(actor) {
  if (actor?.role !== roles.SUPER_ADMIN || actor.phoneVerified !== true) reject("access_denied", 403);
  return objectId(String(actor._id));
}
export function referenceMetadata(body) {
  fields(body, ["title", "authors", "edition", "sourceUrl", "species"]);
  const metadataText = (value, max) => {
    const result = text(value, max);
    if (!result.isWellFormed()) reject("invalid_request");
    return result;
  };
  let species = body.species;
  if (typeof species === "string") { try { species = JSON.parse(species); } catch { reject("invalid_request"); } }
  if (!Array.isArray(species) || !species.length || species.length > 10) reject("invalid_request");
  species = species.map(value => metadataText(value, 40).toLowerCase());
  if (new Set(species).size !== species.length) reject("invalid_request");
  const optional = (value, max) => value === undefined || value === "" ? "" : metadataText(value, max);
  const sourceUrl = optional(body.sourceUrl, 2000);
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch { reject("invalid_request"); }
    if (url.protocol !== "https:" || url.username || url.password) reject("invalid_request");
  }
  return { title: metadataText(body.title, 200), authors: optional(body.authors, 500), edition: optional(body.edition, 80), sourceUrl, species };
}
export function referenceCanActivate(row) {
  const proof = row.searchVerification;
  return row.status === "needs_review" && row.stage === "awaiting_approval" && row.sourceStored === true &&
    row.indexingBlocked !== true && !row.failureCode && row.passageVersion === referencePassageVersion &&
    /^[a-f\d]{64}$/.test(row.sha256 ?? "") && /^[a-f\d]{64}$/.test(row.passageHash ?? "") &&
    Number.isSafeInteger(row.passageCount) && row.passageCount > 0 && row.passageCount <= 10000 && row.storedPassageCount === row.passageCount &&
    proof?.model === embeddingProfile.model && proof.dimensions === embeddingProfile.dimensions &&
    proof.manifestHash === row.passageHash && proof.passageCount === row.passageCount && proof.indexName === referenceVectorIndex.name &&
    typeof proof.indexId === "string" && Boolean(proof.indexId.trim()) && proof.indexId.length <= 200 && !proof.indexId.includes("\u0000") &&
    Number.isSafeInteger(proof.indexVersion) && proof.indexVersion >= 0 && proof.verifiedAt instanceof Date && Number.isFinite(proof.verifiedAt.getTime());
}
export function referenceDto(row) {
  return { id: String(row._id), title: row.title, authors: row.authors, edition: row.edition, sourceUrl: row.sourceUrl,
    species: row.species, filename: row.filename, format: row.format, bytes: row.bytes,
    status: row.status, stage: row.stage, version: row.version, preview: row.preview ?? "",
    unitCount: row.unitCount ?? null, textBytes: row.textBytes ?? null, passageCount: row.passageCount ?? null, warnings: row.warnings ?? [],
    storedPassageCount: row.storedPassageCount ?? 0, indexingBlocked: row.indexingBlocked === true,
    nextAttemptAt: row.indexingRetryAt?.toISOString() ?? null,
    searchVerifiedAt: row.searchVerification?.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activation?.at?.toISOString() ?? null, activatedBy: row.activation?.actor ? String(row.activation.actor) : null,
    error: row.failureCode ? referenceFailure({ code: row.failureCode }) : null,
    actions: { canActivate: referenceCanActivate(row), canRetry: row.status === "failed" && row.sourceStored === true && retryable.has(row.failureCode),
      canReupload: row.status === "failed" && (!row.sourceStored || row.failureCode === "reference_source_changed"),
      canDisable: row.status !== "disabled" },
    uploadedBy: String(row.creator), createdAt: row.createdAt?.toISOString() ?? null, updatedAt: row.updatedAt?.toISOString() ?? null };
}
export const sourceHash = buffer => createHash("sha256").update(buffer).digest("hex");

// Factory injection is limited to local tests; production uses the concrete model and Bunny adapter below.
export function createReferenceService({ model = AssistantReference, ensureStore = assertReferenceStore,
  storage = createReferenceStorage, verifyCoverage, now = () => new Date() } = {}) {
  async function admit(actor, config) { referenceActor(actor); requireReferences(config); await ensureStore(); }
  async function find(id) {
    const row = await model.findById(objectId(String(id))).lean();
    if (!row) reject("reference_not_found", 404);
    return row;
  }
  const version = body => {
    fields(body, ["expectedVersion"]);
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) reject("invalid_request");
    return body.expectedVersion;
  };
  return {
    async upload(actor, body, file, config) {
      await admit(actor, config);
      const metadata = referenceMetadata(body);
      const inspected = inspectReferenceFile(file, config.limits);
      const lease = randomUUID(), timestamp = now();
      let row;
      try {
        row = await model.findOneAndUpdate({ sha256: inspected.sha256 }, { $setOnInsert: {
          ...metadata, creator: referenceActor(actor), sha256: inspected.sha256,
          filename: inspected.filename, format: inspected.format, bytes: inspected.bytes,
          status: "processing", stage: "uploading", version: 1, sourceStored: false,
          lease, leaseUntil: new Date(timestamp.getTime() + 300_000),
        } }, { upsert: true, new: true, runValidators: true }).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        row = await model.findOne({ sha256: inspected.sha256 }).lean();
        if (!row) throw error;
      }
      if (row.lease !== lease) {
        if (row.status !== "failed" || (row.sourceStored && row.failureCode !== "reference_source_changed")) return { duplicate: true, reference: referenceDto(row) };
        row = await model.findOneAndUpdate({ _id: row._id, version: row.version, status: "failed" },
          { $set: { status: "processing", stage: "uploading", sourceStored: false, lease, leaseUntil: new Date(timestamp.getTime() + 300_000), failureCode: null },
            $inc: { version: 1 } }, { new: true, runValidators: true }).lean();
        if (!row) reject("reference_changed", 409);
      }
      try {
        await storage(config).put(sourceObjectKey(row), file.buffer, "application/octet-stream");
        const saved = await model.findOneAndUpdate({ _id: row._id, lease, status: "processing", stage: "uploading" },
          { $set: { sourceStored: true, stage: "queued", lease: null, leaseUntil: null }, $inc: { version: 1 } }, { new: true }).lean();
        return { duplicate: false, reference: referenceDto(saved ?? await find(row._id)) };
      } catch {
        const saved = await model.findOneAndUpdate({ _id: row._id, lease, status: "processing" },
          { $set: { status: "failed", stage: "failed", failureCode: "reference_storage_failed", lease: null, leaseUntil: null },
            $inc: { version: 1 } }, { new: true }).lean();
        return { duplicate: false, reference: referenceDto(saved ?? await find(row._id)) };
      }
    },
    async list(actor, query, config) {
      await admit(actor, config); fields(query, ["before", "limit"]);
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("invalid_request");
      const rows = await model.find(query.before ? { _id: { $lt: objectId(query.before) } } : {})
        .sort({ _id: -1 }).limit(limit + 1).lean();
      return { references: rows.slice(0, limit).map(referenceDto), nextBefore: rows.length > limit ? String(rows[limit - 1]._id) : null };
    },
    async get(actor, id, config) { await admit(actor, config); return referenceDto(await find(id)); },
    async activate(actor, id, body, config) {
      await admit(actor, config); const expectedVersion = version(body); const row = await find(id);
      if (row.version !== expectedVersion) reject("reference_changed", 409);
      if (row.status === "ready") return referenceDto(row);
      if (!referenceCanActivate(row)) reject("reference_activation_unavailable", 409);
      let searchVerification;
      try {
        const manifest = await storage(config).get(row.passageKey, 64 * 1024 * 1024);
        const verify = verifyCoverage ?? (await import("./assistant.reference-coverage.js")).createReferenceCoverageVerifier();
        searchVerification = await verify(row, manifest);
        if (!referenceCanActivate({ ...row, searchVerification })) reject("reference_activation_unavailable", 409);
      } catch { reject("reference_activation_check_failed", 503); }
      // Approval belongs to this exact source/manifest and the revision the SuperAdmin reviewed.
      const saved = await model.findOneAndUpdate({ _id: row._id, version: expectedVersion, status: "needs_review", stage: "awaiting_approval",
        passageHash: row.passageHash, sha256: row.sha256, sourceStored: true, indexingBlocked: { $ne: true } },
        { $set: { status: "ready", stage: "ready", searchVerification, failureCode: null, indexingRetryAt: null,
          activation: { manifestHash: row.passageHash, sourceHash: row.sha256, actor: referenceActor(actor), at: now(), reviewedVersion: expectedVersion } },
          $inc: { version: 1 } }, { new: true, runValidators: true }).lean();
      if (!saved) reject("reference_changed", 409);
      return referenceDto(saved);
    },
    async retry(actor, id, body, config) {
      await admit(actor, config); const expectedVersion = version(body); const row = await find(id);
      if (row.version !== expectedVersion) reject("reference_changed", 409);
      if (!row.sourceStored) reject("reference_reupload_required", 409);
      if (row.status !== "failed" || !retryable.has(row.failureCode)) reject("reference_retry_unavailable", 409);
      const saved = await model.findOneAndUpdate({ _id: row._id, version: expectedVersion, status: "failed" },
        { $set: { status: "processing", stage: "queued", failureCode: null, lease: null, leaseUntil: null },
          $inc: { version: 1 } }, { new: true }).lean();
      if (!saved) reject("reference_changed", 409);
      return referenceDto(saved);
    },
    async disable(actor, id, body, config) {
      await admit(actor, config); const expectedVersion = version(body); const row = await find(id);
      if (row.version !== expectedVersion) reject("reference_changed", 409);
      if (row.status === "disabled") return referenceDto(row);
      const saved = await model.findOneAndUpdate({ _id: row._id, version: expectedVersion },
        { $set: { status: "disabled", stage: "disabled", disabledBy: referenceActor(actor), lease: null, leaseUntil: null },
          $inc: { version: 1 } }, { new: true }).lean();
      if (!saved) reject("reference_changed", 409);
      return referenceDto(saved);
    },
  };
}
export const referenceService = createReferenceService();
