import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation, listDueVideoProviderOperationIds } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createEditorialCoverRepository } from "../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createEditorialCoverService } from "../../../../src/domains/videos/editorial/editorialCover.service.js";
import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../src/domains/videos/reels/reelUpload.service.js";

const videoId = "507f1f77bcf86cd799439011";
const otherId = "507f1f77bcf86cd799439012";
const superAdmin = { id: "507f1f77bcf86cd799439099", role: roles.SUPER_ADMIN };
const timestamp = new Date("2026-10-01T00:00:00Z");
const video = (fields = {}) => ({ _id: videoId, kind: "youtube", status: "published", revision: 3,
  authorId: superAdmin.id, title_en: "Current", title_ar: "عنوان", youtubeId: "dQw4w9WgXcQ", ...fields });

function fixture(seed = {}, serviceOptions = {}) {
  const db = replacementDatabase({ placements: [video(), video({ _id: otherId })], ...seed });
  const control = { queued: [], queueUnavailable: true, failOperation: false, deleteStatus: null,
    objects: new Set(), now: timestamp.getTime() };
  for (const asset of seed.assets || []) control.objects.add(`video:${asset.providerGuid}`);
  for (const cover of seed.covers || []) control.objects.add(`cover:${cover._id}`);
  const enqueue = async (id) => { control.queued.push(id); if (control.queueUnavailable) throw new Error("Redis unavailable"); };
  const recordOperation = (input) => {
    if (control.failOperation) throw new Error("operation persistence failed");
    return recordVideoProviderOperation({ now: new Date(control.now), ...input, model: db.operations });
  };
  const service = createEditorialVideoService({ repository: createEditorialVideoRepository({ videos: db.placements,
    connection: db.connection, reelLifecycle: {}, deletion: { saves: db.saves, assets: db.assets,
      sessions: db.sessions, covers: db.covers, placements: db.products, recordOperation } }),
    verifyYouTube: async () => assert.fail("deletion must not call YouTube"),
    enqueue, now: () => timestamp, ...serviceOptions,
  });
  const coverService = createEditorialCoverService({ repository: createEditorialCoverRepository({
    covers: db.covers, videos: db.placements, connection: db.connection, recordOperation }),
    store: { async remove({ coverId }) { control.objects.delete(`cover:${coverId}`); } }, enqueue,
    now: () => new Date(control.now),
  });
  const runtime = createVideoProviderRuntime({ provider: {
    async deleteVideo(guid) {
      if (control.deleteStatus) throw { status: control.deleteStatus };
      control.objects.delete(`video:${guid}`);
    }, async getVideo() { throw { status: 404 }; },
  }, assets: createVideoAssetObserver({ model: db.assets, now: () => control.now }), covers: coverService,
    operations: {
      claimById: (input) => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: (input) => completeVideoProviderOperation({ ...input, now: new Date(control.now), model: db.operations }),
      fail: (input) => failVideoProviderOperation({ ...input, now: new Date(control.now), random: () => 0, model: db.operations }),
      listDueIds: (input) => listDueVideoProviderOperationIds({ ...input, model: db.operations }),
    }, enqueue, now: () => control.now,
  });
  return { service, db, control, runtime, recordOperation, enqueue, coverService };
}

test("super admin permanently removes a YouTube Video without changing another Video, and repeat deletion is safe", async () => {
  const { service } = fixture();
  const other = await service.getAdmin({ id: otherId, actor: superAdmin });
  assert.deepEqual(await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } }),
    { videoId, status: "removed" });
  await assert.rejects(service.getAdmin({ id: videoId, actor: superAdmin }), (error) => error.statusCode === 404);
  assert.deepEqual(await service.getAdmin({ id: otherId, actor: superAdmin }), other);
  assert.deepEqual(await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } }),
    { videoId, status: "removed" });
});

