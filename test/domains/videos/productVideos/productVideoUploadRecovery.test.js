import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById,
  completeVideoProviderOperation, failVideoProviderOperation }
  from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";
import express from "express";
import { createProductVideoRouter } from "../../../../src/domains/videos/productVideos/productVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const productId = "507f191e810c19729de860ea";
const actorId = "507f1f77bcf86cd799439012";
const start = Date.parse("2026-10-08T00:00:00Z");
const file = { clientId: "selected", filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 100 };

async function fixture({ replacement = false, allowOrphanCleanup = false } = {}) {
  const control = { now: start, creations: [], tus: [], deleted: new Set(), queued: [], status: 0,
    tusState: "not_found", createError: null, tusError: null, beforeCreate: null, afterTus: null,
    duringInspect: null, jobs: [], presentAfterDelete: false };
  const db = replacementDatabase({ products: [{ _id: productId }] }, { now: () => control.now });
  const originalStartSession = db.connection.startSession.bind(db.connection);
  db.connection.startSession = async () => {
    const session = await originalStartSession();
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
  const writeOperation = db.operations.findOneAndUpdate.bind(db.operations);
  db.operations.findOneAndUpdate = (...args) => {
    if (control.failOperation && args[1].$setOnInsert) throw new Error("operation storage unavailable");
    return writeOperation(...args);
  };
  const recordOperation = input => recordVideoProviderOperation({ ...input, model: db.operations,
    now: new Date(control.now) });
  const provider = {
    async createVideo(input) {
      control.creations.push(input);
      await control.beforeCreate?.();
      if (control.createError) throw control.createError;
      return { guid: `guid-${control.creations.length}` };
    },
    async createTusUpload(input) {
      control.tus.push(input);
      if (control.tusError) throw control.tusError;
      const resource = { uploadUrl: `https://video.bunnycdn.com/tusupload/${input.videoId}`, resourceExpiresAt: input.expiresAt };
      await control.afterTus?.();
      return resource;
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
    async getVideo(guid) {
      if (control.deleted.has(guid) && !control.presentAfterDelete) throw { status: 404 };
      if (control.orphan?.guid === guid) return control.orphan;
      return { guid, status: control.status, length: 2, width: 320, height: 240, availableResolutions: "240p" };
    },
    async inspectTusUpload() { await control.duringInspect?.(); return { state: control.tusState }; },
    async terminateTusUpload() { return { state: "terminated" }; },
    async deleteVideo(guid) { control.deleted.add(guid); return { accepted: true }; },
    async searchProductReservation() { return { items: control.orphan ? [control.orphan] : [],
      currentPage: 1, totalItems: control.orphan ? 1 : 0 }; },
  };
  const repository = createProductVideoRepository({ ...db, libraryId: "754739", now: () => control.now, recordOperation });
  const service = createProductVideoService({ repository, provider, now: () => control.now,
    allowOrphanCleanup, enqueue: async id => { control.queued.push(id); control.jobs.push(id); }, invalidateCaches: async () => {} });
  const runtime = createVideoProviderRuntime({ provider, now: () => control.now,
    assets: createVideoAssetObserver({ model: db.assets, now: () => control.now,
      onApplied: asset => service.handleVerifiedAsset(asset), onDeleted: asset => service.handleDeletedAsset(asset) }),
    operations: {
      claimById: input => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: input => completeVideoProviderOperation({ ...input, model: db.operations, now: new Date(control.now) }),
      fail: input => failVideoProviderOperation({ ...input, model: db.operations, now: new Date(control.now), random: () => 0 }),
    },
  });
  const [initial] = await service.createUploadSessions({ productId, actorId, files: [file], idempotencyKey: "initial-session-001" });
  let replacementId;
  if (replacement) {
    await db.assets.updateOne({ providerGuid: "guid-1" }, { $set: { technicalState: "ready", providerStatus: 4 } });
    await db.placements.updateOne({ _id: initial.productVideoId }, { $set: { lifecycleState: "ready" } });
    replacementId = (await service.createReplacementUploadSession({ productId, videoId: initial.productVideoId,
      actorId, idempotencyKey: "replacement-session-001", file })).replacementId;
  }
  control.now += 6 * 60 * 60_000 + 1000;
  const request = { productId, videoId: initial.productVideoId, actorId,
    idempotencyKey: "recover-session-001", file, ...(replacementId ? { replacementId } : {}) };
  const drain = async () => {
    for (const id of control.queued.splice(0)) await runtime.process(id);
  };
  return { service, runtime, db, control, request, drain, initial };
}

test("non-resumable Product recovery preserves its placement and waits for durable provider absence before allocating", async () => {
  const f = await fixture();
  const pending = await f.service.recoverUploadSession(f.request);
  assert.equal(pending.status, "recovering");
  assert.equal(f.control.creations.length, 1);
  await f.drain();
  const recovered = await f.service.recoverUploadSession(f.request);
  assert.equal(recovered.productVideoId, f.initial.productVideoId);
  assert.equal(recovered.position, f.initial.position);
  assert.equal(recovered.status, "awaiting_upload");
  assert.equal(recovered.upload.headers.VideoId, "guid-2");
  assert.equal(f.control.tus[1].expiresAt, Math.floor(f.control.now / 1000) + 21600);
  assert.equal((await f.service.listAdminStatus({ productId }))[0].showInReelsFeed, true);
  assert.deepEqual(await f.service.recoverUploadSession(f.request), recovered);
  assert.equal(f.control.creations.length, 2);
  f.control.now = start + 24 * 60 * 60_000;
  await assert.rejects(f.service.refreshUploadAuthorization({ productId, videoId: recovered.productVideoId }),
    error => error.errors?.[0]?.code === "VIDEO_UPLOAD_CONFLICT");
});

test("recovery cancellation remains available while cleanup is complete and new TUS setup is in flight", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = async () => {
    await f.service.cancelPendingUpload({ productId, videoId: f.request.videoId });
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  assert.deepEqual(await f.service.listAdminStatus({ productId }), []);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
});

test("pending Product replacement recovery keeps the old ready asset and the same replacement identity", async () => {
  const f = await fixture({ replacement: true });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  const result = await f.service.recoverUploadSession(f.request);
  assert.equal(result.replacementId, f.request.replacementId);
  assert.equal(result.productVideoId, f.initial.productVideoId);
  assert.equal(result.upload.headers.VideoId, "guid-3");
  const [status] = await f.service.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement.id, f.request.replacementId);
  assert.equal(status.replacement.status, "awaiting_upload");
  assert.equal(f.control.deleted.has("guid-1"), false);
});

test("cancelling a recovering pending replacement preserves current ready media and compensates late setup", async () => {
  const f = await fixture({ replacement: true });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = async () => { await f.service.cancelReplacementUpload({ productId,
    videoId: f.request.videoId, replacementId: f.request.replacementId }); };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  const [status] = await f.service.listAdminStatus({ productId });
  assert.equal(status.status, "ready");
  assert.equal(status.replacement, undefined);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-3"), true);
  assert.equal(f.control.deleted.has("guid-1"), false);
});

test("a changed active ready generation prevents pending recovery adoption and preserves the winner", async () => {
  const f = await fixture({ replacement: true });
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = async () => {
    const [winning] = await f.db.assets.create([{ libraryId: "754739", providerGuid: "winning-guid",
      ownerType: "product_video", ownerId: f.request.videoId, technicalState: "ready" }]);
    await f.db.placements.updateOne({ _id: f.request.videoId }, { $set: { activeAssetId: winning._id } });
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  assert.equal(f.control.deleted.has("winning-guid"), false);
  assert.equal(f.control.deleted.has("guid-3"), true);
  assert.equal((await f.service.listAdminStatus({ productId }))[0].status, "ready");
});

test("recovery never allocates from TUS absence when management reports processing, ready or failure", async () => {
  for (const status of [1, 2, 3, 4, 5, 6]) {
    const f = await fixture();
    f.control.status = status;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
    assert.equal(f.control.jobs.length, 0);
    assert.equal(f.control.creations.length, 1);
  }
});

test("resumable or complete TUS resources cannot trigger a replacement allocation", async () => {
  for (const state of ["incomplete", "complete", undefined]) {
    const f = await fixture();
    f.control.tusState = state;
    await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
    assert.equal(f.control.jobs.length, 0);
  }
});

test("a ready snapshot winning during TUS observation prevents recovery ownership", async () => {
  const f = await fixture();
  f.control.duringInspect = async () => {
    await f.db.assets.updateOne({ providerGuid: "guid-1" }, { $set: { technicalState: "ready", providerStatus: 4 } });
    await f.db.placements.updateOne({ _id: f.request.videoId }, { $set: { lifecycleState: "ready" } });
  };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 409);
  assert.equal((await f.service.listAdminStatus({ productId }))[0].status, "ready");
  assert.equal(f.control.jobs.length, 0);
});

test("an accepted old deletion still present at the provider cannot unlock fallback setup", async () => {
  const f = await fixture();
  f.control.presentAfterDelete = true;
  const pending = await f.service.recoverUploadSession(f.request);
  await f.drain();
  assert.deepEqual(await f.service.recoverUploadSession(f.request), pending);
  assert.equal(f.control.creations.length, 1);
  f.control.now += 60_000;
  f.control.presentAfterDelete = false;
  await f.runtime.process(f.control.jobs[0]);
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "awaiting_upload");
});

