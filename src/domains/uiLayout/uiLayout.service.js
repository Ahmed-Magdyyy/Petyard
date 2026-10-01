import { createHash, randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { getOrSetCache, stableStringify } from "../../shared/utils/cache.js";
import { UiLayoutError } from "./uiLayout.error.js";
import {
  inspectLayoutContent, inspectTargeting, publicLayoutContent,
} from "./uiLayout.contract.js";
import { CUSTOMER_HOME_LAYOUT_ID, UI_LAYOUT_SCHEMA_VERSION, UI_LAYOUT_MAX_BYTES } from "./uiLayout.constants.js";
import {
  UiLayoutModel, UiLayoutDraftModel, UiLayoutPublicationModel, UiLayoutActiveModel,
  UiLayoutPreviewModel, UiLayoutAuditModel, UiLayoutOperationModel,
} from "./uiLayout.model.js";
import {
  DEFAULT_TARGETING, normalizeTargeting, targetingScopeKey, targetingOverlaps,
  chooseActiveVersion, isGlobalTargeting,
} from "./uiLayout.targeting.js";
import { inspectLayoutReferences } from "./uiLayout.references.js";
import { beforePageFilter, encodePageCursor } from "./uiLayout.pagination.js";
import { iso, draftData, versionData, publicData } from "./uiLayout.serialization.js";

const MAX_CHANGE_NOTE = 500;

function fail(code, message, statusCode, details) {
  throw new UiLayoutError(code, message, statusCode, details);
}

function checksum(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function validChangeNote(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CHANGE_NOTE;
}

function parseUtcTimestamp(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction) =>
    `.${(fraction ?? "000").padEnd(3, "0")}Z`);
  return parsed.toISOString() === canonical ? parsed : null;
}

async function insert(model, document, session) {
  const [created] = await model.create([document], { session });
  return created;
}

function operationScope(kind, id) {
  return `ui-layout:${kind}:${id}`;
}