test("deleting a Reel records cleanup for active, pending and detached owned assets; Redis failure cannot restore it", async () => {
  const assets = ["active", "pending", "detached"].map((providerGuid, index) => ({ _id: `607f1f77bcf86cd79943901${index}`,
    ownerType: "reel", ownerId: videoId, libraryId: "754739", providerGuid, technicalState: "ready" }));
  const unrelated = { ...assets[0], _id: "607f1f77bcf86cd799439019", ownerId: otherId, providerGuid: "unrelated" };
  const { service, control, runtime } = fixture({ placements: [video({ kind: "reel", youtubeId: undefined,
    activeAssetId: assets[0]._id, pendingChange: { assetId: assets[1]._id } })], assets: [...assets, unrelated] });
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  await assert.rejects(service.getAdmin({ id: videoId, actor: superAdmin }), (error) => error.statusCode === 404);
  assert.equal(control.queued.length, 3);
  for (const id of control.queued) assert.equal((await runtime.process(id)).status, "completed");
  assert.deepEqual([...control.objects], ["video:unrelated"]);
});

test("a save that passed the public read before deletion cannot recreate a removed association", async () => {
  const { service, db } = fixture();
  const identity = { type: "guest", id: "guest-1" };
  let signal, release;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const videos = { ...db.placements, async aggregate() {
    const current = await db.placements.findById(videoId);
    signal(); await paused;
    return current ? [current] : [];
  } };
  const repository = createPublicVideoRepository({ videos, saves: db.saves, connection: db.connection });
  await repository.save({ identity, videoId });
  assert.equal((await service.getAdmin({ id: videoId, actor: superAdmin })).revision, 3);
  const publicService = createPublicVideoService({ repository, isEnabled: () => true });
  const saving = publicService.save({ id: videoId, identity });
  await started;
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  release();
  await assert.rejects(saving, (error) => error.statusCode === 404);
  assert.equal((await repository.savedIds({ identity, videoIds: [videoId] })).size, 0);
  await assert.rejects(publicService.getVideo({ id: videoId }), (error) => error.statusCode === 404);
});

async function withHttp(router, work) {
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", router); app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("permanent deletion uses the existing authentication, role and control middleware before validation", async () => {
  const { service } = fixture();
  const router = createEditorialVideoRouter({ access: [
    (req, _res, next) => { req.user = { _id: superAdmin.id, role: req.get("test-role"),
      enabledControls: req.get("test-control") ? [enabledControls.VIDEOS] : [] }; next(); },
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControl(enabledControls.VIDEOS),
  ], getService: async () => service });
  await withHttp(router, async (url) => {
    const remove = (id, input, role, control = false) => fetch(`${url}/${id}`, { method: "DELETE",
      headers: { "content-type": "application/json", "test-role": role, ...(control ? { "test-control": "yes" } : {}) },
      body: JSON.stringify(input) });
    for (const [role, control] of [[roles.USER, false], [roles.MODERATOR, true], [roles.ADMIN, false], [roles.ADMIN, true]]) {
      assert.equal((await remove("bad-id", {}, role, control)).status, 403);
    }
    assert.equal((await remove("bad-id", {}, roles.SUPER_ADMIN)).status, 422);
    assert.equal((await remove(videoId, { revision: 3, providerGuid: "injected" }, roles.SUPER_ADMIN)).status, 422);
    assert.equal((await remove(videoId, { revision: 2 }, roles.SUPER_ADMIN)).status, 409);
    const response = await remove(videoId, { revision: 3 }, roles.SUPER_ADMIN);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: { videoId, status: "removed" } });
    assert.equal((await remove(videoId, { revision: 3 }, roles.SUPER_ADMIN)).status, 202);
  });
  await withHttp(createEditorialVideoRouter({ getService: () => assert.fail("must authenticate first") }), async (url) => {
    for (const authorization of [null, "Bearer invalid"]) {
      assert.equal((await fetch(`${url}/bad-id`, { method: "DELETE", headers: {
        "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: "{}" })).status, 401);
    }
  });
});

test("active, pending and unattached covers are cleaned independently without deleting another Video's cover", async () => {
  const covers = [0, 1, 2].map((index) => ({ _id: `707f1f77bcf86cd79943901${index}`, videoId,
    state: index === 2 ? "uploaded" : "attached", uploadSettledAt: timestamp, referenceRevision: 0 }));
  const unrelated = { ...covers[0], _id: "707f1f77bcf86cd799439019", videoId: otherId };
  const { service, runtime, control } = fixture({ covers: [...covers, unrelated],
    placements: [video({ activeCoverId: covers[0]._id, pendingChange: { content: { coverId: covers[1]._id } } })] });
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  assert.equal(control.queued.length, 3);
  for (const id of control.queued) assert.equal((await runtime.process(id)).status, "completed");
  assert.deepEqual([...control.objects], [`cover:${unrelated._id}`]);
});

test("cleanup persistence failure rolls back the Video, saves and all media intents without dispatching", async () => {
  const identity = { type: "user", id: superAdmin.id };
  const asset = { _id: "607f1f77bcf86cd799439010", ownerType: "reel", ownerId: videoId,
    libraryId: "754739", providerGuid: "active", technicalState: "ready" };
  const { service, db, control } = fixture({ placements: [video({ kind: "reel", youtubeId: undefined, activeAssetId: asset._id })],
    assets: [asset], saves: [{ videoId, identityType: identity.type, identityId: identity.id }] });
  const repository = createPublicVideoRepository({ saves: db.saves });
  const before = await service.getAdmin({ id: videoId, actor: superAdmin });
  control.failOperation = true;
  await assert.rejects(service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } }), /persistence failed/);
  assert.deepEqual(await service.getAdmin({ id: videoId, actor: superAdmin }), before);
  assert.equal((await repository.savedIds({ identity, videoIds: [videoId] })).size, 1);
  assert.equal(control.queued.length, 0); assert.deepEqual([...control.objects], ["video:active"]);
  control.failOperation = false;
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  assert.equal((await repository.savedIds({ identity, videoIds: [videoId] })).size, 0);
});

