import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { EditorialCoverModel } from "../../../../src/domains/videos/editorial/editorialCover.model.js";
import { createEditorialCoverRepository, createEditorialCoverReferencePersistence } from "../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialCoverService } from "../../../../src/domains/videos/editorial/editorialCover.service.js";
import { createEditorialCoverStore } from "../../../../src/domains/videos/editorial/editorialCover.store.js";
import { VideoProviderOperationModel } from "../../../../src/domains/videos/provider/videoProviderOperation.model.js";
import * as operations from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { uploadImage } from "../../../../src/shared/utils/imageUpload.js";

const videoId = "507f1f77bcf86cd799439011";
const actor = { id: "507f1f77bcf86cd799439012", role: "admin" };
const superAdmin = { id: "507f1f77bcf86cd799439099", role: "superAdmin" };
const start = new Date("2026-10-01T00:00:00Z");
const storage = { zone: "images", endpoint: "https://storage.bunnycdn.com", cdnBaseUrl: "https://images.example" };
const buffer = await sharp({ create: { width: 12, height: 20, channels: 3, background: "red" } }).jpeg().toBuffer();
const clone = (value) => value == null ? null : structuredClone(value);
const path = (row, key) => key.split(".").reduce((value, field) => value?.[field], row);

function matches(row, filter) {
  return row && Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matches(row, branch));
    const actual = path(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$in" in expected) return expected.$in.some((value) => String(value) === String(actual));
      if ("$lte" in expected) return actual instanceof Date && actual <= expected.$lte;
      if ("$gt" in expected) return actual instanceof Date && actual > expected.$gt;
    }
    return String(actual) === String(expected);
  });
}
function apply(row, changes) {
  Object.assign(row, changes.$set);
  for (const [key, value] of Object.entries(changes.$inc || {})) row[key] = (row[key] || 0) + value;
  for (const key of Object.keys(changes.$unset || {})) delete row[key];
  return clone(row);
}
function query(read) {
  return { session() { return this; }, lean() { return Promise.resolve().then(read); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } };
}

