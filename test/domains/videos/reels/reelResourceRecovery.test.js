import assert from "node:assert/strict";
import test from "node:test";
import { createReelUploadService } from "../../../../src/domains/videos/reels/reelUpload.service.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById,
  completeVideoProviderOperation, failVideoProviderOperation }
  from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { roles } from "../../../../src/shared/constants/enums.js";
import { createReelUploadRecovery } from "../../../../src/domains/videos/reels/reelUploadRecovery.service.js";
import express from "express";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { enabledControls } from "../../../../src/shared/constants/enums.js";
import { createReelOrphanDiscovery } from "../../../../src/domains/videos/reels/reelOrphanDiscovery.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialCoverReferencePersistence } from "../../../../src/domains/videos/editorial/editorialCover.repository.js";

const videoId = "507f191e810c19729de860ea";
const actor = { id: "507f1f77bcf86cd799439012", role: roles.ADMIN };
const file = { filename: "video.mp4", mimeType: "video/mp4", sizeBytes: 100 };
const start = Date.parse("2026-10-08T00:00:00Z");

async function fixture({ purpose = "initial", automatic = false } = {}) {
  const initiator = automatic ? { ...actor, role: roles.SUPER_ADMIN } : actor;
  const control = { now: start, creations: [], deleted: new Set(), jobs: [], status: 0,
    tusState: "not_found", beforeCreate: null, afterTus: null, duringInspect: null };
  const db = replacementDatabase({ placements: [{ _id: videoId, kind: "reel", status: "draft",
    authorId: actor.id, revision: 0, title_en: "Original", position: 4 }] }, { now: () => control.now });
  const startSession = db.connection.startSession.bind(db.connection);
  db.connection.startSession = async () => {
    const session = await startSession();
    const transaction = session.withTransaction.bind(session);
    session.withTransaction = async work => {
      await transaction(work);
      if (control.loseCommitResponse) {
        control.loseCommitResponse = false;
        throw new Error("commit response lost");
      }
    };
    return session;
  };
  const recordOperation = input => recordVideoProviderOperation({ ...input, model: db.operations,
    now: new Date(control.now) });
  const operationWrite = db.operations.findOneAndUpdate.bind(db.operations);
  db.operations.findOneAndUpdate = (...args) => {
    if (control.failOperation && args[1].$setOnInsert) throw new Error("operation storage unavailable");
    return operationWrite(...args);
  };
  const repository = createReelUploadRepository({ libraryId: "754739", connection: db.connection,
    videos: db.placements, assets: db.assets, sessions: db.sessions, recoveries: db.recoveries,
    attempts: db.attempts, operations: db.operations, recordOperation, now: () => control.now });
  const provider = {
    async createVideo(input) {
      control.creations.push(input);
      await control.beforeCreate?.();
      if (control.createError) throw new Error("unknown create response");
      return { guid: control.createdGuid ?? `guid-${control.creations.length}` };
    },
    async createTusUpload(input) {
      await control.afterTus?.();
      if (control.tusError) throw new Error("unknown TUS response");
      return { uploadUrl: `https://video.bunnycdn.com/tusupload/${input.videoId}`,
        resourceExpiresAt: input.expiresAt };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
    async getVideo(guid) {
      if (control.managementError) throw control.managementError;
      if (control.orphan?.guid === guid && !control.deleted.has(guid)) return control.orphan;
      if (control.deleted.has(guid) && !control.presentAfterDelete) throw { status: 404 };
      return control.snapshot ?? { guid, status: control.status };
    },
    async inspectTusUpload() {
      await control.duringInspect?.();
      if (control.headError) throw new Error("HEAD unavailable");
      return { state: control.tusState };
    },
    async terminateTusUpload() { return { state: "terminated" }; },
    async deleteVideo(guid) { control.deleted.add(guid); return { accepted: true }; },
    async searchReelReservation() { return { items: control.orphan ? [control.orphan] : [], totalItems: control.orphan ? 1 : 0, currentPage: 1 }; },
  };
  const service = createReelUploadService({ repository, provider, now: () => control.now,
    enqueue: async id => control.jobs.push(id) });
  const sweep = createReelUploadRecovery({ repository, now: () => control.now,
    enqueue: async id => control.jobs.push(id) });
  const editorial = createEditorialVideoService({ repository: createEditorialVideoRepository({
    videos: db.placements, connection: db.connection, libraryId: "754739", reelUploads: repository,
    coverReferences: createEditorialCoverReferencePersistence({ videos: db.placements, covers: db.covers, recordOperation }),
    deletion: { assets: db.assets, sessions: db.sessions, covers: db.covers, saves: db.saves,
      placements: db.products, recordOperation },
  }), now: () => new Date(control.now), verifyYouTube: async () => assert.fail("unexpected YouTube call"),
    enqueue: async id => control.jobs.push(id) });
  const runtime = createVideoProviderRuntime({ provider, now: () => control.now,
    assets: createVideoAssetObserver({ model: db.assets, now: () => control.now }), operations: {
      claimById: input => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: input => completeVideoProviderOperation({ ...input, model: db.operations, now: new Date(control.now) }),
      fail: input => failVideoProviderOperation({ ...input, model: db.operations, now: new Date(control.now), random: () => 0 }),
    } });
  const initial = await service.createSession({ videoId, actor, file, idempotencyKey: "initial-session-001" });
  let selected = initial;
  if (purpose === "replacement") {
    const current = await db.placements.findOne({ _id: videoId });
    await db.assets.updateOne({ _id: current.activeAssetId }, { $set: { technicalState: "ready", providerStatus: 4 } });
    await db.placements.updateOne({ _id: videoId }, { $set: { status: "published", publishedAt: new Date(start) } });
    selected = await service.createSession({ videoId, actor: initiator, file, purpose, idempotencyKey: "replacement-session-001" });
  }
  control.now += 6 * 60 * 60_000 + 1000;
  const request = { videoId, sessionId: selected.sessionId, actor: initiator, purpose, file,
    idempotencyKey: "resource-recovery-001" };
  return { control, db, repository, service, provider, request, initial, selected, runtime, sweep, editorial,
    async drain() { while (control.jobs.length) {
      const result = await runtime.process(String(control.jobs.shift()));
      assert.equal(result.status, "completed", JSON.stringify(await db.operations.find({})));
    } } };
}

test("Reel non-resumable recovery waits for old cleanup and preserves its original session and deadline", async () => {
  const f = await fixture();
  const before = await f.service.getUploadStatus(f.request);
  const pending = await f.service.recoverUploadSession(f.request);
  assert.equal(pending.status, "recovering");
  assert.equal(pending.upload, undefined);
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "recovering");
  assert.equal(f.control.creations.length, 1);
  await f.drain();
  const issued = await f.service.recoverUploadSession(f.request);
  assert.equal(issued.status, "awaiting_upload");
  assert.equal(issued.sessionId, f.selected.sessionId);
  assert.equal(issued.upload.headers.VideoId, "guid-2");
  assert.equal((await f.service.getUploadStatus(f.request)).abandonAt, before.abandonAt);
  assert.equal((await f.service.recoverUploadSession(f.request)).upload.uploadUrl, issued.upload.uploadUrl);
  assert.equal(f.control.creations.length, 2);
  assert.equal(f.control.deleted.has("guid-1"), true);
});

