import assert from "node:assert/strict";
import test from "node:test";
import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createReelLifecycle } from "../../../../src/domains/videos/reels/reelLifecycle.service.js";
import { createReelPreviewService } from "../../../../src/domains/videos/reels/reelPreview.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadRecovery } from "../../../../src/domains/videos/reels/reelUploadRecovery.service.js";
import { createEditorialCoverReferencePersistence } from "../../../../src/domains/videos/editorial/editorialCover.repository.js";
import express from "express";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const id = "507f1f77bcf86cd799439011";
const oldId = "507f1f77bcf86cd799439012";
const newId = "507f1f77bcf86cd799439013";
const sessionId = "507f1f77bcf86cd799439014";
const admin = { id: "507f1f77bcf86cd799439015", role: "admin" };
const superAdmin = { id: "507f1f77bcf86cd799439016", role: "superAdmin" };
const time = new Date("2026-10-01T00:00:00Z");
const path = (row, key) => key.split(".").reduce((value, field) => value?.[field], row);

function matches(row, filter) {
  return row && Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(row, branch));
    const actual = path(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$lte" in expected) return (!(expected.$lte instanceof Date) || actual instanceof Date) && actual <= expected.$lte;
      if ("$gt" in expected) return actual instanceof Date && actual > expected.$gt;
    }
    return String(actual) === String(expected);
  });
}

function update(row, changes) {
  for (const [key, value] of Object.entries(changes.$set ?? {})) {
    const fields = key.split(".");
    const target = fields.slice(0, -1).reduce((object, field) => object[field], row);
    target[fields.at(-1)] = value;
  }
  for (const [key, value] of Object.entries(changes.$inc ?? {})) row[key] += value;
  for (const key of Object.keys(changes.$unset ?? {})) {
    const fields = key.split(".");
    const target = fields.slice(0, -1).reduce((object, field) => object?.[field], row);
    if (target) delete target[fields.at(-1)];
  }
  return structuredClone(row);
}
function query(read) {
  return { async session() { return read(); }, async lean() { return read(); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } };
}