test("concurrent recovery requests record one cleanup generation and conflicting retries fail closed", async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([f.service.recoverUploadSession(f.request), f.service.recoverUploadSession(f.request)]);
  assert.ok(attempts.some(result => result.status === "fulfilled"));
  assert.equal(f.control.jobs.length, 1);
  await assert.rejects(f.service.recoverUploadSession({ ...f.request, file: { ...file, sizeBytes: 101 } }),
    error => error.statusCode === 409);
  assert.equal(f.control.creations.length, 1);
});

test("uncertain new creation is never blindly retried with the same or a different key", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.createError = new Error("provider timeout containing private data");
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503 &&
    !JSON.stringify(error).includes("private data"));
  f.control.createError = null;
  for (const idempotencyKey of [f.request.idempotencyKey, "other-recovery-001"]) {
    await assert.rejects(f.service.recoverUploadSession({ ...f.request, idempotencyKey }), error => error.statusCode === 409);
  }
  assert.equal(f.control.creations.length, 2);
});

test("failed recovery TUS setup durably compensates the persisted new GUID", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.tusError = new Error("uncertain TUS POST");
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
  assert.equal((await f.service.listAdminStatus({ productId })).length, 1);
});

test("recovery issued near the original deadline caps its new resource and grant without extending abandonment", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.now = start + 23 * 60 * 60_000;
  const result = await f.service.recoverUploadSession(f.request);
  assert.equal(result.upload.expiresAt, Math.floor((start + 24 * 60 * 60_000) / 1000));
  assert.equal(result.upload.resourceExpiresAt, result.upload.expiresAt);
});