function fixture() {
  let state = { videos: [{ _id: videoId, kind: "youtube", status: "published", revision: 0,
    authorId: actor.id, youtubeId: "dQw4w9WgXcQ", title_en: "Original", title_ar: "أصلي",
    description_en: "", description_ar: "", pendingChange: null }], covers: [], operations: [] };
  let inTransaction = false;
  const control = { now: start.getTime(), failReserve: false, failOperation: false,
    failUploadRecord: false, failConfirm: false, loseUploadAck: false,
    putError: false, deleteError: false, changedZone: false, duringPut: null, duringDelete: null, afterList: null,
    afterReserve: null, afterUploadRecord: null, events: [], objects: new Set(), queueCalls: 0 };
  const connection = { async startSession() { return {
    async withTransaction(work) {
      const snapshot = clone(state);
      assert.equal(inTransaction, false);
      inTransaction = true;
      try { await work(); } catch (error) { state = snapshot; throw error; }
      finally { inTransaction = false; }
    }, async endSession() {},
  }; } };
  function collection(name) {
    return {
      findOne(filter) { return query(() => clone(state[name].find((row) => matches(row, filter)))); },
      findById(id) { return query(() => clone(state[name].find((row) => row._id === id))); },
      findOneAndUpdate(filter, changes, options = {}) { return query(async () => {
        let row = state[name].find((candidate) => matches(candidate, filter));
        if (!row && options.upsert) {
          row = { _id: `607f1f77bcf86cd799${String(state[name].length + 1).padStart(6, "0")}`, ...changes.$setOnInsert };
          state[name].push(row);
        }
        if (!row) return null;
        if (name === "covers" && changes.$set?.state === "uploaded" && control.failUploadRecord) throw new Error("Mongo unavailable");
        if (name === "covers" && changes.$set?.state === "deleted" && control.failConfirm) throw new Error("Mongo unavailable");
        const result = apply(row, changes);
        if (name === "covers" && changes.$set?.state === "uploaded") {
          control.afterUploadRecord?.(row);
          if (control.loseUploadAck) throw new Error("Mongo response lost");
        }
        return result;
      }); },
      async updateOne(filter, changes) {
        assert.equal(inTransaction, true);
        const row = state[name].find((candidate) => matches(candidate, filter));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        apply(row, changes);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      find(filter) { let maximum = 100;
        return { sort() { return this; }, limit(value) { maximum = value; return this; }, select() { return this; },
          async lean() {
            const found = clone(state[name].filter((row) => matches(row, filter)).slice(0, maximum));
            if (name === "covers") control.afterList?.();
            return found;
          } };
      },
    };
  }
  const covers = { ...collection("covers"), async create(rows) {
    assert.equal(inTransaction, true);
    if (control.failReserve) throw new Error("Mongo unavailable");
    const document = new EditorialCoverModel({ _id: `507f1f77bcf86cd799${String(state.covers.length + 439013).padStart(6, "0")}`, ...rows[0] });
    await document.validate();
    const row = document.toObject({ flattenObjectIds: true });
    state.covers.push(row);
    control.events.push("reserved");
    control.afterReserve?.();
    return [clone(row)];
  } };
  const operationModel = collection("operations");
  const recordOperation = async (input) => {
      assert.equal(inTransaction, true);
      if (control.failOperation) throw new Error("operation persistence failed");
      const { type, coverId, dedupeKey } = input;
      const document = new VideoProviderOperationModel({ type, coverId, dedupeKey });
      await document.validate();
      return operations.recordVideoProviderOperation({ ...input, model: operationModel });
  };
  const enqueue = async () => {
      assert.equal(inTransaction, false);
      control.queueCalls++;
      throw new Error("Redis unavailable");
  };
  const videos = collection("videos");
  const repository = createEditorialCoverRepository({ covers, videos, connection, recordOperation, enqueue });
  const coverReferences = createEditorialCoverReferencePersistence({ covers, videos, recordOperation });
  const store = createEditorialCoverStore({ configuration: () => ({ publicProvider: "bunny",
    public: { ...storage, zone: control.changedZone ? "different-images" : storage.zone,
      accessKey: "not-to-be-persisted" }, storageTimeoutMs: 15000 }),
    upload: (file, options) => uploadImage(file, { ...options, bunnyUpload: async (input) => {
      assert.equal(inTransaction, false);
      assert.equal(state.covers.find((cover) => input.objectKey.includes(String(cover._id))).state, "uploading");
      control.events.push("PUT");
      control.objects.add(input.objectKey);
      await control.duringPut?.();
      if (control.putError) throw new Error("response lost with secret provider details");
    } }), async remove(input) {
      assert.equal(inTransaction, false);
      control.events.push("DELETE");
      if (control.deleteError) throw new Error("private storage response and credentials");
      control.objects.delete(input.objectKey);
      await control.duringDelete?.();
    },
  });
  const application = createEditorialCoverService({ repository, store, enqueue, now: () => new Date(control.now) });
  const videoRepository = createEditorialVideoRepository({ videos, connection, coverReferences, enqueue, reelLifecycle: {} });
  const editorial = createEditorialVideoService({ repository: videoRepository, covers: application, enqueue,
    verifyYouTube: async () => {}, now: () => new Date(control.now) });
  const runtime = createVideoProviderRuntime({ provider: { async deleteVideo() { assert.fail("not Stream media"); },
    async getVideo() { assert.fail("not Stream media"); } }, assets: {}, covers: application,
    operations: {
      claimById: (input) => operations.claimVideoProviderOperationById({ ...input, model: operationModel }),
      complete: (input) => operations.completeVideoProviderOperation({ ...input, now: new Date(control.now), model: operationModel }),
      fail: (input) => operations.failVideoProviderOperation({ ...input, now: new Date(control.now), random: () => 0.5, model: operationModel }),
      listDueIds: (input) => operations.listDueVideoProviderOperationIds({ ...input, model: operationModel }),
      recordEnqueueFailure: (input) => operations.recordVideoProviderEnqueueFailure({ ...input, model: operationModel }),
    }, async enqueue() { throw new Error("Redis unavailable"); }, now: () => control.now,
  });
  return { application, editorial, videoRepository, repository, runtime, control, state: () => state,
    upload: () => application.stageUpload({ videoId, actor, buffer }),
    advance(milliseconds = 5 * 60_000) { control.now += milliseconds; },
    retryTime() { control.now = state.operations[0].nextAttemptAt.getTime(); },
    process: () => runtime.process(state.operations[0]._id),
  };
}

test("admin cover and metadata changes stay private until one approval promotes both", async () => {
  const f = fixture();
  const edited = await f.editorial.editCover({ id: videoId, actor, buffer });
  const coverId = f.state().covers[0]._id;
  assert.equal(edited.coverUrl, null);
  assert.equal(edited.pendingChange.coverUrl, f.state().covers[0].descriptor.url);
  assert.equal(edited.pendingChange.content.coverId, coverId);
  assert.equal(f.state().covers[0].state, "attached");
  await f.editorial.editVideo({ id: videoId, actor, input: { title_en: "Revised" } });
  assert.equal(f.state().videos[0].pendingChange.content.coverId, coverId);
  assert.equal(f.state().videos[0].title_en, "Original");
  await f.editorial.submit({ id: videoId, actor });
  const applied = await f.editorial.approve({ id: videoId, actor: superAdmin });
  assert.equal(applied.activeCoverId, coverId);
  assert.equal(applied.title_en, "Revised");
  assert.equal(applied.status, "published");
  assert.equal(applied.pendingChange, null);
  assert.equal(f.state().operations.length, 0);
  assert.equal((await f.editorial.getAdmin({ id: videoId, actor })).coverUrl, edited.pendingChange.coverUrl);
});

test("super-admin replacement and removal retire only unreferenced covers with durable operations", async () => {
  const f = fixture();
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  const first = f.state().covers[0]._id;
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  const second = f.state().covers[1]._id;
  assert.equal(f.state().videos[0].activeCoverId, second);
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().operations[0].coverId, first);
  const removed = await f.editorial.editCover({ id: videoId, actor: superAdmin, remove: true });
  assert.equal(removed.activeCoverId, null);
  assert.equal(removed.coverUrl, null);
  assert.equal(f.state().covers[1].state, "deleting");
  assert.equal(f.state().operations.length, 2);
  assert.equal(f.control.queueCalls, 2);
});

