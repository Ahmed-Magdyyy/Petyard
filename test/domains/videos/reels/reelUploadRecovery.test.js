import assert from "node:assert/strict";
import test from "node:test";

import { createReelUploadService } from "../../../../src/domains/videos/reels/reelUpload.service.js";
import { createReelUploadRecovery } from "../../../../src/domains/videos/reels/reelUploadRecovery.service.js";
import { createReelUploadRecoveryPersistence } from "../../../../src/domains/videos/reels/reelUploadRecovery.repository.js";
import { createVideoAssetAppliedHandler } from "../../../../src/domains/videos/provider/videoAssetAppliedHandler.js";

const videoId = "507f1f77bcf86cd799439011";
const sessionId = "507f1f77bcf86cd799439012";
const assetId = "507f1f77bcf86cd799439013";
const actorId = "507f191e810c19729de860ea";
const fixedNow = Date.UTC(2026, 8, 28, 12);

function query(value) { return { session: async () => value }; }

function fixture({ status = "issued", technicalState = "failed", assetPresent = true,
  current = true, enqueueFails = false, abandonAt = new Date(fixedNow - 1), providerStatus } = {}) {
  const events = [];
  const row = { _id: sessionId, videoId, actorId, safeFilename: "puppy.mp4",
    status, ...(assetPresent ? { assetId } : {}), abandonAt };
  const asset = assetPresent ? { _id: assetId, ownerType: "reel", ownerId: videoId,
    libraryId: "754739", providerGuid: "bunny-guid", technicalState, providerStatus } : null;
  const repository = createReelUploadRecoveryPersistence({ libraryId: "754739",
    now: () => fixedNow,
    withTransaction: async (work) => work({ mongo: true }),
    videos: { async updateOne(filter, update, options) {
      events.push("detach");
      assert.equal(filter.activeUploadSessionId, sessionId);
      assert.deepEqual(filter.activeAssetId, assetPresent ? assetId : { $exists: false });
      assert.equal(update.$unset.activeAssetId, "");
      assert.ok(options.session);
      return { modifiedCount: current ? 1 : 0 };
    } },
    sessions: {
      find(filter) {
        assert.equal(filter.status, "reserving");
        return { sort() { return this; }, limit() { return this; },
          async lean() { return status === "reserving" ? [row] : []; } };
      },
      findOne(filter) {
        if (filter.status !== status || (filter.assetId && filter.assetId !== row.assetId) ||
            (filter.abandonAt && abandonAt > fixedNow)) return query(null);
        return query(row);
      },
      async updateOne(_filter, update) {
        events.push("session-failed");
        assert.equal(update.$set.status, "failed");
        return { modifiedCount: 1 };
      },
    },
    assets: {
      findOne(filter) {
        const allowed = filter.technicalState?.$in || [filter.technicalState];
        return query(asset && allowed.includes(asset.technicalState) &&
          (filter.providerStatus === undefined || filter.providerStatus === asset.providerStatus) &&
          (filter.providerGuid === undefined || filter.providerGuid === asset.providerGuid) ? asset : null);
      },
      async updateOne(filter, update) {
        events.push("asset-deleting");
        assert.equal(filter.technicalState, technicalState);
        assert.equal(update.$set.technicalState, "deleting");
        return { modifiedCount: 1 };
      },
    },
    attempts: { async create(rows, options) {
      events.push("audit");
      assert.equal(rows[0].ownerType, "reel");
      assert.ok(options.session);
    } },
    recordOperation: async (spec) => {
      events.push("durable-cleanup");
      assert.equal(spec.type, "abandoned_upload_cleanup");
      assert.equal(spec.providerGuid, "bunny-guid");
      assert.ok(spec.session);
      return { _id: "operation-1" };
    },
    enqueue: async (id) => { events.push(`enqueue:${id}`);
      if (enqueueFails) throw new Error("redis offline"); },
  });
  const enqueue = async (id) => { events.push(`enqueue:${id}`);
    if (enqueueFails) throw new Error("redis offline"); };
  const recovery = createReelUploadRecovery({ repository, enqueue, now: () => fixedNow + 60 * 60_000 });
  return { repository, recovery, events, asset };

}

test("terminal Reel transcode failure detaches only the current draft after durable cleanup", async () => {
  const { recovery, events } = fixture();
  assert.deepEqual(await recovery.handleVerifiedAsset({ _id: assetId, ownerId: videoId,
    ownerType: "reel", technicalState: "failed" }), { status: "failed" });
  assert.deepEqual(events, ["detach", "asset-deleting", "durable-cleanup",
    "session-failed", "audit", "enqueue:operation-1"]);
});