test("failure to persist old cleanup rolls back recovery ownership before any new provider allocation", async () => {
  const f = await fixture();
  f.control.failOperation = true;
  await assert.rejects(f.service.recoverUploadSession(f.request), /operation storage unavailable/);
  assert.equal((await f.service.listAdminStatus({ productId }))[0].recovery, undefined);
  assert.equal(f.control.creations.length, 1);
  f.control.failOperation = false;
  assert.equal((await f.service.recoverUploadSession(f.request)).status, "recovering");
});

test("a lost issue-commit response does not delete the winning generation and same-key replay returns its grant", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = () => { f.control.loseCommitResponse = true; };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  const recovered = await f.service.recoverUploadSession(f.request);
  assert.equal(recovered.upload.headers.VideoId, "guid-2");
  assert.equal(f.control.creations.length, 2);
  assert.equal(f.control.deleted.has("guid-2"), false);
});

test("stale setup sweep captures a late-created generation without adopting it", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.control.beforeCreate = async () => { entered(); await gate; };
  const recovering = f.service.recoverUploadSession(f.request);
  await reached;
  f.control.now += 3_600_001;
  assert.equal((await f.service.recoverUploadSetups()).recovered, 1);
  release();
  await assert.rejects(recovering, error => error.statusCode === 503);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
  assert.equal((await f.service.listAdminStatus({ productId })).length, 1);
});

