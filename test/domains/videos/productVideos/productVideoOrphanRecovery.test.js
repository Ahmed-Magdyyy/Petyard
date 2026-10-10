import assert from "node:assert/strict";
import test from "node:test";
import { createProductVideoService } from "../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation, listDueVideoProviderOperationIds } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "./fixtures/replacementDatabase.js";

const libraryId = "754739";
const productId = "507f191e810c19729de860ea";
const videoId = "507f1f77bcf86cd799439011";
const batchId = "507f1f77bcf86cd799439012";
const replacementId = "507f1f77bcf86cd799439013";
const actorId = "507f1f77bcf86cd799439014";
const providerGuid = "507f1f77-aaaa-bbbb-cccc-799439012000";
const createdAt = new Date("2026-10-02T10:00:00Z");
const failedAt = new Date("2026-10-02T11:00:00Z");

function fixture({ replacement = false, seed = {}, allowOrphanCleanup = true } = {}) {
  const marker = replacement ? `petyard-product-replacement:${replacementId}` : `petyard-product-video:${videoId}`;
  const emptyVideo = { guid: providerGuid, title: marker, videoLibraryId: 754739,
    dateUploaded: "2026-10-02T10:01:00Z", status: 0, length: 0, storageSize: 0,
    encodeProgress: 0, availableResolutions: null };
  let control;
  const db = replacementDatabase({
    placements: [{ _id: videoId, productId, uploadBatchId: batchId, position: 0,
      activeSlot: false, lifecycleState: "failed", createdAt, removedAt: failedAt }],
    batches: [{ _id: batchId, productId, actorId, status: "failed", createdAt, failedAt,
      failureCode: "VIDEO_PROVIDER_UNAVAILABLE" }],
    replacements: replacement ? [{ _id: replacementId, productId, videoId, actorId,
      status: "failed", createdAt, finishedAt: failedAt, failureCode: "VIDEO_PROVIDER_UNAVAILABLE" }] : [],
    ...seed,
  }, { now: () => control?.now ?? failedAt.getTime() });
  control = { now: failedAt.getTime(), failOperation: false, queueUnavailable: true,
    afterTrackedRead: null, beforeCommit: null, reads: 0, queued: [], deleteStatus: null,
    page: { items: [{ guid: providerGuid, title: marker }], totalItems: 1, currentPage: 1 },
    hosted: new Map([[providerGuid, emptyVideo], ["current-guid", { guid: "current-guid", title: "Current video" }]]) };
  const assets = { ...db.assets, async exists(filter) {
    const result = await db.assets.exists(filter);
    if (control.afterTrackedRead) { const work = control.afterTrackedRead; control.afterTrackedRead = null; await work(); }
    return result;
  } };
  const operations = { ...db.operations, findOneAndUpdate(...args) {
    if (control.failOperation) throw new Error("Operation persistence failed");
    return db.operations.findOneAndUpdate(...args);
  } };
  const enqueue = async (id) => {
    control.queued.push(String(id));
    if (control.queueUnavailable) throw new Error("Redis unavailable");
  };
  const provider = {
    async searchProductReservation() { control.reads++; return structuredClone(control.page); },
    async getVideo(guid) {
      control.reads++;
      if (!control.hosted.has(guid)) throw { status: 404 };
      return structuredClone(control.hosted.get(guid));
    },
    async deleteVideo(guid) {
      if (control.deleteStatus) throw { status: control.deleteStatus };
      control.hosted.delete(guid);
    },
  };
  const connection = { async startSession() {
    const session = await db.connection.startSession();
    return { ...session, async withTransaction(work) {
      return session.withTransaction(async () => {
        await work();
        if (control.beforeCommit) await control.beforeCommit();
      });
    } };
  } };
  const repository = createProductVideoRepository({ ...db, connection, assets, libraryId,
    recordOperation: (input) => recordVideoProviderOperation({ ...input, model: operations, now: new Date(control.now) }),
    now: () => control.now });
  const application = createProductVideoService({ repository, provider, allowOrphanCleanup,
    now: () => control.now, enqueue, invalidateCaches: async () => assert.fail("An orphan never changes visible product media") });
  const runtime = createVideoProviderRuntime({ provider, enqueue, now: () => control.now,
    assets: createVideoAssetObserver({ model: db.assets, now: () => control.now,
      onDeleted: (asset) => application.handleDeletedAsset(asset) }), operations: {
      claimById: (input) => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: (input) => completeVideoProviderOperation({ ...input, now: new Date(control.now), model: db.operations }),
      fail: (input) => failVideoProviderOperation({ ...input, now: new Date(control.now), random: () => 0, model: db.operations }),
      listDueIds: (input) => listDueVideoProviderOperationIds({ ...input, model: db.operations }),
    } });
  return { db, repository, application, provider, control, runtime, target: { videoId, ...(replacement ? { replacementId } : {}) } };
}