test("expired waiting recovery releases its initial upload and preserves editable pending metadata", async () => {
  for (const purpose of ["initial", "replacement"]) {
    const f = await fixture({ purpose });
    await f.service.recoverUploadSession(f.request);
    f.control.now = start + 24 * 60 * 60_000;
    assert.equal((await f.sweep.recoverStaleSetups()).recovered, 1);
    const status = await f.service.getUploadStatus(f.request);
    assert.equal(status.status, "failed");
    assert.equal(status.failureCode, "VIDEO_UPLOAD_ABANDONED");
    const video = await f.db.placements.findOne({ _id: videoId });
    if (purpose === "replacement") {
      assert.equal(video.status, "published");
      assert.equal(video.pendingChange.content.title_en, "Original");
      assert.equal(video.pendingChange.assetId, undefined);
    } else assert.equal(video.activeUploadSessionId, undefined);
    assert.equal(f.control.creations.length, purpose === "replacement" ? 2 : 1);
  }
});

test("failed known-resource setup remains cancellable while compensation is due", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.tusError = true;
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  assert.equal((await f.service.cancelUpload(f.request)).status, "cancelled");
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
});

test("pending Reel recovery preserves published media and proposal metadata", async () => {
  const f = await fixture({ purpose: "replacement" });
  const before = await f.db.placements.findOne({ _id: videoId });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  const result = await f.service.recoverUploadSession(f.request);
  const after = await f.db.placements.findOne({ _id: videoId });
  assert.equal(result.sessionId, f.selected.sessionId);
  assert.equal(result.upload.headers.VideoId, "guid-3");
  assert.equal(after.status, "published");
  assert.equal(after.activeAssetId, before.activeAssetId);
  assert.equal(after.title_en, before.title_en);
  assert.equal(after.position, 4);
  assert.deepEqual(after.pendingChange.content, before.pendingChange.content);
  assert.equal(after.pendingChange.autoApplyWhenReady, false);
  assert.equal(after.pendingChange.uploadSessionId, before.pendingChange.uploadSessionId);
  assert.equal(f.control.deleted.has("guid-1"), false);
});