function fixture({ automatic = false, status = "published" } = {}) {
  const owner = automatic ? superAdmin : admin;
  const ready = { ownerType: "reel", ownerId: id, libraryId: "754739", technicalState: "ready",
    providerStatus: 4, readyAt: time, durationSeconds: 2, width: 640, height: 360, availableResolutions: ["360p"] };
  let state = { video: { _id: id, kind: "reel", status, revision: 0, authorId: admin.id,
    title_en: "Original", title_ar: "أصلي", description_en: "", description_ar: "",
    activeAssetId: oldId, activeUploadSessionId: "old-session", publishedAt: time, position: 3,
    pendingChange: { authorId: owner.id, status: "draft", autoApplyWhenReady: automatic,
      assetId: newId, uploadSessionId: sessionId,
      content: { kind: "reel", title_en: "Proposed", title_ar: "جديد", description_en: "Change", description_ar: "" } } },
    assets: [{ ...ready, _id: oldId, providerGuid: "old-guid" }, { ...ready, _id: newId, providerGuid: "new-guid" }],
    row: { _id: sessionId, videoId: id, assetId: newId, previousAssetId: oldId, purpose: "replacement",
      actorId: owner.id, status: "issued", autoApplyWhenReady: automatic, safeFilename: "video.mp4" },
    covers: [], operations: [], attempts: [] };
  let inTransaction = false;
  const controls = { preview: true, duringProbe: null, failOperation: false,
    failAssetWrite: false, failSessionWrite: false, referenced: false, queues: 0, probes: 0,
    nowMs: time.getTime(), afterList: null, failCoverOperation: false };
  const connection = { async startSession() { return {
    async withTransaction(work) {
      const snapshot = structuredClone(state);
      inTransaction = true;
      try { await work(); } catch (error) { state = snapshot; throw error; }
      finally { inTransaction = false; }
    }, async endSession() {},
  }; } };
  const videos = {
    create() {}, findById(videoId) { return query(() => videoId === id ? structuredClone(state.video) : null); },
    findOne(filter) { return query(() => filter.$or?.some((branch) => branch.activeAssetId) && controls.referenced
      ? { _id: "unexpected-reference" } : matches(state.video, filter) ? structuredClone(state.video) : null); },
    findOneAndUpdate(filter, changes) { return query(() => matches(state.video, filter)
      ? update(state.video, changes) : null); },
    async updateOne(filter, changes) { return { modifiedCount: matches(state.video, filter)
      ? (update(state.video, changes), 1) : 0 }; },
    find(filter) { let maximum = 100;
      return { sort() { return this; }, limit(value) { maximum = value; return this; },
        async lean() { const result = maximum && matches(state.video, filter) ? [structuredClone(state.video)] : [];
          controls.afterList?.(); return result; } }; },
  };
  const sessions = { findOne(filter) { return query(() => matches(state.row, filter) ? structuredClone(state.row) : null); },
    async updateOne(filter, changes) { return { modifiedCount: !controls.failSessionWrite && matches(state.row, filter)
      ? (update(state.row, changes), 1) : 0 }; } };
  const assets = { findOne(filter) { return query(() => structuredClone(state.assets.find((row) => matches(row, filter)) ?? null)); },
    async updateOne(filter, changes) { const row = state.assets.find((entry) => matches(entry, filter));
      return { modifiedCount: row && !controls.failAssetWrite ? (update(row, changes), 1) : 0 }; } };
  const covers = { async updateOne(filter, changes) {
    assert.equal(inTransaction, true);
    const row = state.covers.find((entry) => matches(entry, filter));
    return { modifiedCount: row ? (update(row, changes), 1) : 0 };
  } };
  const persistence = { videos, sessions, assets, libraryId: "754739", connection,
    attempts: { async create(rows) { assert.equal(inTransaction, true); state.attempts.push(...rows); } },
    async recordOperation(spec) { assert.equal(inTransaction, true);
      if (controls.failOperation) throw new Error("operation unavailable");
      if (controls.failCoverOperation && spec.type === "cover_cleanup") throw new Error("cover operation unavailable");
      state.operations.push(spec); return { _id: `operation-${state.operations.length}` }; },
    async enqueue() { assert.equal(inTransaction, false); controls.queues += 1; throw new Error("Redis down"); },
  };
  persistence.coverReferences = createEditorialCoverReferencePersistence({ covers, videos,
    recordOperation: persistence.recordOperation });
  const repository = createReelLifecycleRepository(persistence);
  const uploads = createReelUploadRepository({ ...persistence, now: () => controls.nowMs });
  const recovery = createReelUploadRecovery({ enqueue: persistence.enqueue, repository: uploads, now: () => controls.nowMs });
  const preview = createReelPreviewService({ repository, now: () => time.getTime(), provider: {
    async probeSignedHls({ videoId }) { assert.equal(videoId, "new-guid"); controls.probes += 1;
      controls.duringProbe?.(); return controls.preview ? { href: "https://signed.example/hls", expiresAt: 1790813700 } : null; },
  } });
  const application = createEditorialVideoService({ enqueue: persistence.enqueue, repository: createEditorialVideoRepository({ videos,
    reelLifecycle: repository, reelUploads: uploads }),
    verifyYouTube: async () => { throw new Error("wrong provider"); },
    verifyReelReady: async () => { throw new Error("must verify the replacement, not the old video"); },
    verifyReelReplacementReady: (video) => preview.verifyReady(video, "pending"), now: () => new Date(controls.nowMs) });
  const lifecycle = createReelLifecycle({ enqueue: persistence.enqueue, repository, now: () => time,
    verifyPreviewReady: async () => { controls.probes += 1; controls.duringProbe?.(); return controls.preview; } });
  return { application, repository, lifecycle, recovery, uploads, controls, state: () => state };
}