test("replacing or cancelling a cover proposal never retires the active public cover", async () => {
  const f = fixture();
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  const active = f.state().videos[0].activeCoverId;
  await f.editorial.editCover({ id: videoId, actor, buffer });
  const discarded = f.state().videos[0].pendingChange.content.coverId;
  await f.editorial.editCover({ id: videoId, actor, buffer });
  assert.equal(f.state().covers.find((cover) => cover._id === discarded).state, "deleting");
  await assert.rejects(f.editorial.cancelPendingChange({ id: videoId,
    actor: { ...actor, id: superAdmin.id } }), (error) => error.statusCode === 403);
  await f.editorial.cancelPendingChange({ id: videoId, actor });
  assert.equal(f.state().videos[0].activeCoverId, active);
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().covers[2].state, "deleting");
  assert.equal(f.state().operations.length, 2);
});

test("reviewed cover removal survives metadata edits and approval restores the provider fallback", async () => {
  const f = fixture();
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  await f.editorial.editCover({ id: videoId, actor, remove: true });
  await f.editorial.editVideo({ id: videoId, actor, input: { title_en: "No custom cover" } });
  assert.equal(f.state().videos[0].pendingChange.content.coverId, null);
  assert.equal(f.state().covers[0].state, "attached");
  await f.editorial.submit({ id: videoId, actor });
  await f.editorial.approve({ id: videoId, actor: superAdmin });
  assert.equal(f.state().videos[0].activeCoverId, null);
  assert.equal(f.state().covers[0].state, "deleting");
});

test("stale edits clean their unused generation and never overwrite another edit", async () => {
  const f = fixture();
  f.control.duringPut = () => { f.state().videos[0].revision++; f.state().videos[0].title_en = "Concurrent"; };
  await assert.rejects(f.editorial.editCover({ id: videoId, actor, buffer }), (error) => error.statusCode === 409);
  assert.equal(f.state().videos[0].title_en, "Concurrent");
  assert.equal(f.state().videos[0].pendingChange, null);
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().operations.length, 1);
});