test("initial orphan cleanup commits a durable obligation after product deletion and survives Redis loss", async () => {
  const { application, runtime, provider, control, target } = fixture();
  assert.deepEqual(await application.recoverUncertainCreation(target), { status: "cleanup_recorded" });
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "not_applicable" });
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
  control.queued = []; control.queueUnavailable = false;
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
  await assert.rejects(provider.getVideo(providerGuid), (error) => error.status === 404);
  assert.equal((await provider.getVideo("current-guid")).title, "Current video");
  assert.deepEqual(await application.listAdminStatus({ productId }), []);
});

test("failed replacement cleanup binds only the old reservation and preserves the ready video and newer pending upload", async () => {
  const { application, runtime, provider, control, target } = fixture({ replacement: true, seed: {
    placements: [{ _id: videoId, productId, position: 0, activeSlot: true, lifecycleState: "ready",
      activeAssetId: batchId, pendingAssetId: actorId, replacementId: productId }],
    assets: [{ _id: batchId, ownerType: "product_video", ownerId: videoId, libraryId,
      providerGuid: "current-guid", technicalState: "ready" },
    { _id: actorId, ownerType: "product_video", ownerId: videoId, libraryId,
      providerGuid: "successor-guid", technicalState: "awaiting_upload" }],
  } });
  control.hosted.set("successor-guid", { guid: "successor-guid", title: "New pending upload" });
  const before = await application.listAdminStatus({ productId });
  assert.deepEqual(await application.recoverUncertainCreation(target), { status: "cleanup_recorded" });
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "not_applicable" });
  assert.deepEqual(await application.listAdminStatus({ productId }), before);
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
  await assert.rejects(provider.getVideo(providerGuid), (error) => error.status === 404);
  assert.equal((await provider.getVideo("current-guid")).title, "Current video");
  assert.equal((await provider.getVideo("successor-guid")).title, "New pending upload");
  assert.deepEqual(await application.listAdminStatus({ productId }), before);
});

test("concurrent and repeated recovery records at most one cleanup per initial or replacement reservation", async () => {
  for (const replacement of [false, true]) {
    const { application, runtime, control, target } = fixture({ replacement });
    const results = await Promise.all([application.recoverUncertainCreation(target), application.recoverUncertainCreation(target)]);
    assert.equal(results.filter((result) => result.status === "cleanup_recorded").length, 1);
    assert.ok(results.some((result) => ["stale", "not_applicable", "already_tracked"].includes(result.status)));
    assert.equal(control.queued.length, 1);
    assert.deepEqual(await application.recoverUncertainCreation(target), { status: "not_applicable" });
    assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
  }
});

test("operation persistence failure rolls back the asset and reservation binding without enqueueing", async () => {
  for (const replacement of [false, true]) {
    const { application, runtime, control, target } = fixture({ replacement });
    control.failOperation = true;
    await assert.rejects(application.recoverUncertainCreation(target), /Operation persistence failed/);
    assert.deepEqual(await application.inspectUncertainCreation(target), { status: "candidate", providerGuid });
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
    assert.deepEqual(control.queued, []);
    control.failOperation = false;
    assert.deepEqual(await application.recoverUncertainCreation(target), { status: "cleanup_recorded" });
    assert.equal((await runtime.process(control.queued[0])).status, "completed");
  }
});

test("already-tracked and newly claimed provider GUIDs never become orphan cleanup obligations", async () => {
  const tracked = { _id: actorId, ownerType: "reel", ownerId: productId, libraryId,
    providerGuid, technicalState: "ready" };
  for (const replacement of [false, true]) {
    for (const race of [false, true]) {
      const { db, application, control, runtime, target } = fixture({ replacement, seed: { assets: race ? [] : [tracked] } });
      if (race) control.afterTrackedRead = () => db.assets.create([tracked]);
      assert.deepEqual(await application.recoverUncertainCreation(target), { status: race ? "stale" : "already_tracked" });
      assert.deepEqual(control.queued, []);
      assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
      assert.equal(control.hosted.has(providerGuid), true);
    }
  }
});