function attachCovers(f) {
  const current = "507f1f77bcf86cd799439021";
  const proposed = "507f1f77bcf86cd799439022";
  f.state().covers.push(...[current, proposed].map((_id) => ({ _id, videoId: id, actorId: admin.id,
    state: "attached", uploadSettledAt: time, referenceRevision: 0,
    descriptor: { url: `https://images.example/${_id}.webp` } })));
  f.state().video.activeCoverId = current;
  f.state().video.pendingChange.content.coverId = proposed;
  return { current, proposed };
}

test("status-0 Reel replacement abandonment keeps published media and editable proposal metadata", async () => {
  for (const automatic of [false, true]) {
    const f = fixture({ automatic });
    const state = f.state();
    const pending = state.assets[1];
    Object.assign(pending, { technicalState: "awaiting_upload", providerStatus: 0 });
    state.row.abandonAt = new Date(f.controls.nowMs + 1);
    assert.deepEqual(await f.recovery.handleVerifiedAsset(pending), { status: "stale" });
    f.controls.nowMs += 1;
    assert.deepEqual(await f.recovery.handleVerifiedAsset(pending), { status: "abandoned" });
    assert.equal(f.state().video.activeAssetId, oldId);
    assert.equal(f.state().video.status, "published");
    assert.equal(f.state().video.pendingChange.content.title_en, "Proposed");
    assert.equal(f.state().video.pendingChange.assetId, undefined);
    assert.equal(f.state().row.failureCode, "VIDEO_UPLOAD_ABANDONED");
    assert.equal(f.state().operations[0].providerGuid, "new-guid");
    assert.equal(f.state().operations.length, 1);
    assert.equal(f.state().assets[0].technicalState, "ready");
  }
});

test("failed durable cleanup storage rolls back status-0 Reel replacement abandonment", async () => {
  const f = fixture();
  Object.assign(f.state().assets[1], { technicalState: "awaiting_upload", providerStatus: 0 });
  f.state().row.abandonAt = new Date(f.controls.nowMs);
  f.controls.failOperation = true;
  await assert.rejects(f.recovery.handleVerifiedAsset(f.state().assets[1]), /operation unavailable/);
  assert.equal(f.state().video.pendingChange.assetId, newId);
  assert.equal(f.state().row.status, "issued");
  assert.equal(f.state().assets[1].technicalState, "awaiting_upload");
  assert.equal(f.state().operations.length, 0);
  f.controls.failOperation = false;
  assert.deepEqual(await f.recovery.handleVerifiedAsset(f.state().assets[1]), { status: "abandoned" });
});

test("replacement approval switches metadata, media and cover in one transaction", async () => {
  const f = fixture(); const { current, proposed } = attachCovers(f);
  await f.application.submit({ id, actor: admin });
  assert.equal(f.state().video.activeCoverId, current);
  const applied = await f.application.approve({ id, actor: superAdmin });
  assert.equal(applied.activeCoverId, proposed);
  assert.equal(applied.activeAssetId, newId);
  assert.equal(applied.title_en, "Proposed");
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().covers[1].state, "attached");
  assert.equal(f.state().operations.find((op) => op.type === "cover_cleanup").coverId, current);
  assert.equal(f.state().operations.length, 2);
  assert.equal(f.controls.queues, 2);
});

test("cover cleanup persistence failure rolls back the whole Reel replacement", async () => {
  const f = fixture(); const { current } = attachCovers(f);
  await f.application.submit({ id, actor: admin }); f.controls.failCoverOperation = true;
  await assert.rejects(f.application.approve({ id, actor: superAdmin }), /cover operation unavailable/);
  assert.equal(f.state().video.activeCoverId, current);
  assert.equal(f.state().video.activeAssetId, oldId);
  assert.equal(f.state().video.title_en, "Original");
  assert.equal(f.state().video.pendingChange.status, "in_review");
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().covers[1].referenceRevision, 0);
  assert.equal(f.state().operations.length, 0);
  assert.equal(f.state().row.appliedAt, undefined);
});