test("a stale Reel asset cannot detach a newer active upload", async () => {
  const { recovery, events } = fixture({ current: false });
  assert.deepEqual(await recovery.handleVerifiedAsset({ _id: assetId, ownerId: videoId,
    ownerType: "reel", technicalState: "failed" }), { status: "stale" });
  assert.deepEqual(events, ["detach"]);
});

test("a ready Reel is never discarded by terminal-failure recovery", async () => {
  const { recovery, events } = fixture({ technicalState: "ready" });
  assert.deepEqual(await recovery.handleVerifiedAsset({ _id: assetId, ownerId: videoId,
    ownerType: "reel", technicalState: "failed" }), { status: "stale" });
  assert.deepEqual(events, []);
});

test("a Redis enqueue failure leaves the committed cleanup obligation sweepable", async () => {
  const { recovery, events } = fixture({ enqueueFails: true });
  assert.deepEqual(await recovery.handleVerifiedAsset({ _id: assetId, ownerId: videoId,
    ownerType: "reel", technicalState: "failed" }), { status: "failed" });
  assert.ok(events.includes("durable-cleanup"));
  assert.equal(events.at(-1), "enqueue:operation-1");
});

test("issued Reel abandonment requires provider absence and the original deadline", async () => {
  const early = fixture({ technicalState: "awaiting_upload",
    abandonAt: new Date(fixedNow + 60_000) });
  assert.equal(await early.recovery.handleMissingAsset({ _id: assetId, ownerId: videoId, ownerType: "reel", technicalState: "awaiting_upload" }), false);
  assert.deepEqual(early.events, []);
  const expired = fixture({ technicalState: "awaiting_upload" });
  assert.equal(await expired.recovery.handleMissingAsset({ _id: assetId, ownerId: videoId, ownerType: "reel", technicalState: "awaiting_upload" }), true);
  assert.deepEqual(expired.events.slice(-2), ["audit", "enqueue:operation-1"]);
});

test("an existing status-0 Reel upload is abandoned at its original deadline with durable cleanup", async () => {
  const { recovery, asset, events } = fixture({ technicalState: "awaiting_upload", providerStatus: 0 });
  assert.deepEqual(await recovery.handleVerifiedAsset(asset), { status: "abandoned" });
  assert.deepEqual(events, ["detach", "asset-deleting", "durable-cleanup",
    "session-failed", "audit", "enqueue:operation-1"]);
});

test("early and stale status-0 Reel observations cannot abandon the current upload", async () => {
  for (const options of [{ abandonAt: new Date(fixedNow + 1) }, { current: false }]) {
    const { recovery, asset, events } = fixture({ technicalState: "awaiting_upload", providerStatus: 0, ...options });
    assert.deepEqual(await recovery.handleVerifiedAsset(asset), { status: "stale" });
    assert.equal(events.includes("durable-cleanup"), false);
  }
});

test("a stale status-0 Reel callback cannot discard a processing or ready winner", async () => {
  for (const technicalState of ["processing", "ready"]) {
    const { recovery, asset, events } = fixture({ technicalState, providerStatus: 4 });
    assert.deepEqual(await recovery.handleVerifiedAsset({ ...asset,
      technicalState: "awaiting_upload", providerStatus: 0 }), { status: "stale" });
    assert.deepEqual(events, []);
  }
});

test("worker routing sends status-0 Reel snapshots to recovery while other unfinished snapshots stay in lifecycle", async () => {
  const { recovery, asset, events } = fixture({ technicalState: "awaiting_upload", providerStatus: 0 });
  const handle = createVideoAssetAppliedHandler({
    productVideos: { handleVerifiedAsset() { assert.fail("wrong owner"); } },
    reelVideos: { handleVerifiedAsset() { return { status: "not_ready" }; } },
    reelUploadRecovery: recovery,
  });
  assert.deepEqual(await handle({ ...asset, providerStatus: 2 }), { status: "not_ready" });
  assert.deepEqual(await handle(asset), { status: "abandoned" });
  assert.ok(events.includes("durable-cleanup"));
});

test("a stale unissued Reel reservation is released without a Bunny delete when no GUID exists", async () => {
  const { recovery, events } = fixture({ status: "reserving", assetPresent: false });
  const result = await recovery.recoverStaleSetups({ limit: 10 });
  assert.deepEqual(result, { examined: 1, recovered: 1, failed: 0 });
  assert.deepEqual(events, ["detach", "session-failed", "audit"]);
});

