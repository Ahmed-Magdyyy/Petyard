import assert from "node:assert/strict";
import test from "node:test";

import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";

const videoId = "507f1f77bcf86cd799439011";
const sessionId = "507f1f77bcf86cd799439012";
const assetId = "507f1f77bcf86cd799439013";
const actorId = "507f191e810c19729de860ea";

function fakeConnection() {
  const session = { id: "mongo-session" };
  return { async startSession() { return {
    async withTransaction(work) { await work(); },
    async endSession() {},
  }; }, session };
}

function query(value) {
  return { session: async () => value };
}

test("a same-key retry while reserving returns status without reserving another Reel", async () => {
  const existing = { _id: sessionId, videoId, actorId, status: "reserving",
    requestFingerprint: null };
  let created;
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: {
      findOne() { return query(existing.requestFingerprint ? existing : null); },
      async create(rows) { created = rows[0]; existing.requestFingerprint = rows[0].requestFingerprint;
        existing._id = rows[0]._id; },
    },
    videos: { async findOneAndUpdate() { return { _id: videoId }; } },
  });
  const input = { videoId, actor: { id: actorId, role: "admin" },
    idempotencyKey: "reel-key-123", file: { filename: "puppy.mp4",
      mimeType: "video/mp4", sizeBytes: 1024 } };
  const first = await repository.reserve(input);
  assert.equal(first.newlyCreated, true);
  assert.equal(created.status, "reserving");
  assert.equal(created.providerTitle, `petyard-reel-session:${first.id}`);
  assert.equal(first.providerTitle, created.providerTitle);
  const retry = await repository.reserve(input);
  assert.deepEqual(retry, { id: first.id, status: "reserving", newlyCreated: false });
});

test("a concurrent same-key insert is re-read once as an idempotent reservation", async () => {
  let transactions = 0;
  const connection = { async startSession() { return {
    async withTransaction(work) {
      transactions += 1;
      if (transactions === 1) throw Object.assign(new Error("duplicate"), { code: 11000 });
      await work();
    },
    async endSession() {},
  }; } };
  let fingerprint;
  const repository = createReelUploadRepository({ libraryId: "754739", connection,
    sessions: { findOne() { return query({ _id: sessionId, videoId, actorId,
      status: "reserving", requestFingerprint: fingerprint }); } },
  });
  // Capture the same request fingerprint from an earlier reservation.
  const firstRepository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: { findOne() { return query(null); }, async create(rows) {
      fingerprint = rows[0].requestFingerprint; } },
    videos: { async findOneAndUpdate() { return { _id: videoId }; } },
  });
  const input = { videoId, actor: { id: actorId, role: "admin" },
    idempotencyKey: "reel-key-123", file: { filename: "puppy.mp4",
      mimeType: "video/mp4", sizeBytes: 1024 } };
  await firstRepository.reserve(input);
  const replay = await repository.reserve(input);
  assert.equal(replay.status, "reserving");
  assert.equal(transactions, 2);
});

test("failed setup records Reel-owned deletion before detaching the draft", async () => {
  const events = [];
  const row = { _id: sessionId, videoId, status: "reserving", assetId };
  const asset = { _id: assetId, ownerType: "reel", ownerId: videoId,
    libraryId: "754739", providerGuid: "video-guid-1" };
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: {
      findOne() { return query(row); },
      async updateOne(_filter, update) { events.push("session-failed");
        assert.equal(update.$set.status, "failed"); return { modifiedCount: 1 }; },
    },
    assets: {
      findOne() { return query(asset); },
      async updateOne(_filter, update) { events.push("asset-deleting");
        assert.equal(update.$set.technicalState, "deleting"); },
    },
    videos: { async updateOne(filter, update) { events.push("video-detached");
      assert.equal(filter.activeAssetId, assetId);
      assert.equal(update.$unset.activeAssetId, "");
      return { modifiedCount: 1 }; } },
    recordOperation: async (spec) => { events.push("operation-recorded");
      assert.equal(spec.type, "abandoned_upload_cleanup");
      assert.equal(spec.providerGuid, "video-guid-1");
      assert.ok(spec.session);
      return { _id: "operation-1" }; },
    enqueue: async (id) => { events.push(`enqueue:${id}`); },
    now: () => Date.UTC(2026, 8, 28, 12),
  });
  assert.deepEqual(await repository.failSetup({ sessionId, videoId, providerGuid: "video-guid-1" }), { operationId: "operation-1" });
  assert.deepEqual(events, ["asset-deleting", "operation-recorded",
    "video-detached", "session-failed"]);
});