test("whole replacement cancellation cleans proposed cover and Stream asset but preserves the public version", async () => {
  const f = fixture(); const { current, proposed } = attachCovers(f);
  await f.application.cancelPendingChange({ id, actor: admin });
  assert.equal(f.state().video.activeCoverId, current);
  assert.equal(f.state().video.activeAssetId, oldId);
  assert.equal(f.state().video.pendingChange, null);
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().covers[1].state, "deleting");
  assert.equal(f.state().operations.find((op) => op.type === "cover_cleanup").coverId, proposed);
  assert.equal(f.state().operations.length, 2);
});

test("automatic replacement promotes the current synchronized cover without retiring that cover", async () => {
  const f = fixture({ automatic: true }); const { current } = attachCovers(f);
  f.state().video.pendingChange.content.coverId = current;
  f.state().covers.pop();
  await f.lifecycle.handleVerifiedAsset(f.state().assets[1]);
  assert.equal(f.state().video.activeCoverId, current);
  assert.equal(f.state().video.activeAssetId, newId);
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().operations.length, 1);
});

test("admin replacement stays isolated until approval atomically switches metadata and session, with durable old-asset cleanup", async () => {
  const f = fixture();
  await f.application.editVideo({ id, actor: admin, input: { description_en: "Revised" } });
  await f.application.submit({ id, actor: admin });
  assert.equal(f.state().video.activeAssetId, oldId);
  assert.equal(f.state().video.title_en, "Original");
  assert.equal(f.state().operations.length, 0);
  await assert.rejects(f.application.approve({ id, actor: admin }), (error) => error.statusCode === 403);
  const applied = await f.application.approve({ id, actor: superAdmin });
  assert.equal(applied.activeAssetId, newId); assert.equal(applied.activeUploadSessionId, sessionId);
  assert.equal(applied.title_en, "Proposed"); assert.equal(applied.description_en, "Revised");
  assert.equal(applied.status, "published"); assert.equal(applied.position, 3);
  assert.equal(applied.pendingChange, null);
  assert.equal(f.state().row.status, "issued"); assert.deepEqual(f.state().row.appliedAt, time);
  assert.equal(f.state().assets[0].technicalState, "deleting");
  assert.equal(f.state().assets[1].technicalState, "ready");
  assert.equal(f.state().operations[0].providerGuid, "old-guid");
  assert.equal(f.state().operations[0].type, "delete");
  assert.equal(f.controls.queues, 1); assert.equal(f.state().attempts.length, 1);
  assert.ok(await f.repository.findCurrentForVideoId(id));
  await assert.rejects(f.application.approve({ id, actor: superAdmin }), (error) => error.statusCode === 409);
  assert.equal(f.state().operations.length, 1);
});

test("reviewed and automatic replacement cutovers preserve a newer super-admin position", async () => {
  for (const automatic of [false, true]) {
    const f = fixture({ automatic });
    if (!automatic) await f.application.submit({ id, actor: admin });
    const pending = structuredClone(f.state().video.pendingChange);
    await f.application.setPublicPosition({ id, actor: superAdmin, input: { position: 9 } });
    assert.deepEqual(f.state().video.pendingChange, pending);
    assert.equal(f.state().video.activeAssetId, oldId);
    if (automatic) await f.lifecycle.handleVerifiedAsset(f.state().assets[1]);
    else await f.application.approve({ id, actor: superAdmin });
    assert.equal(f.state().video.position, 9);
    assert.equal(f.state().video.activeAssetId, newId);
    assert.equal(f.state().video.pendingChange, null);
  }
});

test("a position update during replacement verification makes stale cutovers fail without losing the position", async () => {
  for (const automatic of [false, true]) {
    const f = fixture({ automatic });
    if (!automatic) await f.application.submit({ id, actor: admin });
    f.controls.duringProbe = () => { f.state().video.position = 9; f.state().video.revision++; };
    if (automatic) assert.deepEqual(await f.lifecycle.handleVerifiedAsset(f.state().assets[1]), { status: "stale" });
    else await assert.rejects(f.application.approve({ id, actor: superAdmin }), (error) => error.statusCode === 409);
    assert.equal(f.state().video.position, 9);
    assert.equal(f.state().video.activeAssetId, oldId);
    assert.equal(f.state().operations.length, 0);
    assert.ok(f.state().video.pendingChange);
  }
});