test("a recovery stalled in cleanup releases its initial reservation at the original deadline", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  f.control.now = start + 24 * 60 * 60_000;
  assert.equal((await f.service.recoverUploadSetups()).recovered, 1);
  assert.deepEqual(await f.service.listAdminStatus({ productId }), []);
  assert.equal(f.control.creations.length, 1);
});

test("late TUS success past the original deadline is compensated and cannot extend the slot lifetime", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.afterTus = () => { f.control.now = start + 24 * 60 * 60_000; };
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  assert.deepEqual(await f.service.listAdminStatus({ productId }), []);
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
});

test("guarded exact-marker discovery durably compensates uncertain recovery creation without enabling automatic orphan work", async () => {
  const f = await fixture({ allowOrphanCleanup: true });
  const pending = await f.service.recoverUploadSession(f.request);
  await f.drain();
  f.control.createError = new Error("create response lost");
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 503);
  f.control.orphan = { guid: "guid-2", title: `petyard-product-recovery:${pending.recoveryId}`,
    videoLibraryId: "754739", dateUploaded: new Date(f.control.now).toISOString(),
    status: 0, length: 0, storageSize: 0, encodeProgress: 0, availableResolutions: "" };
  const target = { videoId: f.request.videoId, recoveryId: pending.recoveryId };
  assert.deepEqual(await f.service.inspectUncertainCreation(target), { status: "candidate", providerGuid: "guid-2" });
  assert.deepEqual(await f.service.recoverUncertainCreation(target), { status: "cleanup_recorded" });
  await f.drain();
  assert.equal(f.control.deleted.has("guid-2"), true);
  assert.equal((await f.service.listAdminStatus({ productId })).length, 1);
  const disabled = await fixture();
  assert.deepEqual(await disabled.service.recoverUncertainCreation(target), { status: "not_enabled" });
});

test("a returned GUID already owned by another placement cannot be attached or compensated", async () => {
  const f = await fixture();
  await f.service.recoverUploadSession(f.request);
  await f.drain();
  await f.db.assets.create([{ ownerType: "product_video", ownerId: actorId,
    libraryId: "754739", providerGuid: "guid-2", technicalState: "ready" }]);
  await assert.rejects(f.service.recoverUploadSession(f.request), error => error.statusCode === 500 &&
    error.errors?.[0]?.code === "VIDEO_CLEANUP_PERSISTENCE_FAILED");
  assert.equal(f.control.deleted.has("guid-2"), false);
});

test("recovery HTTP uses protected Product routes and returns private pending then issued responses with upload flags off", async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  app.use("/products/:id/videos", createProductVideoRouter({ isUploadEnabled: () => false,
    getService: () => f.service, access: [(req, _res, next) => { req.user = { _id: actorId }; next(); }] }));
  app.use("/protected/:id/videos", createProductVideoRouter({ isUploadEnabled: () => false,
    getService: () => assert.fail("unauthenticated recovery reached the service") }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/products/${productId}/videos/${f.request.videoId}/upload-recovery`;
  const options = { method: "POST", headers: { "content-type": "application/json",
    "Idempotency-Key": f.request.idempotencyKey }, body: JSON.stringify({ file }) };
  try {
    const denied = await fetch(base + route.replace("/products/", "/protected/"), options);
    assert.equal(denied.status, 401);
    const invalid = await fetch(base + route, { ...options, body: JSON.stringify({ file, uploadUrl: "untrusted" }) });
    assert.equal(invalid.status, 400);
    assert.equal(f.control.jobs.length, 0);
    const pending = await fetch(base + route, options);
    assert.equal(pending.status, 202);
    assert.equal(pending.headers.get("cache-control"), "private, no-store");
    const pendingBody = await pending.json();
    assert.equal(pendingBody.data.status, "recovering");
    assert.equal(JSON.stringify(pendingBody).includes("guid-1"), false);
    await f.drain();
    const issued = await fetch(base + route, options);
    assert.equal(issued.status, 201);
    assert.equal((await issued.json()).data.upload.headers.VideoId, "guid-2");
    assert.equal(issued.headers.get("cache-control"), "private, no-store");
  } finally { await new Promise(resolve => server.close(resolve)); }
});