test("provider creation followed by attachment failure still creates a cleanup obligation", async () => {
  const events = [];
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: {
      findOne() { return query({ _id: sessionId, videoId, status: "reserving" }); },
      async updateOne() { return { modifiedCount: 1 }; },
    },
    assets: { findOne() { return query(null); }, async create(rows) {
      events.push("synthetic-asset");
      assert.equal(rows[0].ownerType, "reel");
      assert.equal(rows[0].providerGuid, "video-guid-1");
      return [{ _id: assetId }];
    } },
    videos: { async updateOne() { events.push("detach-reservation");
      return { modifiedCount: 1 }; } },
    recordOperation: async ({ assetId: target, session }) => {
      assert.equal(target, assetId);
      assert.ok(session);
      events.push("durable-cleanup");
      return { _id: "operation-1" };
    },
    enqueue: async () => { events.push("enqueue"); },
  });
  assert.deepEqual(await repository.failSetup({ sessionId, videoId, providerGuid: "video-guid-1" }), { operationId: "operation-1" });
  assert.deepEqual(events, ["synthetic-asset", "durable-cleanup", "detach-reservation"]);
});

test("a GUID returned after stale-session recovery is cleaned without detaching a newer Reel", async () => {
  const events = [];
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: { findOne() { return query({ _id: sessionId, videoId, status: "failed" }); } },
    assets: {
      findOne() { return query(null); },
      async create(rows) { assert.equal(rows[0].providerGuid, "late-guid");
        events.push("synthetic-asset"); return [{ _id: assetId }]; },
    },
    videos: { async updateOne() { throw new Error("must not detach a newer session"); } },
    recordOperation: async ({ assetId: target, providerGuid, session }) => {
      assert.equal(target, assetId);
      assert.equal(providerGuid, "late-guid");
      assert.ok(session);
      events.push("durable-cleanup"); return { _id: "operation-1" };
    },
    enqueue: async () => { events.push("enqueue"); },
  });
  assert.deepEqual(await repository.failSetup({ sessionId, videoId, providerGuid: "late-guid" }), { operationId: "operation-1" });
  assert.deepEqual(events, ["synthetic-asset", "durable-cleanup"]);
});

test("late compensation is idempotent once its asset has deletion intent", async () => {
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: { findOne() { return query({ _id: sessionId, videoId, status: "failed" }); } },
    assets: { findOne() { return query({ _id: assetId, deletionRequestedAt: new Date() }); } },
    recordOperation: async () => { throw new Error("duplicate cleanup"); },
    enqueue: async () => { throw new Error("duplicate enqueue"); },
  });
  assert.deepEqual(await repository.failSetup({ sessionId, videoId, providerGuid: "late-guid" }), { operationId: null });
});

test("orphan search context is limited to failed, untracked, marked reservations", async () => {
  const providerTitle = `petyard-reel-session:${sessionId}`;
  const createdAt = new Date("2026-09-28T12:00:00Z");
  const failedAt = new Date("2026-09-28T13:00:00Z");
  const repository = createReelUploadRepository({ libraryId: "754739",
    sessions: { findOne(filter) {
      assert.equal(filter._id, sessionId);
      assert.equal(filter.status, "failed");
      assert.deepEqual(filter.assetId, { $exists: false });
      assert.deepEqual(filter.providerTitle, { $exists: true });
      return { async lean() { return { _id: sessionId, videoId,
        providerTitle, createdAt, failedAt }; } };
    } },
    assets: { async exists(filter) {
      assert.deepEqual(filter, { libraryId: "754739", providerGuid: "late-guid" });
      return null;
    } },
  });
  assert.deepEqual(await repository.getOrphanSearchContext(sessionId), {
    id: sessionId, videoId, providerTitle, createdAt, failedAt,
  });
  assert.equal(await repository.isGuidTracked("late-guid"), false);
});