test("cancellation during new TUS setup prevents late adoption and cleans only the new resource", async () => {
  for (const purpose of ["initial", "replacement"]) {
    const f = await fixture({ purpose });
    await f.service.recoverUploadSession(f.request);
    await f.drain();
    f.control.afterTus = () => f.service.cancelUpload(f.request);
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
    assert.equal((await f.service.getUploadStatus(f.request)).status, "cancelled");
    await f.drain();
    assert.equal(f.control.deleted.has(purpose === "replacement" ? "guid-3" : "guid-2"), true);
    if (purpose === "replacement") assert.equal(f.control.deleted.has("guid-1"), false);
  }
});

test("protected recovery routes return private pending and issued responses with both upload gates off", async () => {
  for (const purpose of ["initial", "replacement"]) {
    const f = await fixture({ purpose });
    const app = express();
    app.use(express.json());
    app.use("/admin", createEditorialVideoRouter({ getUploadService: () => f.service,
      isReelUploadEnabled: () => false, isReelPipelineReady: () => false,
      access: [(req, _res, next) => {
        req.user = { _id: actor.id, role: req.get("role") || actor.role,
          enabledControls: req.get("control") === "none" ? [] : [enabledControls.VIDEOS] };
        next();
      }, allowedTo(roles.ADMIN, roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS)] }));
    app.use("/protected", createEditorialVideoRouter({ getUploadService: () => assert.fail("unauthenticated recovery reached service") }));
    app.use(globalError);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const route = `/${videoId}/${purpose === "replacement" ? "replacement-" : ""}upload-sessions/${f.request.sessionId}/recovery`;
    const options = { method: "POST", headers: { "content-type": "application/json",
      "Idempotency-Key": f.request.idempotencyKey }, body: JSON.stringify({ file }) };
    try {
      assert.equal((await fetch(base + "/protected" + route, options)).status, 401);
      assert.equal((await fetch(base + "/admin" + route, { ...options, headers: { ...options.headers, role: roles.USER } })).status, 403);
      assert.equal((await fetch(base + "/admin" + route, { ...options, headers: { ...options.headers, control: "none" } })).status, 403);
      assert.equal((await fetch(base + "/admin" + route, { ...options, body: JSON.stringify({ file, uploadUrl: "untrusted" }) })).status, 400);
      const pending = await fetch(base + "/admin" + route, options);
      assert.equal(pending.status, 202);
      assert.equal(pending.headers.get("cache-control"), "private, no-store");
      const body = await pending.json();
      assert.equal(body.data.upload, undefined);
      assert.equal(JSON.stringify(body).includes("guid-"), false);
      await f.drain();
      const issued = await fetch(base + "/admin" + route, options);
      assert.equal(issued.status, 201);
      assert.equal((await issued.json()).data.sessionId, f.request.sessionId);
      assert.equal(issued.headers.get("cache-control"), "private, no-store");
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test("unknown creates retain their recovery marker and opt-in exact orphan adoption leaves newer media alone", async () => {
  const f = await fixture();
  const pending = await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.createError = true;
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
  await assert.rejects(f.service.recoverUploadSession({ ...f.request, idempotencyKey: "different-recovery-001" }), error => error.statusCode === 409);
  assert.equal(f.control.creations.length, 2);
  f.control.orphan = { guid: "unknown-guid", title: f.control.creations[1].title,
    videoLibraryId: 754739, dateUploaded: new Date(f.control.now).toISOString(),
    status: 0, length: 0, storageSize: 0, encodeProgress: 0, availableResolutions: null };
  const options = { repository: f.repository, provider: f.provider, libraryId: "754739",
    enqueue: async id => f.control.jobs.push(id) };
  assert.deepEqual(await createReelOrphanDiscovery(options).recover(f.request.sessionId, pending.recoveryId), { status: "not_enabled" });
  const discovery = createReelOrphanDiscovery({ ...options, allowCleanup: true });
  assert.equal((await discovery.inspect(f.request.sessionId, pending.recoveryId)).status, "candidate");
  assert.equal((await discovery.recover(f.request.sessionId, pending.recoveryId)).status, "cleanup_recorded");
  await f.drain();
  assert.equal(f.control.deleted.has("unknown-guid"), true);
});

test("processing, ready, failed, resumable and malformed provider observations do not allocate or delete", async () => {
  for (const status of [1, 2, 3, 4, 5, 6, null, "0"]) {
    const f = await fixture();
    f.control.status = status;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
    assert.equal(f.control.jobs.length, 0);
    assert.equal(f.control.creations.length, 1);
  }
  for (const state of ["complete", "incomplete", "invalid", undefined]) {
    const f = await fixture();
    f.control.tusState = state;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
    assert.equal(f.control.deleted.size, 0);
  }
  for (const snapshot of [{ guid: "wrong-guid", status: 0 }, { guid: "guid-1", status: 0, videoLibraryId: 999 }]) {
    const f = await fixture();
    f.control.snapshot = snapshot;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
    assert.equal(f.control.jobs.length, 0);
  }
  for (const fault of ["managementError", "headError"]) {
    const f = await fixture();
    f.control[fault] = fault === "managementError" ? { status: 503 } : true;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
    assert.equal(f.control.jobs.length, 0);
  }
});

test("wrong authors and wrong session purposes cannot recover another upload", async () => {
  for (const purpose of ["initial", "replacement"]) {
    const f = await fixture({ purpose });
    await assert.rejects(f.service.recoverUploadSession({ ...f.request,
      actor: { ...actor, id: videoId } }), error => [404, 409].includes(error.statusCode));
    await assert.rejects(f.service.recoverUploadSession({ ...f.request,
      purpose: purpose === "initial" ? "replacement" : "initial" }), error => error.statusCode === 409);
    assert.equal(f.control.jobs.length, 0);
  }
});

test("authoritative management absence still requires durable cleanup before recovery allocation", async () => {
  const f = await fixture();
  f.control.managementError = { status: 404 };
  f.control.tusState = "incomplete";
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "recovering");
  await f.drain();
  f.control.managementError = null;
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "awaiting_upload");
});

test("ready wins during provider inspection without reserving cleanup", async () => {
  const f = await fixture();
  f.control.duringInspect = () => f.db.assets.updateOne({ providerGuid: "guid-1" }, { $set: { technicalState: "ready", providerStatus: 4 } });
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
  assert.equal(f.control.jobs.length, 0);
  assert.equal(f.control.deleted.size, 0);
});

test("management deletion acceptance cannot unlock allocation while its video remains present", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  f.control.presentAfterDelete = true;
  assert.equal((await f.runtime.process(String(f.control.jobs.shift()))).status, "retryable");
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "recovering");
  assert.equal(f.control.creations.length, 1);
});