test("failed retirement persistence rolls back the public switch and leaves staged cleanup recoverable", async () => {
  const f = fixture();
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  const active = f.state().videos[0].activeCoverId;
  f.control.failOperation = true;
  await assert.rejects(f.editorial.editCover({ id: videoId, actor: superAdmin, buffer }), /operation persistence failed/);
  assert.equal(f.state().videos[0].activeCoverId, active);
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().covers[1].state, "uploaded");
  assert.equal(f.state().operations.length, 0);
  f.control.failOperation = false; f.advance();
  assert.deepEqual(await f.application.recoverUnattached(), { examined: 1, scheduled: 1, failed: 0 });
  assert.equal(f.state().covers[1].state, "deleting");
});

test("cover edits enforce review ownership and automatic authority before uploading", async () => {
  for (const scenario of ["review", "otherAuthor", "automaticAdmin"]) {
    const f = fixture();
    if (scenario === "review") f.state().videos[0].status = "in_review";
    if (scenario === "otherAuthor") f.state().videos[0].pendingChange = { status: "draft", authorId: superAdmin.id };
    if (scenario === "automaticAdmin") Object.assign(f.state().videos[0], { kind: "reel", status: "draft", autoPublishWhenReady: true });
    await assert.rejects(f.editorial.editCover({ id: videoId, actor, buffer }));
    assert.deepEqual(f.control.events, []);
  }
  const f = fixture();
  f.state().videos[0].kind = "reel";
  f.state().videos[0].pendingChange = { authorId: superAdmin.id, status: "draft", autoApplyWhenReady: true,
    content: { kind: "reel", title_en: "Original", title_ar: "أصلي" } };
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  assert.equal(f.state().videos[0].pendingChange.content.coverId, f.state().videos[0].activeCoverId);
  await f.editorial.editVideo({ id: videoId, actor: superAdmin, input: { title_en: "Changed" } });
  assert.equal(f.state().videos[0].pendingChange.content.coverId, f.state().videos[0].activeCoverId);
  assert.equal(f.state().videos[0].pendingChange.content.title_en, "Changed");
});

test("cover attachment refuses expired, deleting, foreign-owner and foreign-actor generations", async () => {
  for (const fault of ["expiry", "deleting", "owner", "actor"]) {
    const f = fixture(); const staged = await f.upload();
    const cover = f.state().covers[0];
    if (fault === "expiry") cover.unattachedExpiresAt = start;
    if (fault === "deleting") cover.state = "deleting";
    if (fault === "owner") cover.videoId = superAdmin.id;
    if (fault === "actor") cover.actorId = superAdmin.id;
    await assert.rejects(f.videoRepository.replaceWithCovers(videoId, 0,
      { activeCoverId: staged._id }, { actorId: actor.id, now: start }), (error) => error.statusCode === 409);
    assert.equal(f.state().videos[0].activeCoverId, undefined);
    assert.equal(f.state().videos[0].revision, 0);
  }
});

test("metadata proposals can reuse an active cover without deleting it on cancellation or approval", async () => {
  const f = fixture();
  await f.editorial.editCover({ id: videoId, actor: superAdmin, buffer });
  const active = f.state().videos[0].activeCoverId;
  await f.editorial.editVideo({ id: videoId, actor, input: { title_en: "First" } });
  await f.editorial.cancelPendingChange({ id: videoId, actor });
  await f.editorial.editVideo({ id: videoId, actor, input: { title_en: "Second" } });
  await f.editorial.submit({ id: videoId, actor });
  await f.editorial.approve({ id: videoId, actor: superAdmin });
  assert.equal(f.state().videos[0].activeCoverId, active);
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().operations.length, 0);
});

test("cover staging persists the immutable generation before PUT and never stores access keys", async () => {
  const f = fixture();
  const cover = await f.upload();
  assert.deepEqual(f.control.events, ["reserved", "PUT"]);
  assert.equal(cover.state, "uploaded");
  assert.equal(cover.actorId, actor.id);
  assert.equal(cover.videoId, videoId);
  assert.deepEqual(cover.storage, storage);
  assert.equal(cover.uploadSettledAt.getTime(), start.getTime());
  assert.equal(JSON.stringify(f.state()).includes("not-to-be-persisted"), false);
  assert.equal(f.state().videos[0].activeCoverId, undefined);
});