test("a stale Reel reservation with a recorded GUID creates durable cleanup", async () => {
  const { recovery, events } = fixture({ status: "reserving", technicalState: "awaiting_upload" });
  const result = await recovery.recoverStaleSetups({ limit: 10 });
  assert.equal(result.recovered, 1);
  assert.deepEqual(events.slice(0, 4), ["detach", "asset-deleting",
    "durable-cleanup", "session-failed"]);
});

test("a failed pre-issue Reel asset is also cleaned with its stale reservation", async () => {
  const { recovery, events } = fixture({ status: "reserving", technicalState: "failed" });
  const result = await recovery.recoverStaleSetups({ limit: 10 });
  assert.equal(result.recovered, 1);
  assert.ok(events.includes("durable-cleanup"));
});

test("worker-facing recovery routes failed Reel snapshots and bounds setup sweep", async () => {
  const calls = [];
  const recovery = createReelUploadRecovery({ now: () => fixedNow, repository: {
    async recoverStaleSetups(input) { calls.push(input); return { examined: 0, recovered: 0, failed: 0 }; },
    async commitTerminalFailure(input) { calls.push(input); return true; },
    async commitMissingUpload(input) { calls.push(input); return true; },
  } });
  const handle = createVideoAssetAppliedHandler({
    productVideos: { handleVerifiedAsset: () => ({ status: "product" }) },
    reelVideos: { handleVerifiedAsset: () => ({ status: "ready" }) },
    reelUploadRecovery: recovery,
  });
  assert.deepEqual(await handle({ _id: assetId, ownerId: videoId, ownerType: "reel",
    technicalState: "failed", safeFailureCode: "VIDEO_DURATION_EXCEEDED" }), { status: "failed" });
  assert.deepEqual(await handle({ ownerType: "reel", technicalState: "ready" }), { status: "ready" });
  assert.equal(await recovery.handleMissingAsset({ _id: assetId, ownerId: videoId,
    ownerType: "reel", technicalState: "awaiting_upload" }), true);
  await recovery.recoverStaleSetups({ limit: 2 });
  assert.deepEqual(calls[0], { assetId, videoId, failureCode: "VIDEO_DURATION_EXCEEDED" });
  assert.deepEqual(calls[1], { assetId, videoId });
  assert.deepEqual(calls[2], { before: new Date(fixedNow - 60 * 60_000), limit: 2 });
});


function cancellationService(repository, events) {
  return createReelUploadService({ repository: {
    reserve() { assert.fail("unused reservation"); }, attachProviderVideo() { assert.fail("unused attachment"); },
    issue() { assert.fail("unused issue"); }, failSetup() { assert.fail("unused setup"); }, ...repository,
  }, provider: { createVideo() { assert.fail("unused provider"); },
    createTusUpload() { assert.fail("unused provider"); }, createTusUploadAuthorization() { assert.fail("unused authorization"); } },
    enqueue: async () => { assert.equal(events.at(-1), "commit"); events.push("enqueue"); throw new Error("Redis offline"); },
  });
}

test("explicit Reel cancellation durably cleans a known asset and survives Redis failure", async () => {
  const events = [];
  const repository = createReelUploadRecoveryPersistence({ libraryId: "754739", now: () => fixedNow,
    withTransaction: async (work) => { const result = await work({ mongo: true });
      events.push("commit"); return result; },
    videos: { findOne(filter) { assert.equal(filter.authorId, actorId);
      return query({ status: "draft", activeUploadSessionId: sessionId, activeAssetId: assetId }); },
      async updateOne(filter) { assert.equal(filter.status, "draft");
        assert.equal(filter.activeUploadSessionId, sessionId); events.push("detach"); return { modifiedCount: 1 }; } },
    sessions: { findOne(filter) { assert.deepEqual(filter, { _id: sessionId, videoId });
      return query({ _id: sessionId, videoId, actorId, assetId, status: "issued", safeFilename: "puppy.mp4" }); },
      async updateOne(_filter, update) { assert.equal(update.$set.failureCode, "VIDEO_UPLOAD_CANCELLED");
        events.push("terminal-session"); return { modifiedCount: 1 }; } },
    assets: { findOne(filter) { assert.deepEqual(filter.$or[0].technicalState.$in, ["awaiting_upload", "processing", "failed"]);
      assert.equal(filter.ownerId, videoId); assert.equal(filter.libraryId, "754739");
      return query({ _id: assetId, providerGuid: "guid", technicalState: "processing" }); },
      async updateOne(filter, update) { assert.equal(filter.technicalState, "processing");
        assert.equal(update.$set.technicalState, "deleting"); events.push("asset-deleting"); return { modifiedCount: 1 }; } },
    attempts: { async create(rows) { assert.equal(rows[0].outcome, "cancelled"); events.push("audit"); } },
    recordOperation: async (spec) => { assert.ok(spec.session); assert.equal(spec.providerGuid, "guid");
      events.push("durable-delete"); return { _id: "operation-1" }; },
    enqueue: async () => { assert.equal(events.at(-1), "commit");
      events.push("enqueue"); throw new Error("Redis offline"); },
  });
  await cancellationService(repository, events).cancelUpload({ videoId, sessionId, actor: { id: actorId, role: "admin" } });
  assert.deepEqual(events, ["detach", "asset-deleting", "durable-delete", "terminal-session", "audit", "commit", "enqueue"]);
});