test("Bunny rejection and Redis downtime leave durable cleanup retryable while the owner remains removed", async () => {
  const asset = { _id: "607f1f77bcf86cd799439010", ownerType: "reel", ownerId: videoId,
    libraryId: "754739", providerGuid: "active", technicalState: "ready" };
  const { service, runtime, control } = fixture({ assets: [asset] });
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  const operationId = control.queued[0]; control.deleteStatus = 403;
  assert.equal((await runtime.process(operationId)).status, "retryable");
  await assert.rejects(service.getAdmin({ id: videoId, actor: superAdmin }), (error) => error.statusCode === 404);
  assert.deepEqual([...control.objects], ["video:active"]);
  control.now += 60_000; control.queueUnavailable = false; control.deleteStatus = null;
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.equal((await runtime.process(operationId)).status, "completed");
  assert.equal(control.objects.size, 0);
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
});

test("permanent deletion rejects stale revisions, malformed commands and non-super-admin actors without side effects", async () => {
  const { service } = fixture();
  const before = await service.getAdmin({ id: videoId, actor: superAdmin });
  for (const input of [null, [], {}, { revision: 3, activeAssetId: "injected" },
    ...[-1, 0.5, "3", true, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({ revision }))]) {
    await assert.rejects(service.deletePermanently({ id: videoId, actor: superAdmin, input }),
      (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_DELETE");
  }
  for (const id of [null, [], {}, "bad-id", `${videoId}00`]) {
    await assert.rejects(service.deletePermanently({ id, actor: superAdmin, input: { revision: 3 } }), (error) => error.statusCode === 422);
  }
  for (const actor of [null, { role: roles.SUPER_ADMIN }, ...[roles.ADMIN, roles.MODERATOR, roles.USER]
    .map((role) => ({ ...superAdmin, role }))]) {
    await assert.rejects(service.deletePermanently({ id: videoId, actor, input: {} }), (error) => error.statusCode === 403);
  }
  await assert.rejects(service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 2 } }),
    (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
  assert.deepEqual(await service.getAdmin({ id: videoId, actor: superAdmin }), before);
  assert.deepEqual(await service.deletePermanently({ id: videoId.toUpperCase(), actor: superAdmin, input: { revision: 3 } }),
    { videoId, status: "removed" });
});

test("deletion works in every editorial lifecycle state and never deletes missing or cross-owner media references", async () => {
  for (const status of ["draft", "in_review", "approved", "published", "unpublished"]) {
    const { service } = fixture({ placements: [video({ status })] });
    assert.equal((await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } })).status, "removed");
  }
  const assetId = "607f1f77bcf86cd799439010", coverId = "707f1f77bcf86cd799439010";
  const ownedAsset = { _id: assetId, ownerType: "reel", ownerId: videoId,
    libraryId: "754739", providerGuid: "owned", technicalState: "ready" };
  for (const seed of [
    { placements: [video({ kind: "product" })] },
    { placements: [video({ activeAssetId: assetId })] },
    { placements: [video({ pendingChange: { assetId } })], assets: [{ ...ownedAsset, ownerId: otherId }] },
    { placements: [video({ activeCoverId: coverId })] },
    { placements: [video({ pendingChange: { content: { coverId } } })], covers: [{ _id: coverId, videoId: otherId, state: "attached" }] },
    { assets: [ownedAsset], placements: [video(), video({ _id: otherId, pendingChange: { assetId } })] },
    { assets: [ownedAsset], products: [{ _id: otherId, activeAssetId: assetId }] },
    { covers: [{ _id: coverId, videoId, state: "uploaded" }], placements: [video(), video({ _id: otherId, activeCoverId: coverId })] },
  ]) {
    const { service, control } = fixture(seed);
    const before = await service.getAdmin({ id: videoId, actor: superAdmin });
    await assert.rejects(service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } }),
      (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
    assert.deepEqual(await service.getAdmin({ id: videoId, actor: superAdmin }), before);
    assert.equal(control.queued.length, 0);
  }
});