test("a reservation claimed or changed after inspection cannot authorize stale cleanup", async () => {
  for (const [replacement, collection, fields] of [
    [false, "placements", { activeSlot: true, lifecycleState: "ready", activeAssetId: actorId }],
    [false, "placements", { activeAssetId: actorId }],
    [false, "batches", { status: "issued", issuedAt: failedAt }],
    [false, "batches", { failedAt: new Date(failedAt.getTime() + 1000) }],
    [true, "replacements", { assetId: actorId }],
    [true, "replacements", { status: "issued", issuedAt: failedAt }],
    [true, "replacements", { finishedAt: new Date(failedAt.getTime() + 1000) }],
  ]) {
    const { db, application, runtime, control, target } = fixture({ replacement });
    const id = collection === "placements" ? videoId : collection === "batches" ? batchId : replacementId;
    control.afterTrackedRead = () => db[collection].updateOne({ _id: id }, { $set: fields });
    assert.deepEqual(await application.recoverUncertainCreation(target), { status: "stale" });
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
    assert.deepEqual(control.queued, []);
    assert.equal(control.hosted.has(providerGuid), true);
  }
});

test("ambiguous searches and non-empty provider media cannot create cleanup work", async () => {
  for (const change of ["partial", "duplicate", "no_match", "non_empty"]) {
    const { application, runtime, control, target } = fixture();
    let expected;
    if (change === "non_empty") {
      control.hosted.get(providerGuid).storageSize = 1; expected = "requires_review";
    } else if (change === "no_match") {
      control.page = { items: [], totalItems: 0, currentPage: 1 }; expected = "no_match_observed";
    } else if (change === "duplicate") {
      control.page.items.push({ ...control.page.items[0], guid: "duplicate-guid" });
      control.page.totalItems = 2; expected = "ambiguous";
    } else { control.page.totalItems = 2; expected = "ambiguous"; }
    assert.deepEqual(await application.recoverUncertainCreation(target), { status: expected });
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
    assert.deepEqual(control.queued, []);
  }
});

test("provider rejection retains the recorded obligation for worker retry", async () => {
  const { application, runtime, provider, control, target } = fixture();
  assert.deepEqual(await application.recoverUncertainCreation(target), { status: "cleanup_recorded" });
  const id = control.queued[0]; control.deleteStatus = 429;
  assert.equal((await runtime.process(id)).status, "retryable");
  assert.equal((await provider.getVideo(providerGuid)).guid, providerGuid);
  control.now += 60_000; control.deleteStatus = null; control.queueUnavailable = false;
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.equal((await runtime.process(id)).status, "completed");
  await assert.rejects(provider.getVideo(providerGuid), (error) => error.status === 404);
});

test("cleanup is disabled by default and performs no provider or queue work", async () => {
  const { repository, provider, control } = fixture();
  const application = createProductVideoService({ repository, provider,
    enqueue: async () => assert.fail("Disabled recovery must not enqueue"),
    invalidateCaches: async () => assert.fail("Disabled recovery must not invalidate caches") });
  assert.deepEqual(await application.recoverUncertainCreation(null), { status: "not_enabled" });
  assert.equal(control.reads, 0);
  assert.deepEqual(control.queued, []);
});

test("cleanup is enqueued only after the transaction successfully commits", async () => {
  const { application, control, target } = fixture();
  let reached;
  let release;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  control.beforeCommit = async () => { reached(); await gate; };
  const recovery = application.recoverUncertainCreation(target);
  await waiting;
  try { assert.deepEqual(control.queued, []); } finally { release(); }
  assert.deepEqual(await recovery, { status: "cleanup_recorded" });
  assert.equal(control.queued.length, 1);
});

test("a rejected database commit leaves no binding, operation or queue dispatch", async () => {
  const { application, control, runtime, target } = fixture();
  control.beforeCommit = async () => { throw new Error("Transaction commit failed"); };
  await assert.rejects(application.recoverUncertainCreation(target), /Transaction commit failed/);
  assert.deepEqual(control.queued, []);
  assert.deepEqual(await application.inspectUncertainCreation(target), { status: "candidate", providerGuid });
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
});