test("confirmed orphan cleanup rechecks session and GUID, then records a durable delete", async () => {
  const events = [];
  const providerGuid = "orphan-guid";
  const row = { _id: sessionId, videoId,
    providerTitle: `petyard-reel-session:${sessionId}` };
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: {
      findOne(filter) { assert.equal(filter.status, "failed");
        assert.deepEqual(filter.assetId, { $exists: false });
        assert.equal(filter.providerTitle, row.providerTitle);
        return query(row); },
      async updateOne(filter, update, options) {
        events.push("session-claimed");
        assert.equal(filter._id, sessionId);
        assert.equal(update.$set.assetId, assetId);
        assert.ok(options.session);
        return { modifiedCount: 1 };
      },
    },
    assets: {
      findOne(filter) { assert.deepEqual(filter, { libraryId: "754739", providerGuid });
        return query(null); },
      async create(rows, options) { events.push("cleanup-asset");
        assert.equal(rows[0].technicalState, "deleting");
        assert.ok(rows[0].deletionRequestedAt instanceof Date);
        assert.ok(options.session);
        return [{ _id: assetId }]; },
    },
    recordOperation: async (input) => { events.push("durable-operation");
      assert.equal(input.type, "abandoned_upload_cleanup");
      assert.equal(input.providerGuid, providerGuid);
      assert.ok(input.session);
      return { _id: "operation-1" }; },
    enqueue: async (id) => { events.push(`enqueue:${id}`); },
  });
  assert.deepEqual(await repository.commitOrphanCleanup({ sessionId, providerGuid }), { operationId: "operation-1" });
  assert.deepEqual(events, ["cleanup-asset", "session-claimed",
    "durable-operation"]);
});

test("orphan cleanup does not claim a GUID already tracked by another asset", async () => {
  const providerGuid = "orphan-guid";
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: { findOne() { return query({ _id: sessionId, videoId,
      providerTitle: `petyard-reel-session:${sessionId}` }); } },
    assets: { findOne() { return query({ _id: assetId }); },
      async create() { throw new Error("must not allocate a cleanup asset"); } },
    recordOperation: async () => { throw new Error("must not record a delete"); },
  });
  assert.equal(await repository.commitOrphanCleanup({ sessionId, providerGuid }), false);
});

test("orphan cleanup cannot claim a session that changed after discovery", async () => {
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: { findOne() { return query(null); } },
    assets: { async create() { throw new Error("must not create an asset"); } },
    recordOperation: async () => { throw new Error("must not record cleanup"); },
  });
  assert.equal(await repository.commitOrphanCleanup({ sessionId,
    providerGuid: "orphan-guid" }), false);
});

test("orphan persistence returns the durable obligation without contacting Redis", async () => {
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(),
    sessions: {
      findOne() { return query({ _id: sessionId, videoId,
        providerTitle: `petyard-reel-session:${sessionId}` }); },
      async updateOne() { return { modifiedCount: 1 }; },
    },
    assets: { findOne() { return query(null); },
      async create() { return [{ _id: assetId }]; } },
    recordOperation: async () => ({ _id: "operation-1" }),
    enqueue: async () => { throw new Error("redis offline"); },
  });
  assert.deepEqual(await repository.commitOrphanCleanup({ sessionId,
    providerGuid: "orphan-guid" }), { operationId: "operation-1" });
});