test("concurrent recovery retries claim one new resource and changed descriptors conflict", async () => {
  const f = await fixture();
  const pending = await Promise.allSettled([f.service.recoverUploadSession(f.request), f.service.recoverUploadSession(f.request)]);
  assert.equal(pending.filter(result => result.status === "fulfilled").length, 1);
  await f.drain();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.control.beforeCreate = () => new Promise(resolve => { release = resolve; entered(); });
  const preparing = f.service.recoverUploadSession(f.request);
  await started;
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
  await assert.rejects(f.service.recoverUploadSession({ ...f.request, file: { ...file, sizeBytes: 99 } }), error => error.statusCode === 409);
  release();
  await preparing;
  assert.equal(f.control.creations.length, 2);
});

test("lost issue commit acknowledgement preserves the issued winner for same-key replay", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = () => { f.control.loseCommitResponse = true; };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  const replay = await f.service.recoverUploadSession(f.request);
  assert.equal(replay.upload.headers.VideoId, "guid-2");
  assert.equal(f.control.deleted.has("guid-2"), false);
  assert.equal(f.control.jobs.length, 0);
});

test("stale creation claims reject late results and persist known GUID compensation", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.beforeCreate = async () => {
    f.control.now += 60 * 60_000;
    assert.equal((await f.sweep.recoverStaleSetups()).recovered, 1);
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
});