test("replacement approval preserves approved/unpublished status and rejects concurrent unpublish during preview", async () => {
  for (const status of ["approved", "unpublished"]) {
    const f = fixture({ status }); await f.application.submit({ id, actor: admin });
    assert.equal((await f.application.approve({ id, actor: superAdmin })).status, status);
  }
  const f = fixture(); await f.application.submit({ id, actor: admin });
  await f.application.unpublish({ id, actor: superAdmin });
  assert.equal((await f.application.approve({ id, actor: superAdmin })).status, "unpublished");
  const race = fixture(); await race.application.submit({ id, actor: admin });
  race.controls.duringProbe = () => { race.state().video.status = "unpublished"; race.state().video.revision += 1; };
  await assert.rejects(race.application.approve({ id, actor: superAdmin }), (error) => error.statusCode === 409);
  assert.equal(race.state().video.activeAssetId, oldId); assert.equal(race.state().operations.length, 0);
});

test("replacement review rejects wrong author, unready media, wrong session and incomplete attachment", async () => {
  const f = fixture();
  await assert.rejects(f.application.submit({ id, actor: { ...admin, id: superAdmin.id } }), (error) => error.statusCode === 403);
  f.controls.preview = false;
  await assert.rejects(f.application.submit({ id, actor: admin }), (error) => error.errors[0].code === "VIDEO_ASSET_NOT_READY");
  f.controls.preview = true;
  f.state().row.previousAssetId = newId;
  await assert.rejects(f.application.submit({ id, actor: admin }), (error) => error.statusCode === 409);
  f.state().row.previousAssetId = oldId; delete f.state().video.pendingChange.assetId;
  await assert.rejects(f.application.submit({ id, actor: admin }), (error) => error.statusCode === 409);
  assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.controls.queues, 0);
});

test("replacement rejection and resubmission retain the proposal and its media without switching the public version", async () => {
  const f = fixture(); await f.application.submit({ id, actor: admin });
  await f.application.reject({ id, actor: superAdmin, reason: "Revise it" });
  assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.state().video.pendingChange.assetId, newId);
  await f.application.editVideo({ id, actor: admin, input: { title_en: "Revised" } });
  await f.application.submit({ id, actor: admin });
  assert.equal((await f.application.approve({ id, actor: superAdmin })).title_en, "Revised");
});

test("cutover rolls back every local mutation on failed cleanup persistence, session/asset CAS or referenced old asset", async () => {
  for (const fault of ["failOperation", "failAssetWrite", "failSessionWrite", "referenced"]) {
    const f = fixture(); await f.application.submit({ id, actor: admin });
    f.controls[fault] = true;
    await assert.rejects(f.application.approve({ id, actor: superAdmin }));
    assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.state().video.title_en, "Original");
    assert.equal(f.state().video.pendingChange.status, "in_review");
    assert.equal(f.state().assets[0].technicalState, "ready");
    assert.equal(f.state().row.appliedAt, undefined); assert.equal(f.state().operations.length, 0);
    assert.equal(f.controls.queues, 0);
  }
});

test("super-admin replacement is preview-gated and swept after a transient preview failure without republishing", async () => {
  const f = fixture({ automatic: true, status: "unpublished" });
  f.controls.preview = false;
  assert.deepEqual(await f.lifecycle.handleVerifiedAsset(f.state().assets[1]), { status: "preview_pending" });
  assert.equal(f.state().video.activeAssetId, oldId);
  f.controls.preview = true; delete f.state().video.pendingChange.nextPreviewProbeAt;
  assert.deepEqual(await f.lifecycle.recoverPreviewPending({ limit: 2 }),
    { examined: 1, attempted: 1, published: 0, applied: 1 });
  assert.equal(f.state().video.activeAssetId, newId); assert.equal(f.state().video.status, "unpublished");
  assert.equal(f.state().operations.length, 1);
  await f.lifecycle.handleVerifiedAsset(f.state().assets[1]);
  assert.equal(f.state().operations.length, 1);
});