export function createUiLayoutService({
  layoutModel = UiLayoutModel,
  draftModel = UiLayoutDraftModel,
  versionModel = UiLayoutPublicationModel,
  activeModel = UiLayoutActiveModel,
  previewModel = UiLayoutPreviewModel,
  auditModel = UiLayoutAuditModel,
  operationModel = UiLayoutOperationModel,
  inspectReferences = inspectLayoutReferences,
  getOrSet = getOrSetCache,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
  uuid = randomUUID,
  randomToken = () => randomBytes(32).toString("base64url"),
} = {}) {
  let storageReady;
  async function ensureStorageReady() {
    if (!storageReady) {
      storageReady = Promise.all([layoutModel, draftModel, versionModel, activeModel,
        previewModel, auditModel, operationModel].map((model) => model.init?.()));
    }
    await storageReady;
  }

  // A transaction retry must see results committed by an identical concurrent request.
  async function operationResponse({ scope, key, requestHash, mutation = false, session = null }) {
    if (!key) return null;
    const prior = await operationModel.findOne({ scope, key }).session(session);
    if (!prior) return null;
    if (prior.requestHash !== requestHash) {
      fail(mutation ? "UI_MUTATION_KEY_REUSED" : "UI_IDEMPOTENCY_KEY_REUSED",
        mutation ? "Mutation ID was reused with different content."
          : "Idempotency key was reused with different content.", 409);
    }
    return prior.response;
  }

  async function audit(action, { layoutId, draftId = null, versionId = null, actorId = null,
    requestId = null, details = {}, session = null }) {
    const entry = { action, layoutId, draftId, versionId, actorId, requestId, details, createdAt: now() };
    if (session) await insert(auditModel, entry, session);
    else await auditModel.create(entry);
  }

  async function ensureLayout(actorId) {
    try {
      return await layoutModel.findOneAndUpdate(
        { key: CUSTOMER_HOME_LAYOUT_ID },
        { $setOnInsert: { id: uuid(), name: "Customer Home",
          nextVersionNumber: 1, publishedEpoch: 0, createdBy: actorId } },
        { upsert: true, new: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      return layoutModel.findOne({ key: CUSTOMER_HOME_LAYOUT_ID });
    }
  }

  async function createDraft({ name, source, changeNote = null, actorId, requestId }) {
    await ensureStorageReady();
    if (typeof name !== "string" || !name.trim() || name.length > 120) {
      fail("UI_DRAFT_INVALID_NAME", "Draft name is required and must be at most 120 characters.", 400);
    }
    if (changeNote !== null && (typeof changeNote !== "string" || changeNote.length > MAX_CHANGE_NOTE)) {
      fail("UI_DRAFT_INVALID_CHANGE_NOTE", "Change note is too long.", 400);
    }
    if (!source || !["blank", "published"].includes(source.type) ||
      Object.keys(source).some((key) => !["type", "version_id"].includes(key))) {
      fail("UI_DRAFT_INVALID_SOURCE", "Source must be blank or a published version.", 400);
    }
    const layout = await ensureLayout(actorId);
    let basedOn = null;
    if (source.type === "published") {
      if (typeof source.version_id !== "string") fail("UI_DRAFT_INVALID_SOURCE", "version_id is required.", 400);
      basedOn = await versionModel.findOne({ id: source.version_id, layoutId: layout.id });
      if (!basedOn) fail("UI_VERSION_NOT_FOUND", "Published version not found.", 404);
    }
    const session = await startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const draft = await insert(draftModel, {
          id: uuid(), layoutId: layout.id, layoutKey: layout.key,
          name: name.trim(), revision: 1, schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
          basedOnVersionId: basedOn?.id ?? null, status: "draft",
          targeting: basedOn ? structuredClone(basedOn.targeting) : structuredClone(DEFAULT_TARGETING),
          content: basedOn ? structuredClone(basedOn.content) : { sections: [], navigation: { items: [] } },
          changeNote, createdBy: actorId, updatedBy: actorId,
        }, session);
        await audit("draft_created", { layoutId: layout.id, draftId: draft.id,
          actorId, requestId, session });
        result = draftData(draft);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function listDrafts({ status, limit = 20, before } = {}) {
    const filter = { layoutKey: CUSTOMER_HOME_LAYOUT_ID };
    if (status) filter.status = status;
    if (before) filter.$or = beforePageFilter("updatedAt", before);
    const rows = await draftModel.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(draftData),
      next_before: rows.length > limit ? encodePageCursor(page.at(-1), "updatedAt") : null };
  }

  async function getDraft(id) {
    const draft = await draftModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID });
    if (!draft) fail("UI_DRAFT_NOT_FOUND", "Draft not found.", 404);
    return draftData(draft);
  }

  async function saveDraft({ id, revision, body, mutationId, actorId, requestId }) {
    await ensureStorageReady();
    const existing = await draftModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID });
    if (!existing) fail("UI_DRAFT_NOT_FOUND", "Draft not found.", 404);
    if (typeof body?.name !== "string" || !body.name.trim() || body.name.length > 120 ||
      !body.targeting || !body.content) fail("UI_DRAFT_INVALID_UPDATE", "Complete name, targeting, and content are required.", 400);
    const targetResult = inspectTargeting(body.targeting);
    const contentResult = inspectLayoutContent(body.content);
    const errors = [...targetResult.errors, ...contentResult.errors];
    if (errors.length) fail("UI_LAYOUT_VALIDATION_FAILED", "Draft contains invalid fields.", 422, errors);
    if (body.change_note !== undefined && body.change_note !== null &&
      (typeof body.change_note !== "string" || body.change_note.length > MAX_CHANGE_NOTE)) {
      fail("UI_DRAFT_INVALID_CHANGE_NOTE", "Change note is too long.", 400);
    }
    const payload = {
      name: body.name.trim(), targeting: normalizeTargeting(body.targeting),
      content: contentResult.content, changeNote: body.change_note ?? null,
    };
    const scope = operationScope("draft-mutation", id);
    const requestHash = checksum({ revision, payload });
    const operation = { scope, key: mutationId, requestHash, mutation: true };
    const prior = await operationResponse(operation);
    if (prior) return prior;
    if (existing.status !== "draft") fail("UI_DRAFT_NOT_EDITABLE", "Draft is not editable.", 409);
    const session = await startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const replay = await operationResponse({ ...operation, session });
        if (replay) { result = replay; return; }
        const updated = await draftModel.findOneAndUpdate(
          { id, layoutKey: CUSTOMER_HOME_LAYOUT_ID, status: "draft", revision },
          { $set: { ...payload, updatedBy: actorId }, $inc: { revision: 1 } },
          { new: true, session },
        );
        if (!updated) {
          const current = await draftModel.findOne({ id }).session(session);
          fail("UI_DRAFT_REVISION_CONFLICT", "This draft was changed by another editor.", 409, {
            expected_revision: revision, current_revision: current?.revision,
            updated_by: current?.updatedBy ? String(current.updatedBy) : null,
            updated_at: iso(current?.updatedAt),
          });
        }
        result = draftData(updated);
        if (mutationId) await insert(operationModel, { scope, key: mutationId, requestHash, response: result }, session);
        await audit("draft_updated", { layoutId: updated.layoutId, draftId: id, actorId, requestId,
          details: { revision: updated.revision }, session });
      });
      return result;
    } catch (error) {
      if (error.code === 11000 && mutationId) {
        const replay = await operationResponse(operation);
        if (replay) return replay;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async function archiveDraft({ id, actorId, requestId }) {
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        const draft = await draftModel.findOneAndUpdate(
          { id, layoutKey: CUSTOMER_HOME_LAYOUT_ID, status: "draft" },
          { $set: { status: "archived", updatedBy: actorId } }, { new: true, session });
        if (!draft) fail("UI_DRAFT_NOT_EDITABLE", "Editable draft not found.", 409);
        await audit("draft_archived", { layoutId: draft.layoutId, draftId: id,
          actorId, requestId, session });
      });
    } finally {
      await session.endSession();
    }
  }

  async function inspectDraft(draft, { session, checkOverlap = true } = {}) {
    const errors = [];
    if (draft.schemaVersion !== UI_LAYOUT_SCHEMA_VERSION) {
      errors.push({ path: "schema_version", code: "UNSUPPORTED_SCHEMA_VERSION", message: "Unsupported schema version." });
    }
    const targetResult = inspectTargeting(draft.targeting);
    const contentResult = inspectLayoutContent(draft.content, { publish: true });
    errors.push(...targetResult.errors, ...contentResult.errors);
    if (errors.length) return { valid: false, errors, warnings: [], content: null };
    const content = contentResult.content;
    errors.push(...await inspectReferences(content, { session }));
    if (checkOverlap) {
      const active = await activeModel.find({ layoutId: draft.layoutId }).session(session ?? null);
      const scope = targetingScopeKey(draft.targeting);
      if (!isGlobalTargeting(draft.targeting) &&
        !active.some((row) => isGlobalTargeting(row.targeting))) {
        errors.push({ path: "targeting", code: "GLOBAL_LAYOUT_REQUIRED",
          message: "Publish a global customer_home layout before targeted layouts." });
      }
      if (active.some((row) => row.scopeKey !== scope && targetingOverlaps(row.targeting, draft.targeting))) {
        errors.push({ path: "targeting", code: "TARGETING_OVERLAP", message: "Target overlaps an active layout at the same priority." });
      }
    }
    return { valid: errors.length === 0, errors, warnings: [], content };
  }

  async function validateDraft({ id, actorId, requestId }) {
    const draft = await draftModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID });
    if (!draft) fail("UI_DRAFT_NOT_FOUND", "Draft not found.", 404);
    const validation = await inspectDraft(draft);
    await audit("draft_validated", { layoutId: draft.layoutId, draftId: id, actorId, requestId,
      details: { revision: draft.revision, valid: validation.valid, errorCodes: validation.errors.map((e) => e.code) } });
    return {
      valid: validation.valid, draft_id: id, revision: draft.revision,
      errors: validation.errors, warnings: validation.warnings, validated_at: iso(now()),
    };
  }

  async function createPreview({ id, revision, expiresInSeconds = 1800, context = {}, actorId, requestId }) {
    await ensureStorageReady();
    const draft = await draftModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID, revision });
    if (!draft) fail("UI_DRAFT_REVISION_CONFLICT", "Draft revision is not current.", 409);
    const validation = await inspectDraft(draft);
    if (!validation.valid) fail("UI_LAYOUT_VALIDATION_FAILED", "Draft cannot be previewed.", 422, validation.errors);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) {
      fail("UI_PREVIEW_INVALID_EXPIRY", "Preview lifetime must be 60 to 3600 seconds.", 400);
    }
    const token = randomToken();
    const previewId = uuid();
    const expiresAt = new Date(now().getTime() + expiresInSeconds * 1000);
    const snapshot = {
      layout_id: draft.layoutId, version_id: null, version_number: null,
      schema_version: draft.schemaVersion, published_at: null,
      ...publicLayoutContent(validation.content),
    };
    snapshot.checksum = checksum(snapshot);
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        await insert(previewModel, {
          id: previewId, draftId: id, revision, tokenHash: checksum(token),
          snapshot, context, createdBy: actorId, expiresAt, revokedAt: null,
        }, session);
        await audit("preview_created", { layoutId: draft.layoutId, draftId: id,
          actorId, requestId, details: { previewId, revision, expiresAt: iso(expiresAt) }, session });
      });
    } finally {
      await session.endSession();
    }
    return { preview_id: previewId, token, expires_at: iso(expiresAt), revision,
      preview_url: `/api/v1/home-layout/preview?token=${encodeURIComponent(token)}` };
  }

  async function getPreview(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) {
      fail("UI_PREVIEW_NOT_FOUND", "Preview not found.", 404);
    }
    const preview = await previewModel.findOne({ tokenHash: checksum(token) });
    if (!preview) fail("UI_PREVIEW_NOT_FOUND", "Preview not found.", 404);
    if (preview.revokedAt || preview.expiresAt <= now()) {
      fail("UI_PREVIEW_EXPIRED", "Preview has expired.", 410);
    }
    return { data: preview.snapshot, meta: {
      preview: true, draft_id: preview.draftId, revision: preview.revision,
      requested_context: preview.context ?? {},
    } };
  }

  async function revokePreview({ id, actorId, requestId }) {
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        const preview = await previewModel.findOneAndUpdate(
          { id, revokedAt: null }, { $set: { revokedAt: now() } },
          { new: true, session });
        if (!preview) fail("UI_PREVIEW_NOT_FOUND", "Preview not found.", 404);
        const draft = await draftModel.findOne({ id: preview.draftId }).session(session);
        await audit("preview_revoked", { layoutId: draft?.layoutId ?? CUSTOMER_HOME_LAYOUT_ID,
          draftId: preview.draftId, actorId, requestId,
          details: { previewId: id }, session });
      });
    } finally {
      await session.endSession();
    }
  }

  async function publishSnapshot({ layout, content, targeting, actorId, changeNote, sourceDraftId = null,
    rollbackOfVersionId = null, idempotencyKey, operationRequestHash, requestId, session }) {
    const scopeKey = targetingScopeKey(targeting);
    const previous = await activeModel.findOne({ layoutId: layout.id, scopeKey }).session(session);
    const allocated = await layoutModel.findOneAndUpdate({ id: layout.id },
      { $inc: { nextVersionNumber: 1, publishedEpoch: 1 } }, { new: false, session });
    if (!allocated) fail("UI_LAYOUT_NOT_FOUND", "Layout not found.", 404);
    const publishedAt = now();
    const versionId = uuid();
    const basePublic = {
      layout_id: layout.id, version_id: versionId, version_number: allocated.nextVersionNumber,
      schema_version: UI_LAYOUT_SCHEMA_VERSION, published_at: iso(publishedAt),
      ...publicLayoutContent(content),
    };
    if (Buffer.byteLength(JSON.stringify({ ...basePublic, checksum: `sha256:${"0".repeat(64)}` }), "utf8") >
      UI_LAYOUT_MAX_BYTES) {
      fail("UI_LAYOUT_PAYLOAD_TOO_LARGE", "Published layout exceeds 256 KiB.", 422,
        [{ path: "content", code: "PAYLOAD_TOO_LARGE", message: "Published response is too large." }]);
    }
    const version = await insert(versionModel, {
      id: versionId, layoutId: layout.id, layoutKey: layout.key,
      versionNumber: allocated.nextVersionNumber, schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
      targeting, content, checksum: checksum(basePublic), sourceDraftId,
      rollbackOfVersionId, changeNote, publishedBy: actorId, publishedAt,
    }, session);
    await activeModel.updateOne({ layoutId: layout.id, scopeKey },
      { $set: { versionId, targeting, priority: targeting.priority } },
      { upsert: true, session });
    const result = {
      version_id: version.id, version_number: version.versionNumber, status: "published",
      published_at: iso(version.publishedAt), checksum: version.checksum,
      superseded_version_id: previous?.versionId ?? null,
    };
    if (idempotencyKey) await insert(operationModel, {
      scope: operationScope(rollbackOfVersionId ? "rollback" : "publish", sourceDraftId ?? rollbackOfVersionId),
      key: idempotencyKey, requestHash: operationRequestHash, response: result,
    }, session);
    await audit(rollbackOfVersionId ? "rollback_published" : "draft_published",
      { layoutId: layout.id, draftId: sourceDraftId, versionId, actorId, requestId,
        details: { previousVersionId: previous?.versionId ?? null, rollbackOfVersionId }, session });
    return result;
  }

  async function publish({ id, revision, changeNote, idempotencyKey, actorId, requestId, scheduled = false }) {
    await ensureStorageReady();
    if (!validChangeNote(changeNote)) fail("UI_PUBLISH_CHANGE_NOTE_REQUIRED", "A change note is required.", 400);
    const scope = operationScope("publish", id);
    const operationRequestHash = checksum({ revision, changeNote, scheduled });
    const operation = { scope, key: idempotencyKey, requestHash: operationRequestHash };
    const prior = await operationResponse(operation);
    if (prior) return prior;
    const session = await startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const replay = await operationResponse({ ...operation, session });
        if (replay) { result = replay; return; }
        const filter = { id, layoutKey: CUSTOMER_HOME_LAYOUT_ID, revision,
          status: scheduled ? "scheduled" : "draft" };
        const draft = await draftModel.findOne(filter).session(session);
        if (!draft) fail("UI_DRAFT_REVISION_CONFLICT", "Draft revision or state changed.", 409);
        const snapshot = scheduled ? draft.scheduledSnapshot : {
          targeting: draft.targeting, content: draft.content,
        };
        if (!snapshot) fail("UI_SCHEDULE_INVALID_STATE", "Scheduled snapshot is missing.", 409);
        const candidate = { ...draft.toObject(), ...snapshot };
        const validation = await inspectDraft(candidate, { session });
        if (!validation.valid) fail("UI_LAYOUT_VALIDATION_FAILED", "Layout cannot be published.", 422, validation.errors);
        const layout = await layoutModel.findOne({ id: draft.layoutId }).session(session);
        result = await publishSnapshot({ layout, content: validation.content,
          targeting: normalizeTargeting(snapshot.targeting), actorId, changeNote,
          sourceDraftId: id, idempotencyKey, operationRequestHash, requestId, session });
        const update = await draftModel.updateOne(filter,
          { $set: { status: "published", updatedBy: actorId, scheduledFor: null,
            scheduledSnapshot: null, scheduleFailure: null } }, { session });
        if (update.matchedCount !== 1) fail("UI_DRAFT_REVISION_CONFLICT", "Draft changed during publish.", 409);
      });
      return result;
    } catch (error) {
      if (error.code === 11000 && idempotencyKey) {
        const replay = await operationResponse(operation);
        if (replay) return replay;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async function schedule({ id, revision, scheduledFor, changeNote, idempotencyKey, actorId, requestId }) {
    await ensureStorageReady();
    if (!validChangeNote(changeNote)) fail("UI_PUBLISH_CHANGE_NOTE_REQUIRED", "A change note is required.", 400);
    const targetTime = parseUtcTimestamp(scheduledFor);
    if (!targetTime) fail("UI_SCHEDULE_INVALID_TIME", "Schedule time must be a valid UTC ISO timestamp.", 400);
    const scope = operationScope("schedule", id);
    const requestHash = checksum({ revision, scheduledFor: iso(targetTime), changeNote });
    const operation = { scope, key: idempotencyKey, requestHash };
    const prior = await operationResponse(operation);
    if (prior) return prior;
    if (targetTime.getTime() < now().getTime() + 120000) {
      fail("UI_SCHEDULE_INVALID_TIME", "Schedule must be at least two minutes in the future.", 400);
    }
    const session = await startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const replay = await operationResponse({ ...operation, session });
        if (replay) { result = replay; return; }
        const draft = await draftModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID,
          revision, status: "draft" }).session(session);
        if (!draft) fail("UI_DRAFT_REVISION_CONFLICT", "Draft revision or state changed.", 409);
        const validation = await inspectDraft(draft, { session });
        if (!validation.valid) fail("UI_LAYOUT_VALIDATION_FAILED", "Layout cannot be scheduled.", 422, validation.errors);
        const snapshot = { targeting: normalizeTargeting(draft.targeting), content: validation.content,
          changeNote };
        const updated = await draftModel.findOneAndUpdate(
          { id, revision, status: "draft" },
          { $set: { status: "scheduled", scheduledFor: targetTime,
            scheduledSnapshot: snapshot, changeNote, updatedBy: actorId, scheduleFailure: null } },
          { new: true, session },
        );
        if (!updated) fail("UI_DRAFT_REVISION_CONFLICT", "Draft changed during scheduling.", 409);
        result = { draft_id: id, status: "scheduled", revision, scheduled_for: iso(targetTime) };
        if (idempotencyKey) await insert(operationModel,
          { scope, key: idempotencyKey, requestHash, response: result }, session);
        await audit("draft_scheduled", { layoutId: draft.layoutId, draftId: id, actorId, requestId,
          details: { revision, scheduledFor: iso(targetTime) }, session });
      });
      return result;
    } catch (error) {
      if (error.code === 11000 && idempotencyKey) {
        const replay = await operationResponse(operation);
        if (replay) return replay;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async function cancelSchedule({ id, actorId, requestId }) {
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        const draft = await draftModel.findOneAndUpdate(
          { id, layoutKey: CUSTOMER_HOME_LAYOUT_ID, status: "scheduled" },
          { $set: { status: "draft", scheduledFor: null, scheduledSnapshot: null,
            scheduleFailure: null, updatedBy: actorId }, $inc: { revision: 1 } },
          { new: true, session });
        if (!draft) fail("UI_SCHEDULE_INVALID_STATE", "Scheduled draft not found.", 409);
        await audit("schedule_cancelled", { layoutId: draft.layoutId, draftId: id,
          actorId, requestId, session });
      });
    } finally {
      await session.endSession();
    }
  }

  async function dueSchedules(limit = 50) {
    return draftModel.find({ layoutKey: CUSTOMER_HOME_LAYOUT_ID, status: "scheduled",
      scheduleFailure: null, scheduledFor: { $lte: now() } }).sort({ scheduledFor: 1 }).limit(limit);
  }

  async function publishScheduledDraft(draft) {
    return publish({ id: draft.id, revision: draft.revision,
      changeNote: draft.scheduledSnapshot.changeNote,
      idempotencyKey: `schedule:${draft.id}:${draft.revision}`,
      actorId: draft.updatedBy, scheduled: true });
  }

  async function history({ limit = 20, before } = {}) {
    const filter = { layoutKey: CUSTOMER_HOME_LAYOUT_ID };
    if (before) filter.versionNumber = { $lt: before };
    const versions = await versionModel.find(filter).sort({ versionNumber: -1 }).limit(limit);
    const active = await activeModel.find({ layoutId: { $in: versions.map((v) => v.layoutId) } });
    const activeIds = new Set(active.map((row) => row.versionId));
    return { items: versions.map((version) => ({
      ...versionData(version), status: activeIds.has(version.id) ? "published" : "superseded",
    })), next_before: versions.length === limit ? versions.at(-1).versionNumber : null };
  }

  async function getVersion(id) {
    const version = await versionModel.findOne({ id, layoutKey: CUSTOMER_HOME_LAYOUT_ID });
    if (!version) fail("UI_VERSION_NOT_FOUND", "Published version not found.", 404);
    return versionData(version);
  }

  async function rollback({ versionId, changeNote, idempotencyKey, actorId, requestId }) {
    await ensureStorageReady();
    if (!validChangeNote(changeNote)) fail("UI_ROLLBACK_CHANGE_NOTE_REQUIRED", "A change note is required.", 400);
    const scope = operationScope("rollback", versionId);
    const operationRequestHash = checksum({ versionId, changeNote });
    const operation = { scope, key: idempotencyKey, requestHash: operationRequestHash };
    const prior = await operationResponse(operation);
    if (prior) return prior;
    const session = await startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const replay = await operationResponse({ ...operation, session });
        if (replay) { result = replay; return; }
        const old = await versionModel.findOne({ id: versionId, layoutKey: CUSTOMER_HOME_LAYOUT_ID }).session(session);
        if (!old) fail("UI_VERSION_NOT_FOUND", "Published version not found.", 404);
        const validation = await inspectDraft(old, { session });
        if (!validation.valid) fail("UI_LAYOUT_VALIDATION_FAILED", "Historical version is no longer publishable.", 422, validation.errors);
        const layout = await layoutModel.findOne({ id: old.layoutId }).session(session);
        result = await publishSnapshot({ layout, content: validation.content,
          targeting: normalizeTargeting(old.targeting), actorId, changeNote,
          rollbackOfVersionId: versionId, idempotencyKey, operationRequestHash, requestId, session });
      });
      return result;
    } catch (error) {
      if (error.code === 11000 && idempotencyKey) {
        const replay = await operationResponse(operation);
        if (replay) return replay;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async function getPublic(request = {}) {
    const layout = await layoutModel.findOne({ key: CUSTOMER_HOME_LAYOUT_ID });
    if (!layout) fail("UI_LAYOUT_NOT_PUBLISHED", "No published layout is available.", 404);
    const targetKey = checksum({
      platform: request.platform ?? null, appVersion: request.appVersion ?? null,
      locale: request.locale ?? null, countryCode: request.countryCode ?? null,
      locationId: request.locationId ?? null, audience: request.audience ?? "guest",
    });
    return getOrSet(`ui-layout:${layout.id}:epoch:${layout.publishedEpoch ?? 0}:${targetKey}`,
      300, async () => {
        const active = await activeModel.find({ layoutId: layout.id });
        const selected = chooseActiveVersion(active, request);
        if (!selected) fail("UI_LAYOUT_NOT_PUBLISHED", "No compatible published layout is available.", 404);
        const version = await versionModel.findOne({ id: selected.versionId });
        if (!version) fail("UI_LAYOUT_PUBLICATION_MISSING", "Published layout is unavailable.", 503);
        return publicData(version);
      });
  }

  async function listAudit({ limit = 50, before } = {}) {
    const layout = await layoutModel.findOne({ key: CUSTOMER_HOME_LAYOUT_ID });
    if (!layout) return { items: [], next_before: null };
    const filter = { layoutId: layout.id };
    if (before) filter.$or = beforePageFilter("createdAt", before);
    const rows = await auditModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map((row) => ({
      action: row.action, draft_id: row.draftId, version_id: row.versionId,
      actor_id: row.actorId ? String(row.actorId) : null, request_id: row.requestId,
      details: row.details, created_at: iso(row.createdAt),
    })), next_before: rows.length > limit ? encodePageCursor(page.at(-1), "createdAt") : null };
  }

  return {
    createDraft, listDrafts, getDraft, saveDraft, archiveDraft, validateDraft,
    createPreview, getPreview, revokePreview, publish, schedule, cancelSchedule,
    dueSchedules, publishScheduledDraft, history, getVersion, rollback, getPublic, listAudit,
  };
}

export const uiLayoutService = createUiLayoutService();