test("a late Bunny create result after deletion is compensated, never attached or returned as an upload grant", async () => {
  const { service, db, control, recordOperation, enqueue, runtime } = fixture({
    placements: [video({ kind: "reel", youtubeId: undefined, status: "draft" })] });
  let signal, release;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  let marker;
  const upload = createReelUploadService({ repository: createReelUploadRepository({ libraryId: "754739",
    videos: db.placements, assets: db.assets, sessions: db.sessions, attempts: db.attempts,
    connection: db.connection, recordOperation, now: () => control.now }), enqueue, now: () => control.now,
    provider: { async createVideo({ title }) { marker = title; signal(); await paused;
      control.objects.add("video:late-guid"); return { guid: "late-guid" }; },
    createTusUpload: () => assert.fail("deleted owner must not receive a TUS resource"),
    createTusUploadAuthorization: () => assert.fail("deleted owner must not receive a grant") } });
  const pending = upload.createSession({ videoId, actor: superAdmin, idempotencyKey: "delete-while-creating",
    file: { filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 512 } });
  await started;
  assert.match(marker, /^petyard-reel-session:[a-f\d]{24}$/);
  const current = await service.getAdmin({ id: videoId, actor: superAdmin });
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: current.revision } });
  release();
  await assert.rejects(pending, (error) => error.errors[0].code === "VIDEO_PROVIDER_UNAVAILABLE");
  assert.equal(control.queued.length, 1);
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
  assert.equal(control.objects.size, 0);
  await assert.rejects(upload.getUploadStatus({ videoId, actor: superAdmin }), (error) => error.statusCode === 404);
  await assert.rejects(service.getAdmin({ id: videoId, actor: superAdmin }), (error) => error.statusCode === 404);
});