test("automatic authority requires both immutable session authority and the current proposal; cancellation during preview prevents cutover", async () => {
  for (const automatic of [false, true]) {
    const f = fixture({ automatic }); if (automatic) f.state().row.autoApplyWhenReady = false;
    assert.deepEqual(await f.lifecycle.handleVerifiedAsset(f.state().assets[1]), { status: "awaiting_review" });
    assert.equal(f.controls.probes, 0); assert.equal(f.state().operations.length, 0);
  }
  const f = fixture({ automatic: true });
  f.controls.duringProbe = () => { f.state().video.pendingChange = null; f.state().video.revision += 1; };
  assert.deepEqual(await f.lifecycle.handleVerifiedAsset(f.state().assets[1]), { status: "stale" });
  assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.state().operations.length, 0);
});

test("automatic replacement metadata edits take effect directly only for its super-admin author and stay synchronized", async () => {
  const f = fixture({ automatic: true });
  await assert.rejects(f.application.editVideo({ id, actor: admin, input: { title_en: "Bypass" } }), (error) => error.statusCode === 403);
  await assert.rejects(f.application.editVideo({ id, actor: { ...superAdmin, id: admin.id }, input: { title_en: "Competing" } }),
    (error) => error.statusCode === 409);
  const edited = await f.application.editVideo({ id, actor: superAdmin, input: { title_en: "Super edit" } });
  assert.equal(edited.title_en, "Super edit"); assert.equal(edited.pendingChange.content.title_en, "Super edit");
  await f.lifecycle.handleVerifiedAsset(f.state().assets[1]);
  assert.equal(f.state().video.title_en, "Super edit"); assert.equal(f.state().video.activeAssetId, newId);
});

const DAY = 24 * 60 * 60_000;
async function rejectReplacement(f) {
  await f.application.submit({ id, actor: admin });
  await f.application.reject({ id, actor: superAdmin, reason: "Revise it" });
}

test("rejection records exactly seven days; draft editing preserves the deadline and expiry retains metadata", async () => {
  const f = fixture(); const { current, proposed } = attachCovers(f); await rejectReplacement(f);
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt.getTime(), time.getTime() + 7 * DAY);
  f.controls.nowMs += 6 * DAY;
  await f.application.editVideo({ id, actor: admin, input: { title_en: "Revised" } });
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt.getTime(), time.getTime() + 7 * DAY);
  f.controls.nowMs = time.getTime() + 7 * DAY - 1;
  assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 0, recovered: 0, failed: 0 });
  f.controls.nowMs += 1;
  assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 1, recovered: 1, failed: 0 });
  assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.state().video.title_en, "Original");
  assert.equal(f.state().video.pendingChange.content.title_en, "Revised");
  assert.equal(f.state().video.activeCoverId, current);
  assert.equal(f.state().video.pendingChange.content.coverId, proposed);
  assert.equal(f.state().covers[1].state, "attached");
  assert.equal(f.state().video.pendingChange.status, "draft");
  assert.equal(f.state().video.pendingChange.assetId, undefined);
  assert.equal(f.state().video.pendingChange.uploadSessionId, undefined);
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt, undefined);
  assert.equal(f.state().row.failureCode, "VIDEO_REJECTED_ASSET_EXPIRED");
  assert.equal(f.state().operations[0].providerGuid, "new-guid");
  assert.equal(f.state().assets[0].technicalState, "ready");
  assert.equal(f.controls.queues, 1);
  assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 0, recovered: 0, failed: 0 });
});