test("new resource expiry is capped by the original deadline and late TUS responses are compensated", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.now = start + 24 * 60 * 60_000 - 30_000;
  assert.equal((await f.service.recoverUploadSession(f.request)).upload.resourceExpiresAt, (start + 24 * 60 * 60_000) / 1000);
  const late = await fixture({ purpose: "replacement" });
  await late.service.recoverUploadSession(late.request);
  await late.drain();
  late.control.afterTus = () => { late.control.now = start + 24 * 60 * 60_000; };
  await assert.rejects(late.service.recoverUploadSession(late.request), error => error.statusCode === 503);
  await late.drain();
  assert.equal(late.control.deleted.has("guid-3"), true);
  assert.equal(late.control.deleted.has("guid-1"), false);
  assert.equal((await late.service.getUploadStatus(late.request)).failureCode, "VIDEO_UPLOAD_ABANDONED");
});

test("a changed published active generation rejects pending recovery adoption and preserves the winner", async () => {
  const f = await fixture({ purpose: "replacement" });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = async () => {
    const [winner] = await f.db.assets.create([{ ownerType: "reel", ownerId: videoId,
      libraryId: "754739", providerGuid: "winning-guid", technicalState: "ready", providerStatus: 4 }]);
    await f.db.placements.updateOne({ _id: videoId }, { $set: { activeAssetId: winner._id } });
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  assert.equal(f.control.deleted.has("winning-guid"), false);
  assert.equal(f.control.deleted.has("guid-3"), true);
});

test("a returned GUID owned by another upload cannot be attached or deleted", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  await f.db.assets.create([{ ownerType: "reel", ownerId: actor.id, libraryId: "754739",
    providerGuid: "guid-2", technicalState: "ready" }]);
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 500 &&
    error.errors[0].code === "VIDEO_CLEANUP_PERSISTENCE_FAILED");
  assert.equal(f.control.deleted.has("guid-2"), false);
});

test("recovery status exposes only safe marker state and cannot refresh a retired old asset", async () => {
  const f = await fixture();
  const result = await f.service.recoverUploadSession(f.request);
  const status = await f.service.getUploadStatus(f.request);
  assert.deepEqual(status.recovery, { id: result.recoveryId, status: "waiting_cleanup", failureCode: null });
  assert.equal(status.canRefresh, false);
  assert.equal(JSON.stringify(status).includes("guid-1"), false);
});

test("malformed create GUIDs retain the uncertain marker without scheduling impossible cleanup", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.createdGuid = "invalid/guid";
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  assert.equal(f.control.jobs.length, 0);
  await assert.rejects(f.service.recoverUploadSession({ ...f.request, idempotencyKey: "different-recovery-001" }), error => error.statusCode === 409);
});

test("recovery cleanup persistence failure rolls back the reservation before provider creation", async () => {
  const f = await fixture();
  f.control.failOperation = true;
  await assert.rejects(f.service.recoverUploadSession(f.request));
  assert.equal(f.control.jobs.length, 0);
  assert.equal((await f.service.getUploadStatus(f.request)).recovery, undefined);
  assert.equal(f.control.creations.length, 1);
  f.control.failOperation = false;
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "recovering");
});

test("cancelling the entire pending proposal during recovery preserves published media and compensates late TUS", async () => {
  const f = await fixture({ purpose: "replacement" });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = () => f.editorial.cancelPendingChange({ id: videoId, actor });
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  const video = await f.db.placements.findOne({ _id: videoId });
  assert.equal(video.pendingChange, null);
  assert.equal(video.status, "published");
  assert.equal(f.control.deleted.has("guid-1"), false);
  assert.equal(f.control.deleted.has("guid-3"), true);
});

test("permanent owner deletion during recovery prevents resurrection and retains late cleanup", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = async () => {
    const video = await f.db.placements.findOne({ _id: videoId });
    await f.editorial.deletePermanently({ id: videoId, actor: { ...actor, role: roles.SUPER_ADMIN },
      input: { revision: video.revision } });
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  await assert.rejects(f.service.getUploadStatus(f.request), error => error.statusCode === 404);
  assert.equal(f.control.deleted.has("guid-2"), true);
});

test("super-admin pending recovery preserves the automatic review authority of its existing session", async () => {
  const f = await fixture({ purpose: "replacement", automatic: true });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  await f.service.recoverUploadSession(f.request);
  const video = await f.db.placements.findOne({ _id: videoId });
  assert.equal(video.pendingChange.autoApplyWhenReady, true);
  assert.equal(video.pendingChange.status, "draft");
  assert.equal(video.status, "published");
  assert.equal(f.control.deleted.has("guid-1"), false);
});