test("late provider responses after orphan adoption cannot reattach or duplicate the cleanup obligation", async () => {
  for (const replacement of [false, true]) {
    const seed = replacement ? {
      products: [{ _id: productId }], replacements: [],
      placements: [{ _id: videoId, productId, position: 0, activeSlot: true,
        lifecycleState: "ready", activeAssetId: batchId, showInReelsFeed: true }],
      assets: [{ _id: batchId, ownerType: "product_video", ownerId: videoId, libraryId,
        providerGuid: "current-guid", technicalState: "ready" }],
    } : { products: [{ _id: productId }], placements: [], batches: [], replacements: [] };
    const { application, provider, control, runtime } = fixture({ seed });
    let reached;
    let release;
    let marker;
    let tusRequests = 0;
    const waiting = new Promise((resolve) => { reached = resolve; });
    provider.createVideo = ({ title }) => {
      marker = title; reached(); return new Promise((resolve) => { release = () => resolve({ guid: providerGuid }); });
    };
    provider.createTusUpload = async () => { tusRequests++; throw new Error("Late setup must not reach TUS creation"); };
    const file = { clientId: "selected", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 };
    const upload = replacement ? application.createReplacementUploadSession({ productId, videoId, actorId,
      idempotencyKey: "late-orphan-001", file }) : application.createUploadSessions({ productId, actorId,
      idempotencyKey: "late-orphan-001", files: [file] });
    await waiting;
    try {
      control.now += 60 * 60 * 1000;
      assert.deepEqual(await application.recoverUploadSetups(), { examined: 1, recovered: 1, failed: 0 });
      const target = replacement ? { videoId, replacementId: marker.split(":")[1] } : { videoId: marker.split(":")[1] };
      control.page = { items: [{ guid: providerGuid, title: marker }], totalItems: 1, currentPage: 1 };
      Object.assign(control.hosted.get(providerGuid), { title: marker, dateUploaded: "2026-10-02T11:00:00Z" });
      assert.deepEqual(await application.recoverUncertainCreation(target), { status: "cleanup_recorded" });
    } finally { release(); }
    await assert.rejects(upload, (error) => error.statusCode === 503);
    assert.equal(tusRequests, 0);
    assert.equal(new Set(control.queued).size, 1);
    assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
    assert.equal((await runtime.process(control.queued[0])).status, "completed");
    const status = await application.listAdminStatus({ productId });
    assert.equal(status.length, replacement ? 1 : 0);
    if (replacement) {
      assert.equal(status[0].status, "ready");
      assert.equal(status[0].replacement, undefined);
      assert.equal((await provider.getVideo("current-guid")).title, "Current video");
    }
  }
});

test("a late initial-create response cannot schedule deletion of another owner's tracked GUID", async () => {
  const { db, application, provider, control, runtime } = fixture({
    seed: { products: [{ _id: productId }], placements: [], batches: [], replacements: [] },
  });
  let marker;
  let reached;
  let release;
  const waiting = new Promise((resolve) => { reached = resolve; });
  provider.createVideo = ({ title }) => {
    marker = title; reached(); return new Promise((resolve) => { release = () => resolve({ guid: providerGuid }); });
  };
  const upload = application.createUploadSessions({ productId, actorId, idempotencyKey: "foreign-guid-001",
    files: [{ clientId: "selected", filename: "demo.mp4", mimeType: "video/mp4", sizeBytes: 100 }] });
  upload.catch(() => {});
  await waiting;
  try {
    control.now += 60 * 60 * 1000;
    await application.recoverUploadSetups();
    await db.assets.create([{ _id: actorId, ownerType: "reel", ownerId: batchId, libraryId,
      providerGuid, technicalState: "ready" }]);
    control.page = { items: [{ guid: providerGuid, title: marker }], totalItems: 1, currentPage: 1 };
    Object.assign(control.hosted.get(providerGuid), { title: marker, dateUploaded: "2026-10-02T11:00:00Z" });
    assert.deepEqual(await application.recoverUncertainCreation({ videoId: marker.split(":")[1] }),
      { status: "already_tracked" });
  } finally { release(); }
  await assert.rejects(upload, (error) => error.statusCode === 500 &&
    error.errors[0].code === "VIDEO_CLEANUP_PERSISTENCE_FAILED");
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
  assert.deepEqual(control.queued, []);
  assert.equal((await provider.getVideo(providerGuid)).guid, providerGuid);
});