test("resubmission stops rejected-state cleanup; another rejection starts a fresh seven-day window", async () => {
  const f = fixture(); await rejectReplacement(f);
  f.controls.nowMs += 6 * DAY;
  f.controls.preview = false;
  await assert.rejects(f.application.submit({ id, actor: admin }), (error) => error.statusCode === 409);
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt.getTime(), time.getTime() + 7 * DAY);
  f.controls.preview = true;
  await f.application.submit({ id, actor: admin });
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt, null);
  f.controls.nowMs += 2 * DAY;
  assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 0, recovered: 0, failed: 0 });
  assert.equal(f.state().assets[1].technicalState, "ready");
  await f.application.reject({ id, actor: superAdmin, reason: "Revise again" });
  assert.equal(f.state().video.pendingChange.rejectedAssetExpiresAt.getTime(), time.getTime() + 15 * DAY);
  assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 0, recovered: 0, failed: 0 });
  f.controls.nowMs += 7 * DAY;
  assert.equal((await f.recovery.recoverRejectedChanges()).recovered, 1);
});

test("whole-proposal cancellation cleans ready or incomplete uploads for the author/super admin without touching active media", async () => {
  for (const proposalState of ["draft", "in_review", "rejected", "reserving"]) {
    const f = fixture(); f.state().video.pendingChange.status = proposalState === "reserving" ? "draft" : proposalState;
    if (proposalState === "reserving") {
      f.state().row.status = "reserving"; delete f.state().row.assetId; delete f.state().video.pendingChange.assetId;
    }
    const result = await f.application.cancelPendingChange({ id, actor: proposalState === "in_review" ? superAdmin : admin });
    assert.equal(result.pendingChange, null); assert.equal(result.status, "published");
    assert.equal(result.activeAssetId, oldId); assert.equal(result.activeUploadSessionId, "old-session");
    assert.equal(f.state().row.status, "failed"); assert.equal(f.state().row.failureCode, "VIDEO_UPLOAD_CANCELLED");
    assert.equal(f.state().assets[0].technicalState, "ready");
    assert.equal(f.state().operations.length, proposalState === "reserving" ? 0 : 1);
    if (f.state().operations.length) assert.equal(f.state().operations[0].providerGuid, "new-guid");
    await assert.rejects(f.application.cancelPendingChange({ id, actor: admin }), (error) => error.statusCode === 409);
    assert.equal(f.state().operations.length, proposalState === "reserving" ? 0 : 1);
  }
});

test("whole-proposal cancellation checks authority before cleanup and rejects wrong library/session/generation or references", async () => {
  const f = fixture();
  for (const actor of [null, { role: "superAdmin" }, { ...admin, id: "507f1f77bcf86cd799439019" }, { ...admin, role: "user" }]) {
    await assert.rejects(f.application.cancelPendingChange({ id, actor }), (error) => error.statusCode === 403);
  }
  assert.equal(f.state().operations.length, 0);
  for (const fault of ["library", "session", "generation", "reference"]) {
    const wrong = fixture();
    if (fault === "library") wrong.state().assets[1].libraryId = "999";
    if (fault === "session") wrong.state().row.actorId = superAdmin.id;
    if (fault === "generation") wrong.state().video.activeAssetId = "changed-generation";
    if (fault === "reference") wrong.controls.referenced = true;
    await assert.rejects(wrong.application.cancelPendingChange({ id, actor: admin }), (error) => error.statusCode === 409);
    assert.ok(wrong.state().video.pendingChange); assert.equal(wrong.state().row.status, "issued");
    assert.equal(wrong.state().assets[1].technicalState, "ready"); assert.equal(wrong.controls.queues, 0);
  }
});