test("issuing a Reel resource requires the reserved Video and records the attempt", async () => {
  const events = [];
  const repository = createReelUploadRepository({ libraryId: "754739",
    connection: fakeConnection(), now: () => Date.UTC(2026, 8, 28, 12),
    sessions: {
      findOne() { return query({ _id: sessionId, videoId, assetId, actorId,
        safeFilename: "puppy.mp4", status: "reserving" }); },
      async updateOne(_filter, update) { events.push("session-issued");
        assert.equal(update.$set.status, "issued"); return { modifiedCount: 1 }; },
    },
    videos: { findOne() { return query({ _id: videoId, activeAssetId: assetId }); } },
    assets: { async findOneAndUpdate(_filter, update) { events.push("resource-attached");
      assert.equal(update.$set.tusUploadUrl,
        "https://video.bunnycdn.com/tusupload/resource-1");
      return { _id: assetId }; } },
    attempts: { async create(rows) { events.push("attempt-recorded");
      assert.equal(rows[0].ownerType, "reel"); } },
  });
  const issued = await repository.issue({ sessionId, videoId, providerGuid: "video-guid-1",
    uploadUrl: "https://video.bunnycdn.com/tusupload/resource-1",
    resourceExpiresAt: Math.floor(Date.UTC(2026, 8, 28, 12) / 1000) + 21600 });
  assert.equal(issued.providerGuid, "video-guid-1");
  assert.deepEqual(events, ["resource-attached", "session-issued", "attempt-recorded"]);
});

test("Reel upload status scopes the author, session, immutable owner, and library in one transaction", async () => {
  const video = { _id: videoId, status: "draft", activeUploadSessionId: sessionId, activeAssetId: assetId };
  const row = { _id: sessionId, videoId, assetId, status: "issued" };
  let authorExists = true;
  let assetExists = true;
  const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    videos: { findOne(filter) { assert.equal(filter.authorId, actorId);
      assert.equal(filter.kind, "reel"); return query(authorExists ? video : null); } },
    sessions: { findOne(filter) { assert.deepEqual(filter, { _id: sessionId, videoId });
      return query(row); } },
    assets: { findOne(filter) { assert.deepEqual(filter, { _id: assetId,
      ownerType: "reel", ownerId: videoId, libraryId: "754739" }); return query(assetExists ? { _id: assetId } : null); } },
  });
  const input = { videoId, sessionId, actor: { id: actorId, role: "admin" } };
  assert.equal((await repository.getSessionContext(input)).isCurrent, true);
  assetExists = false;
  await assert.rejects(repository.getSessionContext(input), (error) => error.statusCode === 409);
  assetExists = true;
  video.activeUploadSessionId = "507f1f77bcf86cd799439014";
  assert.equal((await repository.getSessionContext(input)).isCurrent, false);
  authorExists = false;
  await assert.rejects(repository.getSessionContext(input), (error) => error.statusCode === 404);
});

test("a super-admin can recover the latest failed session without receiving provider credentials", async () => {
  const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    videos: { findOne(filter) { assert.ok(!("authorId" in filter)); return query({ _id: videoId }); } },
    sessions: { findOne(filter) { assert.deepEqual(filter, { videoId, purpose: { $ne: "replacement" } });
      return { sort(order) { assert.deepEqual(order, { createdAt: -1, _id: -1 });
        return query({ _id: sessionId, status: "failed", failureCode: "VIDEO_UPLOAD_CANCELLED" }); } }; } },
  });
  const context = await repository.getSessionContext({ videoId, actor: { id: actorId, role: "superAdmin" } });
  assert.equal(context.row.failureCode, "VIDEO_UPLOAD_CANCELLED");
  assert.equal(context.isCurrent, false);
});