test("role, invalid image, owner and reservation failures prevent any cover PUT", async () => {
  const f = fixture();
  for (const candidate of [null, { id: actor.id, role: "user" }, { role: "admin" }]) {
    await assert.rejects(f.application.stageUpload({ videoId, actor: candidate, buffer }), (error) => error.statusCode === 403);
  }
  await assert.rejects(f.application.stageUpload({ videoId, actor, buffer: Buffer.from("broken") }), (error) => error.statusCode === 422);
  await assert.rejects(f.application.stageUpload({ videoId: actor.id, actor, buffer }), /OWNER_NOT_FOUND/);
  f.control.failReserve = true;
  await assert.rejects(f.upload());
  assert.deepEqual(f.control.events, []);
  assert.deepEqual(f.state().covers, []);
});

test("lost PUT acknowledgement persists cleanup despite Redis failure and does not guess settlement", async () => {
  const f = fixture(); f.control.putError = true;
  await assert.rejects(f.upload(), (error) => error.statusCode === 502 && !error.message.includes("secret"));
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().covers[0].uploadSettledAt, undefined);
  assert.equal(f.state().operations[0].type, "cover_cleanup");
  assert.equal(f.state().operations[0].assetId, undefined);
  assert.equal(f.state().operations[0].providerGuid, undefined);
  assert.equal(f.control.queueCalls, 1);
  assert.deepEqual(await f.runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.control.objects.size, 0);
  assert.equal(f.state().operations[0].lastErrorCode, "VIDEO_COVER_UPLOAD_UNSETTLED");
  assert.equal(f.state().covers[0].state, "deleting");
});

test("an uncertain crashed upload remains recoverable and reaches needs_attention without losing its obligation", async () => {
  const f = fixture(); f.control.putError = true;
  await assert.rejects(f.upload());
  for (let attempt = 1; attempt <= 10; attempt++) {
    assert.deepEqual(await f.process(), { status: "retryable" });
    f.retryTime();
  }
  assert.equal(f.state().operations[0].status, "needs_attention");
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().operations[0].purgeAt, undefined);
});

test("successful PUT followed by persistence failure schedules exact-key cleanup and can finish", async () => {
  const f = fixture(); f.control.failUploadRecord = true;
  await assert.rejects(f.upload(), (error) => error.errors[0].code === "VIDEO_COVER_PERSISTENCE_FAILED");
  assert.ok(f.state().covers[0].uploadSettledAt instanceof Date);
  assert.deepEqual(await f.process(), { status: "completed" });
  assert.equal(f.state().covers[0].state, "deleted");
  assert.equal(f.control.objects.size, 0);
});

test("cleanup intent and operation roll back together when durable persistence fails", async () => {
  const f = fixture(); const cover = await f.upload(); f.control.failOperation = true;
  await assert.rejects(f.repository.requestCleanup({ coverId: cover._id, now: start }));
  assert.equal(f.state().covers[0].state, "uploaded");
  assert.equal(f.state().covers[0].deletionRequestedAt, undefined);
  assert.equal(f.state().operations.length, 0);
  assert.equal(f.control.queueCalls, 0);
  assert.equal(f.control.events.includes("DELETE"), false);
});

test("expiry discovers successful unattached uploads at the deadline and finishes through the existing runtime", async () => {
  const f = fixture(); await f.upload(); f.advance(5 * 60_000 - 1);
  assert.deepEqual(await f.application.recoverUnattached(), { examined: 0, scheduled: 0, failed: 0 });
  f.advance(1);
  assert.deepEqual(await f.application.recoverUnattached(), { examined: 1, scheduled: 1, failed: 0 });
  assert.deepEqual(await f.process(), { status: "completed" });
  assert.equal(f.state().covers[0].descriptor, undefined);
  assert.equal(f.state().operations[0].status, "completed");
  assert.equal(f.control.objects.size, 0);
});