test("a cover PUT settling after an earlier cleanup is removed on retry, not falsely marked complete", async () => {
  const { service, db, control, recordOperation, enqueue, runtime } = fixture();
  let signal, release, generation;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const covers = createEditorialCoverService({ repository: createEditorialCoverRepository({
    covers: db.covers, videos: db.placements, connection: db.connection, recordOperation }), enqueue,
  now: () => new Date(control.now), store: {
    validate: async () => {}, identity: () => ({ cdnBaseUrl: "https://images.example" }),
    async upload({ coverId }) { generation = String(coverId); signal(); await paused;
      control.objects.add(`cover:${generation}`);
      return { public_id: `petyard/video-covers/${generation}`, url: `https://images.example/petyard/video-covers/${generation}.webp` }; },
  } });
  const putting = covers.stageUpload({ videoId, actor: superAdmin, buffer: Buffer.from("cover") });
  await started;
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  const operationId = control.queued[0];
  assert.equal((await runtime.process(operationId)).status, "retryable");
  release();
  await assert.rejects(putting, (error) => error.errors[0].code === "VIDEO_COVER_PERSISTENCE_FAILED");
  assert.equal(control.objects.has(`cover:${generation}`), true);
  control.now += 60_000;
  assert.equal((await runtime.process(operationId)).status, "completed");
  assert.equal(control.objects.size, 0);
});

test("deletion purges both guest and user saves, preserves unrelated saves, and fences concurrently started saves", async () => {
  const identities = [{ type: "guest", id: "guest-1" }, { type: "user", id: superAdmin.id }];
  const { service, db } = fixture();
  const repository = createPublicVideoRepository({ videos: db.placements, saves: db.saves, connection: db.connection });
  for (const identity of identities) {
    await repository.save({ identity, videoId });
    await repository.save({ identity, videoId: otherId });
  }
  await Promise.all([repository.save({ identity: identities[0], videoId }),
    service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } }),
    repository.save({ identity: identities[1], videoId })]);
  for (const identity of identities) {
    assert.deepEqual([...(await repository.savedIds({ identity, videoIds: [videoId, otherId] }))], [otherId]);
    assert.equal(await repository.save({ identity, videoId }), false);
  }
  assert.equal((await service.getAdmin({ id: otherId, actor: superAdmin })).revision, 3);
});

test("a lifecycle write verified before deletion cannot republish or resurrect the deleted owner", async () => {
  let signal, release;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const admin = { ...superAdmin, role: roles.ADMIN };
  const { service } = fixture({ placements: [video({ status: "draft" })] }, {
    verifyYouTube: async () => { signal(); await paused; },
  });
  const submitting = service.submit({ id: videoId, actor: admin });
  await started;
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  release();
  await assert.rejects(submitting, (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
  await assert.rejects(service.getAdmin({ id: videoId, actor: superAdmin }), (error) => error.statusCode === 404);
});

test("cover reservation checks the owner with a conditional write and never PUTs after that owner is removed", async () => {
  const { service, db, recordOperation, enqueue } = fixture();
  let signal, release;
  const started = new Promise((resolve) => { signal = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  // External model adapter allows overlapping transactions here, unlike the
  // serialized fixture. A stale read succeeds; a conditional write sees loss.
  const videos = { ...db.placements,
    findOne(filter) { return { session: async () => {
      const snapshot = await db.placements.findOne(filter); signal(); await paused; return snapshot;
    } }; },
    async findOneAndUpdate(...args) { signal(); await paused; return db.placements.findOneAndUpdate(...args); },
  };
  const covers = createEditorialCoverService({ repository: createEditorialCoverRepository({
    covers: db.covers, videos, recordOperation, connection: { async startSession() {
      return { withTransaction: (work) => work(), endSession: async () => {} };
    } } }), enqueue, store: { validate: async () => {}, identity: () => ({ cdnBaseUrl: "https://images.example" }),
    upload: () => assert.fail("a deleted owner must not allocate cover storage") } });
  const putting = covers.stageUpload({ videoId, actor: superAdmin, buffer: Buffer.from("cover") });
  await started;
  await service.deletePermanently({ id: videoId, actor: superAdmin, input: { revision: 3 } });
  release();
  await assert.rejects(putting, /VIDEO_COVER_OWNER_NOT_FOUND/);
});