test("issued same-key replay cannot grant credentials for a detached Reel generation", async () => {
  let requestFingerprint;
  const input = { videoId, actor: { id: actorId, role: "admin" }, idempotencyKey: "reel-key-123",
    file: { filename: "puppy.mp4", mimeType: "video/mp4", sizeBytes: 1024 } };
  await createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    videos: { async findOneAndUpdate() { return {}; } },
    sessions: { findOne() { return query(null); }, async create(rows) {
      requestFingerprint = rows[0].requestFingerprint; } },
  }).reserve(input);
  const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    sessions: { findOne() { return query({ _id: sessionId, actorId, assetId,
      status: "issued", requestFingerprint, abandonAt: new Date(Date.now() + 86400000) }); } },
    videos: { findOne(filter) { assert.equal(filter.activeUploadSessionId, sessionId);
      assert.equal(filter.activeAssetId, assetId); assert.equal(filter.status, "draft"); return query(null); } },
    assets: { findOne() { throw new Error("must not read stale credentials"); } },
  });
  await assert.rejects(repository.reserve(input), (error) => error.statusCode === 409);
});

test("replacement reservation, attachment and issue preserve the published generation and proposal metadata", async () => {
  let row;
  let video = { _id: videoId, kind: "reel", status: "published", revision: 7, activeAssetId: "old-asset",
    activeUploadSessionId: "old-session", title_en: "Original", title_ar: "أصلي",
    pendingChange: { authorId: actorId, status: "draft", content: { kind: "reel", title_en: "Proposed",
      title_ar: "جديد", description_en: "", description_ar: "" }, createdAt: new Date() } };
  let media;
  const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    videos: {
      findOne(filter) { assert.equal(filter._id, videoId); return query(video); },
      async findOneAndUpdate(filter, update, options) {
        assert.ok(options.session);
        assert.equal(filter.activeAssetId, "old-asset");
        assert.ok(!Object.hasOwn(update.$set, "activeAssetId"));
        if (update.$set.pendingChange) { assert.equal(filter.revision, 7); video = { ...video, pendingChange: update.$set.pendingChange }; }
        else { assert.equal(String(filter["pendingChange.uploadSessionId"]), String(row._id));
          assert.equal(filter["pendingChange.authorId"], actorId);
          video.pendingChange.assetId = update.$set["pendingChange.assetId"]; }
        video.revision += 1; return video;
      },
    },
    sessions: { findOne() { return query(row || null); },
      async create(rows) { row = rows[0]; },
      async updateOne(_filter, update) { Object.assign(row, update.$set); return { modifiedCount: 1 }; } },
    assets: { findOne(filter) { assert.equal(filter.libraryId, "754739");
      return query(filter._id === "old-asset" ? { _id: "old-asset", technicalState: "ready" } : media); },
      async create(rows) { assert.equal(rows[0].ownerType, "reel");
        assert.equal(rows[0].ownerId, videoId); media = { _id: assetId, ...rows[0] }; return [media]; },
      async findOneAndUpdate(filter, update) { assert.equal(filter._id, assetId);
        assert.equal(filter.providerGuid, "new-guid"); Object.assign(media, update.$set); return media; } },
    attempts: { async create(rows) { assert.equal(rows[0].assetId, assetId); } },
  });
  const input = { videoId, actor: { id: actorId, role: "admin" }, purpose: "replacement",
    idempotencyKey: "replacement-key", file: { filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 1024 } };
  const reserved = await repository.reserve(input);
  assert.equal(row.purpose, "replacement");
  assert.equal(row.previousAssetId, "old-asset");
  assert.equal(row.autoApplyWhenReady, false);
  assert.equal(row.providerTitle, `petyard-reel-session:${reserved.id}`);
  const replay = await repository.reserve(input);
  assert.equal(replay.newlyCreated, false);
  assert.equal(replay.id, reserved.id);
  await assert.rejects(repository.reserve({ ...input, purpose: "initial" }), (error) => error.statusCode === 409);
  await assert.rejects(repository.reserve({ ...input, file: { ...input.file, sizeBytes: 2048 } }),
    (error) => error.statusCode === 409);
  await repository.attachProviderVideo({ videoId, sessionId: reserved.id, providerGuid: "new-guid" });
  await repository.issue({ videoId, sessionId: reserved.id, providerGuid: "new-guid",
    uploadUrl: "https://video.bunnycdn.com/tusupload/new-resource", resourceExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(video.activeAssetId, "old-asset");
  assert.equal(video.activeUploadSessionId, "old-session");
  assert.equal(video.status, "published");
  assert.equal(video.title_en, "Original");
  assert.equal(video.pendingChange.content.title_en, "Proposed");
  assert.equal(String(video.pendingChange.uploadSessionId), reserved.id);
  assert.equal(video.pendingChange.assetId, assetId);
  assert.equal(row.status, "issued");
});