test("active and pending references prevent both recovery and direct cleanup scheduling", async () => {
  for (const pending of [false, true]) {
    const f = fixture(); const cover = await f.upload(); f.advance();
    if (pending) f.state().videos[0].pendingChange = { content: { coverId: cover._id } };
    else f.state().videos[0].activeCoverId = cover._id;
    assert.deepEqual(await f.application.recoverUnattached(), { examined: 1, scheduled: 0, failed: 0 });
    assert.equal(await f.application.discardUnused({ coverId: cover._id }), false);
    assert.equal(f.control.events.includes("DELETE"), false);
    assert.equal(f.state().operations.length, 0);
  }
});

test("cleanup also checks references after an operation has already been recorded", async () => {
  const f = fixture(); const cover = await f.upload();
  await f.repository.requestCleanup({ coverId: cover._id, now: start });
  f.state().videos[0].activeCoverId = cover._id;
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.state().operations[0].lastErrorCode, "VIDEO_COVER_DELETE_NOT_AUTHORIZED");
  assert.equal(f.control.events.includes("DELETE"), false);
});

test("a stale expiry candidate is rechecked after attachment rather than retired", async () => {
  const f = fixture(); const cover = await f.upload(); f.advance();
  f.control.afterList = () => {
    f.state().covers[0].state = "attached";
    f.state().videos[0].activeCoverId = cover._id;
  };
  assert.deepEqual(await f.application.recoverUnattached(), { examined: 1, scheduled: 0, failed: 0 });
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().operations.length, 0);
});

test("an upload settling after an expired-generation DELETE requires a second DELETE before completion", async () => {
  const f = fixture();
  f.control.duringPut = async () => {
    f.advance();
    await f.application.recoverUnattached();
    assert.deepEqual(await f.process(), { status: "retryable" });
    // Simulate a delayed PUT committing after the first DELETE.
    f.control.objects.add(`petyard/video-covers/${f.state().covers[0]._id}.webp`);
  };
  await assert.rejects(f.upload(), (error) => error.statusCode === 503);
  assert.equal(f.state().covers[0].state, "deleting");
  assert.ok(f.state().covers[0].uploadSettledAt instanceof Date);
  f.retryTime();
  assert.deepEqual(await f.process(), { status: "completed" });
  assert.equal(f.control.objects.size, 0);
  assert.equal(f.control.events.filter((event) => event === "DELETE").length, 2);
});

test("settlement written during DELETE cannot retroactively make that DELETE final", async () => {
  const f = fixture(); f.control.putError = true; await assert.rejects(f.upload());
  f.control.duringDelete = () => {
    f.state().covers[0].uploadSettledAt = new Date(f.control.now);
    f.control.objects.add(`petyard/video-covers/${f.state().covers[0]._id}.webp`);
  };
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.control.objects.size, 1);
  f.control.duringDelete = null; f.retryTime();
  assert.deepEqual(await f.process(), { status: "completed" });
  assert.equal(f.control.objects.size, 0);
});

test("lost Mongo upload acknowledgement never deletes a generation already adopted by a Video", async () => {
  const f = fixture(); f.control.loseUploadAck = true;
  f.control.afterUploadRecord = (row) => { row.state = "attached"; f.state().videos[0].activeCoverId = row._id; };
  await assert.rejects(f.upload());
  f.advance(); await f.application.recoverUnattached();
  assert.equal(f.state().covers[0].state, "attached");
  assert.equal(f.state().operations.length, 0);
  assert.equal(f.control.events.includes("DELETE"), false);
});

test("a failed cleanup persistence acknowledgement is retried rather than guessed complete", async () => {
  const f = fixture(); const cover = await f.upload();
  await f.repository.requestCleanup({ coverId: cover._id, now: start });
  f.control.failConfirm = true;
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.state().operations[0].status, "pending");
  f.control.failConfirm = false; f.retryTime();
  assert.deepEqual(await f.process(), { status: "completed" });
});