test("Reel cancellation rejects wrong authors, stale/ready/published sessions, but permits terminal replay", async () => {
  const cases = ["wrong-author", "stale", "ready", "published", "replay", "cleanup-failure"];
  for (const scenario of cases) {
    let enqueued = false;
    let detached = false;
    const repository = createReelUploadRecoveryPersistence({ libraryId: "754739", now: () => fixedNow,
      withTransaction: async (work) => work({ mongo: true }),
      videos: { findOne() { return query(scenario === "wrong-author" ? null : {
        status: scenario === "published" ? "published" : "draft", activeAssetId: assetId,
        activeUploadSessionId: scenario === "stale" ? "new-session" : sessionId }); },
        async updateOne() { detached = true; return { modifiedCount: 1 }; } },
      sessions: { findOne() { return query({ _id: sessionId, videoId, actorId, assetId,
        status: scenario === "replay" ? "failed" : "issued", failureCode: "VIDEO_UPLOAD_CANCELLED" }); } },
      assets: { findOne() { return query(scenario === "ready" ? null : {
        _id: assetId, providerGuid: "guid", technicalState: "processing" }); },
        async updateOne() { return { modifiedCount: 1 }; } },
      recordOperation: async () => { throw new Error("durability unavailable"); },
      enqueue: async () => { enqueued = true; },
    });
    const cancel = repository.cancelUpload({ videoId, sessionId, actor: { id: actorId, role: "admin" } });
    if (scenario === "replay") await cancel;
    else await assert.rejects(cancel, (error) => scenario === "cleanup-failure"
      ? error.message === "durability unavailable" : error.statusCode === (scenario === "wrong-author" ? 404 : 409));
    assert.equal(enqueued, false);
    assert.equal(detached, scenario === "cleanup-failure");
  }
});

test("cancelling a reservation before its GUID arrives leaves late-GUID compensation recoverable", async () => {
  const events = [];
  const repository = createReelUploadRecoveryPersistence({ libraryId: "754739", now: () => fixedNow,
    withTransaction: async (work) => work({ mongo: true }),
    videos: { findOne() { return query({ status: "draft", activeUploadSessionId: sessionId }); },
      async updateOne(filter) { assert.deepEqual(filter.activeAssetId, { $exists: false });
        events.push("detach"); return { modifiedCount: 1 }; } },
    sessions: { findOne() { return query({ _id: sessionId, videoId, actorId, status: "reserving" }); },
      async updateOne(_filter, update) { assert.equal(update.$set.status, "failed");
        events.push("failed-searchable-reservation"); return { modifiedCount: 1 }; } },
    assets: { findOne() { throw new Error("no GUID exists yet"); } },
    attempts: { async create(rows) { assert.equal(rows[0].outcome, "cancelled"); events.push("audit"); } },
    recordOperation: async () => { throw new Error("no known GUID to delete"); },
    enqueue: async () => { throw new Error("no cleanup operation yet"); },
  });
  await repository.cancelUpload({ videoId, sessionId, actor: { id: actorId, role: "superAdmin" } });
  assert.deepEqual(events, ["detach", "failed-searchable-reservation", "audit"]);
});