test("replacement reservation refuses competing proposals, assets, review locks and unavailable active media", async () => {
  for (const pending of [{ authorId: "someone-else", status: "draft" },
    { authorId: actorId, status: "in_review" }, { authorId: actorId, status: "draft", assetId },
    { authorId: actorId, status: "draft", uploadSessionId: sessionId }, null]) {
    const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
      sessions: { findOne() { return query(null); }, async create() { throw new Error("must not reserve"); } },
      videos: { findOne() { return query({ _id: videoId, activeAssetId: "old-asset", pendingChange: pending }); },
        async findOneAndUpdate() { throw new Error("must not mutate"); } },
      assets: { findOne() { return query(null); } },
    });
    await assert.rejects(repository.reserve({ videoId, actor: { id: actorId, role: "admin" }, purpose: "replacement",
      idempotencyKey: "replacement-key", file: { filename: "new.mp4", mimeType: "video/mp4", sizeBytes: 1024 } }),
    (error) => error.statusCode === 409);
  }
});

test("replacement status binds its session to the actor and never exposes a different purpose", async () => {
  const row = { _id: sessionId, videoId, actorId, assetId, purpose: "replacement", previousAssetId: "old-asset", status: "issued" };
  const video = { _id: videoId, status: "published", activeAssetId: "old-asset",
    pendingChange: { authorId: actorId, status: "draft", uploadSessionId: sessionId, assetId } };
  const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
    videos: { findOne(filter) { assert.ok(!Object.hasOwn(filter, "authorId")); return query(video); } },
    sessions: { findOne() { return query(row); } },
    assets: { findOne(filter) { assert.equal(filter.ownerId, videoId); return query({ _id: assetId }); } },
  });
  const input = { videoId, sessionId, actor: { id: actorId, role: "admin" }, purpose: "replacement" };
  assert.equal((await repository.getSessionContext(input)).isCurrent, true);
  await assert.rejects(repository.getSessionContext({ ...input, actor: { id: "other", role: "admin" } }),
    (error) => error.statusCode === 409);
  row.purpose = "initial";
  await assert.rejects(repository.getSessionContext(input), (error) => error.statusCode === 409);
});

test("unbound setup compensation never deletes a returned GUID that names referenced media", async () => {
  for (const reference of ["activeAssetId", "pendingChange.assetId"]) {
    const repository = createReelUploadRepository({ libraryId: "754739", connection: fakeConnection(),
      sessions: { findOne() { return query({ _id: sessionId, videoId, status: "reserving",
        purpose: "replacement", actorId, previousAssetId: "old-asset" }); } },
      assets: { findOne() { return query({ _id: assetId, providerGuid: "returned-guid" }); },
        async updateOne() { throw new Error("must not mark referenced media deleting"); } },
      videos: { findOne(filter) { assert.deepEqual(filter.$or, [{ activeAssetId: assetId }, { "pendingChange.assetId": assetId }]);
        return query({ [reference]: assetId }); }, async updateOne() { throw new Error("must not detach"); } },
      recordOperation: async () => { throw new Error("must not schedule deletion"); },
    });
    await assert.rejects(repository.failSetup({ videoId, sessionId, providerGuid: "returned-guid" }),
      (error) => error.statusCode === 409);
  }
});