test("captured storage identity blocks PUT and DELETE against a newly configured zone", async () => {
  const f = fixture(); f.control.afterReserve = () => { f.control.changedZone = true; };
  await assert.rejects(f.upload());
  assert.deepEqual(f.control.events, ["reserved"]);
  assert.ok(f.state().covers[0].uploadSettledAt instanceof Date);
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.control.events.includes("DELETE"), false);
  f.control.changedZone = false; f.retryTime();
  assert.deepEqual(await f.process(), { status: "completed" });
});

test("descriptor mismatch cannot publish a client-controlled or another generation's URL", async () => {
  const f = fixture(); const cover = await f.upload();
  await assert.rejects(f.repository.recordUploaded({ coverId: cover._id, now: start,
    descriptor: { public_id: cover.descriptor.public_id, url: "https://elsewhere.example/fake.webp" } }), /DESCRIPTOR_MISMATCH/);
  assert.equal(f.state().covers[0].descriptor.url, cover.descriptor.url);
});

test("cover sweeps reject invalid bounds before reading persistence", async () => {
  const f = fixture();
  for (const limit of [0, 101, 1.5, "1"]) await assert.rejects(f.application.recoverUnattached({ limit }), RangeError);
  await assert.rejects(f.repository.recoverUnattached({ now: new Date("invalid") }), TypeError);
});

test("cleanup rejection retains both media identity and safe retryable work", async () => {
  const f = fixture(); const cover = await f.upload();
  await f.repository.requestCleanup({ coverId: cover._id, now: start });
  f.control.deleteError = true;
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.state().operations[0].lastErrorCode, "VIDEO_COVER_CLEANUP_FAILED");
  assert.equal(JSON.stringify(f.state().operations).includes("credentials"), false);
  assert.equal(f.state().covers[0].state, "deleting");
  assert.equal(f.control.objects.size, 1);
  f.control.deleteError = false; f.retryTime();
  assert.deepEqual(await f.process(), { status: "completed" });
});

test("a stale cover worker cannot complete an expired lease and the same operation is safely reclaimed", async () => {
  const f = fixture(); const cover = await f.upload();
  await f.repository.requestCleanup({ coverId: cover._id, now: start });
  f.control.duringDelete = () => { f.advance(); f.control.duringDelete = null; };
  assert.deepEqual(await f.process(), { status: "stale" });
  assert.equal(f.state().operations[0].status, "running");
  assert.deepEqual(await f.process(), { status: "completed" });
  assert.equal(f.state().covers[0].state, "deleted");
  assert.equal(f.control.events.filter((event) => event === "DELETE").length, 2);
});

test("failed compensation persistence leaves the reservation discoverable instead of issuing an untracked DELETE", async () => {
  const f = fixture(); f.control.putError = true; f.control.failOperation = true;
  await assert.rejects(f.upload());
  assert.equal(f.state().covers[0].state, "uploading");
  assert.equal(f.state().operations.length, 0);
  assert.equal(f.control.events.includes("DELETE"), false);
  f.control.failOperation = false; f.advance();
  assert.deepEqual(await f.application.recoverUnattached(), { examined: 1, scheduled: 1, failed: 0 });
  assert.deepEqual(await f.process(), { status: "retryable" });
  assert.equal(f.state().operations[0].lastErrorCode, "VIDEO_COVER_UPLOAD_UNSETTLED");
});

test("cover operation schema enforces image-only identity and leaves Stream fields required for old types", async () => {
  const target = { type: "cover_cleanup", coverId: actor.id, dedupeKey: "cover-test" };
  await new VideoProviderOperationModel(target).validate();
  for (const invalid of [{ ...target, coverId: undefined }, { ...target, providerGuid: "dummy" },
    { ...target, assetId: videoId }, { ...target, libraryId: "754739" },
    { type: "delete", coverId: actor.id, dedupeKey: "invalid" }]) {
    await assert.rejects(new VideoProviderOperationModel(invalid).validate());
  }
  assert.equal(EditorialCoverModel.schema.indexes().some(([, options]) => options.expireAfterSeconds != null), false);
  await assert.rejects(new EditorialCoverModel({ videoId, actorId: actor.id,
    storage: { ...storage, accessKey: "must-not-be-stored" }, unattachedExpiresAt: start }).validate());
});