test("replacement cancellation/failure/abandonment detach only pending pointers and durably delete only the new GUID", async () => {
  for (const action of ["cancel", "cancel-in-review", "failure", "missing", "setup"]) {
    const events = [];
    const row = { _id: sessionId, videoId, actorId, purpose: "replacement", previousAssetId: "old-asset",
      assetId, status: action === "setup" ? "reserving" : "issued", safeFilename: "new.mp4",
      abandonAt: new Date(fixedNow - 1) };
    const video = { status: "published", activeAssetId: "old-asset", activeUploadSessionId: "old-session",
      pendingChange: { authorId: actorId, uploadSessionId: sessionId, assetId,
        status: action === "cancel-in-review" ? "in_review" : "draft" } };
    const cancelling = action.startsWith("cancel");
    const state = cancelling ? "ready" : action === "failure" ? "failed" : "awaiting_upload";
    const repository = createReelUploadRecoveryPersistence({ libraryId: "754739", now: () => fixedNow,
      withTransaction: async (work) => { const result = await work({ mongo: true }); events.push("commit"); return result; },
      videos: { findOne() { return query(video); }, async updateOne(filter, update) {
        assert.equal(filter.activeAssetId, "old-asset");
        assert.equal(filter["pendingChange.uploadSessionId"], sessionId);
        assert.equal(filter["pendingChange.assetId"], assetId);
        assert.ok(filter["pendingChange.status"].$in.includes("in_review"));
        assert.equal(update.$set["pendingChange.status"], "draft");
        assert.equal(update.$set["pendingChange.submittedAt"], null);
        assert.ok(!Object.hasOwn(update.$unset, "activeAssetId"));
        assert.ok(!Object.hasOwn(update.$unset, "pendingChange"));
        assert.equal(update.$unset["pendingChange.assetId"], ""); events.push("detach-pending"); return { modifiedCount: 1 }; } },
      sessions: { findOne() { return query(row); }, find() { return { sort() { return this; }, limit() { return this; },
        async lean() { return [row]; } }; },
        async updateOne(_filter, update) { assert.equal(update.$set.status, "failed"); return { modifiedCount: 1 }; } },
      assets: { findOne(filter) { assert.equal(filter._id, assetId); assert.equal(filter.ownerType, "reel");
        assert.equal(filter.ownerId, videoId); return query({ _id: assetId, providerGuid: "new-guid", technicalState: state }); },
        async updateOne(filter) { assert.equal(filter._id, assetId); assert.equal(filter.providerGuid, "new-guid");
          events.push("new-asset-deleting"); return { modifiedCount: 1 }; } },
      recordOperation: async (spec) => { assert.ok(spec.session); assert.equal(spec.assetId, assetId);
        assert.equal(spec.providerGuid, "new-guid"); events.push("durable-delete"); return { _id: "operation-1" }; },
      attempts: { async create(rows) { assert.equal(rows[0].outcome, cancelling ? "cancelled" : "failed"); } },
      enqueue: async () => { assert.equal(events.at(-1), "commit"); events.push("enqueue"); throw new Error("Redis unavailable"); },
    });
    const recovery = createReelUploadRecovery({ repository, now: () => fixedNow + 60 * 60_000,
      enqueue: async () => { assert.equal(events.at(-1), "commit"); events.push("enqueue"); throw new Error("Redis unavailable"); } });
    if (cancelling) await cancellationService(repository, events).cancelUpload({ videoId, sessionId,
      purpose: "replacement", actor: { id: actorId, role: "admin" } });
    if (action === "failure") assert.deepEqual(await recovery.handleVerifiedAsset({ _id: assetId, ownerId: videoId,
      ownerType: "reel", technicalState: "failed", safeFailureCode: "VIDEO_DURATION_EXCEEDED" }), { status: "failed" });
    if (action === "missing") assert.equal(await recovery.handleMissingAsset({ _id: assetId, ownerId: videoId,
      ownerType: "reel", technicalState: "awaiting_upload" }), true);
    if (action === "setup") assert.equal((await recovery.recoverStaleSetups({ limit: 5 })).recovered, 1);
    assert.deepEqual(events, ["detach-pending", "new-asset-deleting", "durable-delete", "commit", "enqueue"]);
    assert.equal(video.activeAssetId, "old-asset");
  }
});

test("replacement cancellation refuses wrong actors, wrong purpose, stale pending sessions and a changed active generation", async () => {
  for (const scenario of ["actor", "purpose", "session", "active"]) {
    const row = { _id: sessionId, videoId, actorId, purpose: "replacement", previousAssetId: "old-asset", assetId, status: "issued" };
    const video = { status: "published", activeAssetId: scenario === "active" ? "changed-active" : "old-asset",
      pendingChange: { authorId: actorId, uploadSessionId: scenario === "session" ? "newer-session" : sessionId,
        assetId, status: "draft" } };
    const repository = createReelUploadRecoveryPersistence({ libraryId: "754739", now: () => fixedNow,
      withTransaction: async (work) => work({ mongo: true }), videos: { findOne() { return query(video); },
        async updateOne() { throw new Error("must not detach"); } }, sessions: { findOne() { return query(row); } },
      assets: { findOne() { throw new Error("must not read/delete media"); } },
    });
    await assert.rejects(repository.cancelUpload({ videoId, sessionId, purpose: scenario === "purpose" ? "initial" : "replacement",
      actor: { id: scenario === "actor" ? "other-actor" : actorId, role: "admin" } }), (error) => error.statusCode === 409);
  }
});