test("expiry skips concurrently edited/resubmitted/applied generations and never cleans metadata-only or unresolved legacy dates", async () => {
  for (const change of ["revision", "resubmitted", "applied", "new-session"]) {
    const f = fixture(); await rejectReplacement(f); f.controls.nowMs += 7 * DAY;
    f.controls.afterList = () => {
      if (change === "revision") f.state().video.revision += 1;
      if (change === "resubmitted") { f.state().video.pendingChange.status = "in_review"; f.state().video.pendingChange.rejectedAssetExpiresAt = null; }
      if (change === "applied") { f.state().video.activeAssetId = newId; f.state().video.pendingChange = null; }
      if (change === "new-session") f.state().video.pendingChange.uploadSessionId = "newer-session";
    };
    assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 1, recovered: 0, failed: 0 });
    assert.equal(f.state().operations.length, 0); assert.equal(f.state().assets[1].technicalState, "ready");
  }
  const legacy = fixture(); legacy.state().video.pendingChange.status = "rejected";
  assert.equal((await legacy.recovery.recoverRejectedChanges()).examined, 0);
  legacy.state().video.pendingChange.reviewedAt = new Date(time.getTime() - 7 * DAY);
  await legacy.application.editVideo({ id, actor: admin, input: { title_en: "Legacy revision" } });
  assert.equal(legacy.state().video.pendingChange.status, "draft");
  assert.equal((await legacy.recovery.recoverRejectedChanges()).recovered, 1);
  assert.equal(legacy.state().video.pendingChange.content.title_en, "Legacy revision");
  const metadata = fixture(); await rejectReplacement(metadata); delete metadata.state().video.pendingChange.assetId;
  metadata.controls.nowMs += 7 * DAY;
  assert.equal((await metadata.recovery.recoverRejectedChanges()).examined, 0);
});

test("expiry/cancellation rolls back on failed cleanup persistence or asset/session writes; the next sweep recovers", async () => {
  for (const fault of ["failOperation", "failAssetWrite", "failSessionWrite"]) {
    for (const cancel of [false, true]) {
      const f = fixture(); await rejectReplacement(f); f.controls.nowMs += 7 * DAY; f.controls[fault] = true;
      if (cancel) await assert.rejects(f.application.cancelPendingChange({ id, actor: admin }));
      else assert.deepEqual(await f.recovery.recoverRejectedChanges(), { examined: 1, recovered: 0, failed: 1 });
      assert.equal(f.state().video.activeAssetId, oldId); assert.equal(f.state().video.pendingChange.assetId, newId);
      assert.equal(f.state().video.pendingChange.status, "rejected"); assert.equal(f.state().row.status, "issued");
      assert.equal(f.state().assets[1].technicalState, "ready"); assert.equal(f.state().operations.length, 0);
      assert.equal(f.controls.queues, 0);
      f.controls[fault] = false;
      assert.equal((await f.recovery.recoverRejectedChanges()).recovered, 1);
    }
  }
});

test("rejected cleanup accepts bounded sweep input and whole cancellation preserves compare-and-swap conflicts", async () => {
  const f = fixture();
  for (const limit of [0, 101, 1.5, "1"]) await assert.rejects(f.recovery.recoverRejectedChanges({ limit }), RangeError);
  await assert.rejects(f.uploads.recoverRejectedChanges({ before: new Date("invalid"), limit: 1 }), TypeError);
  const result = await f.uploads.cancelPendingChange({ videoId: id, expectedRevision: 999, sessionId, assetId: newId, actor: admin });
  assert.equal(result, null); assert.equal(f.state().operations.length, 0);
});

test("whole pending-change cancellation HTTP route performs durable cleanup while upload gates are closed", async () => {
  const f = fixture(); let actor = admin;
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: actor.id, role: actor.role }; next(); }],
    getService: async () => f.application,
    isReelUploadEnabled: () => false, isReelPipelineReady: () => false,
  })); app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/${id}/pending-change`;
    actor = { ...admin, id: "507f1f77bcf86cd799439019" };
    assert.equal((await fetch(url, { method: "DELETE" })).status, 403);
    assert.equal(f.state().operations.length, 0);
    actor = admin;
    const response = await fetch(url, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json()).data.pendingChange, null);
    assert.equal(f.state().operations[0].providerGuid, "new-guid");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
