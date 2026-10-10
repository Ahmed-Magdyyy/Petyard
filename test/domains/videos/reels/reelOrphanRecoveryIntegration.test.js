import assert from "node:assert/strict";
import test from "node:test";

import { createReelOrphanDiscovery } from "../../../../src/domains/videos/reels/reelOrphanDiscovery.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation, listDueVideoProviderOperationIds } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createBunnyStreamAdapter } from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";

const libraryId = "754739";
const videoId = "507f1f77bcf86cd799439011";
const sessionId = "507f1f77bcf86cd799439012";
const providerGuid = "507f1f77-aaaa-bbbb-cccc-799439012000";
const marker = `petyard-reel-session:${sessionId}`;
const createdAt = new Date("2026-10-02T10:00:00Z");
const failedAt = new Date("2026-10-02T11:00:00Z");
const emptyVideo = { guid: providerGuid, title: marker, videoLibraryId: 754739,
  dateUploaded: "2026-10-02T10:01:00Z", status: 0, length: 0, storageSize: 0,
  encodeProgress: 0, availableResolutions: null };

function fixture({ seed = {}, allowCleanup = true } = {}) {
  // No editorial owner is seeded: permanently deleted Videos retain failed
  // reservations, and cleanup must not require resurrecting that owner.
  const db = replacementDatabase({ sessions: [{ _id: sessionId, videoId,
    status: "failed", providerTitle: marker, createdAt, failedAt }], ...seed });
  const control = { now: failedAt.getTime(), queueUnavailable: true, failOperation: false,
    queued: [], deleteStatus: null, afterTrackedRead: null, reads: 0,
    page: { items: [{ guid: providerGuid, title: marker }], totalItems: 1, currentPage: 1 },
    hosted: new Map([[providerGuid, { ...emptyVideo }], ["unrelated-guid", { ...emptyVideo,
      guid: "unrelated-guid", title: "Another video" }]]) };
  const assets = { ...db.assets, async exists(filter) {
    const result = await db.assets.exists(filter);
    if (control.afterTrackedRead) { const work = control.afterTrackedRead; control.afterTrackedRead = null; await work(); }
    return result;
  } };
  const enqueue = async (id) => {
    control.queued.push(String(id));
    if (control.queueUnavailable) throw new Error("Redis unavailable");
  };
  const operations = { ...db.operations, findOneAndUpdate(...args) {
    if (control.failOperation) throw new Error("Operation persistence failed");
    return db.operations.findOneAndUpdate(...args);
  } };
  const recordOperation = (input) => recordVideoProviderOperation({ now: new Date(control.now), ...input, model: operations });
  const repository = createReelUploadRepository({ libraryId, videos: db.placements,
    assets, sessions: db.sessions, attempts: db.attempts, connection: db.connection,
    recordOperation, now: () => control.now });
  const provider = {
    async searchReelReservation() { control.reads++; return structuredClone(control.page); },
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
  const discovery = createReelOrphanDiscovery({ libraryId, repository, provider, enqueue, allowCleanup });
  const runtime = createVideoProviderRuntime({ provider, enqueue, now: () => control.now,
    assets: createVideoAssetObserver({ model: db.assets, now: () => control.now }), operations: {
      claimById: (input) => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: (input) => completeVideoProviderOperation({ ...input, now: new Date(control.now), model: db.operations }),
      fail: (input) => failVideoProviderOperation({ ...input, now: new Date(control.now), random: () => 0, model: db.operations }),
      listDueIds: (input) => listDueVideoProviderOperationIds({ ...input, model: db.operations }),
    } });
  return { db, control, provider, discovery, runtime };
}

test("the captured unzoned Bunny timestamp remains an orphan candidate regardless of the host timezone", async () => {
  // Sanitized metadata and request times from the approved, cleaned live canary.
  const id = "bf5e53c69e12dac3ae09f07f";
  const title = `petyard-reel-session:${id}`;
  const guid = "ed494595-81ed-4e64-aba5-31f2fa69c97e";
  const video = { guid, title, videoLibraryId: 754739,
    dateUploaded: "2026-10-01T22:36:46.149", status: 0, length: 0,
    storageSize: 0, encodeProgress: 0, availableResolutions: null };
  const db = replacementDatabase({ sessions: [{ _id: id, videoId,
    status: "failed", providerTitle: title,
    createdAt: new Date("2026-10-01T22:36:45.899Z"),
    failedAt: new Date("2026-10-01T22:36:46.230Z") }] });
  const repository = createReelUploadRepository({ libraryId, videos: db.placements,
    assets: db.assets, sessions: db.sessions, attempts: db.attempts, connection: db.connection });
  const provider = createBunnyStreamAdapter({ libraryId, apiKey: "fake-key", requestTimeoutMs: 1000,
    http: async (url, options) => {
      assert.equal(options.method, "GET");
      const body = new URL(url).pathname.endsWith(`/${guid}`) ? video : {
        items: [{ guid, title }], totalItems: 1, currentPage: 1 };
      return { ok: true, status: 200, async json() { return structuredClone(body); } };
    } });
  const discovery = createReelOrphanDiscovery({ libraryId, repository, provider });
  assert.deepEqual(await discovery.inspect(id), { status: "candidate", providerGuid: guid });
});

test("Bunny UTC timestamps and explicit offsets preserve the same orphan creation instant", async () => {
  for (const dateUploaded of ["2026-10-02T10:01:00Z", "2026-10-02T13:01:00+03:00",
    "2026-10-02T06:01:00-04:00", "2026-10-02T10:01:00", "2026-10-02T10:01:00.1234567"]) {
    const { discovery, control } = fixture();
    control.hosted.set(providerGuid, { ...emptyVideo, dateUploaded });
    assert.deepEqual(await discovery.inspect(sessionId), { status: "candidate", providerGuid },
      String(dateUploaded));
  }
});

test("missing, malformed and out-of-window Bunny dates never authorize orphan adoption", async () => {
  for (const dateUploaded of [null, undefined, 0, {}, "", "2026-10-02",
    "2026-10-02 10:01:00", "2026-10-02T25:01:00", "2026-10-02T10:01:00+25:00",
    "2026-10-02T09:54:59", "2026-10-02T11:15:01", "2026-10-02T10:01:00+03:00"]) {
    const { discovery, control } = fixture();
    control.hosted.set(providerGuid, { ...emptyVideo, dateUploaded });
    assert.deepEqual(await discovery.inspect(sessionId), { status: "requires_review" }, String(dateUploaded));
    assert.deepEqual(await discovery.recover(sessionId), { status: "requires_review" });
  }
});

test("impossible Bunny calendar dates cannot normalize into the orphan creation window", async () => {
  for (const dateUploaded of ["2026-02-29T10:01:00Z", "2026-02-29T10:01:00",
    "2026-02-29T13:01:00+03:00"]) {
    const { discovery, control } = fixture({ seed: { sessions: [{ _id: sessionId, videoId,
      status: "failed", providerTitle: marker, createdAt: new Date("2026-03-01T10:00:00Z"),
      failedAt: new Date("2026-03-01T11:00:00Z") }] } });
    control.hosted.set(providerGuid, { ...emptyVideo, dateUploaded });
    assert.deepEqual(await discovery.inspect(sessionId), { status: "requires_review" }, dateUploaded);
    assert.deepEqual(await discovery.recover(sessionId), { status: "requires_review" });
  }
});

test("an exact orphan survives queue loss and is cleaned by the worker without an editorial owner", async () => {
  const { discovery, runtime, provider, control } = fixture();
  assert.deepEqual(await discovery.inspect(sessionId), { status: "candidate", providerGuid });
  assert.deepEqual(await discovery.recover(sessionId), { status: "cleanup_recorded" });
  assert.deepEqual(await discovery.inspect(sessionId), { status: "not_applicable" });
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
  control.queued = []; control.queueUnavailable = false;
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
  await assert.rejects(provider.getVideo(providerGuid), (error) => error.status === 404);
  assert.equal((await provider.getVideo("unrelated-guid")).title, "Another video");
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
});

test("repeat and concurrently started recovery cannot adopt the same reservation twice", async () => {
  const { discovery, runtime, control } = fixture();
  const results = await Promise.all([discovery.recover(sessionId), discovery.recover(sessionId)]);
  assert.equal(results.filter((result) => result.status === "cleanup_recorded").length, 1);
  assert.ok(results.some((result) => ["stale", "not_applicable", "already_tracked"].includes(result.status)));
  assert.deepEqual(await discovery.recover(sessionId), { status: "not_applicable" });
  assert.equal(control.queued.length, 1);
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 0, failed: 1 });
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
});

test("failed operation persistence rolls back adoption and leaves the same candidate recoverable", async () => {
  const { discovery, runtime, control } = fixture();
  control.failOperation = true;
  await assert.rejects(discovery.recover(sessionId), /Operation persistence failed/);
  assert.deepEqual(await discovery.inspect(sessionId), { status: "candidate", providerGuid });
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
  assert.equal(control.queued.length, 0);
  assert.equal(control.hosted.has(providerGuid), true);
  control.failOperation = false;
  assert.deepEqual(await discovery.recover(sessionId), { status: "cleanup_recorded" });
  assert.equal((await runtime.process(control.queued[0])).status, "completed");
});

test("a provider GUID tracked before or just after inspection is never adopted or deleted", async () => {
  const tracked = { _id: "607f1f77bcf86cd799439013", ownerType: "product",
    ownerId: "507f1f77bcf86cd799439019", libraryId, providerGuid, technicalState: "ready" };
  for (const race of [false, true]) {
    const { db, control, discovery, runtime } = fixture({ seed: { assets: race ? [] : [tracked] } });
    if (race) control.afterTrackedRead = () => db.assets.create([tracked]);
    assert.deepEqual(await discovery.recover(sessionId), { status: race ? "stale" : "already_tracked" });
    assert.equal(control.queued.length, 0);
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
    assert.equal(control.hosted.has(providerGuid), true);
  }
});

test("a reservation claimed between inspection and adoption never records cleanup for the stale candidate", async () => {
  const { db, control, discovery, runtime } = fixture();
  control.afterTrackedRead = () => db.sessions.updateOne({ _id: sessionId },
    { $set: { assetId: "607f1f77bcf86cd799439019" } });
  assert.deepEqual(await discovery.recover(sessionId), { status: "stale" });
  assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
  assert.equal(control.queued.length, 0); assert.equal(control.hosted.has(providerGuid), true);
});

test("provider rejection keeps the adopted orphan cleanup due until a worker retry succeeds", async () => {
  const { discovery, control, runtime, provider } = fixture();
  assert.deepEqual(await discovery.recover(sessionId), { status: "cleanup_recorded" });
  const id = control.queued[0]; control.deleteStatus = 429;
  assert.equal((await runtime.process(id)).status, "retryable");
  assert.equal((await provider.getVideo(providerGuid)).title, marker);
  assert.deepEqual(await discovery.recover(sessionId), { status: "not_applicable" });
  control.now += 60_000; control.deleteStatus = null; control.queueUnavailable = false;
  assert.deepEqual(await runtime.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.equal((await runtime.process(id)).status, "completed");
  await assert.rejects(provider.getVideo(providerGuid), (error) => error.status === 404);
});

test("ambiguous searches and non-empty or mismatched metadata never create a worker cleanup obligation", async () => {
  for (const [change, status] of [
    [{ page: { items: [{ guid: providerGuid, title: marker }], totalItems: 2, currentPage: 1 } }, "ambiguous"],
    [{ page: { items: [{ guid: providerGuid, title: marker }, { guid: "duplicate-guid", title: marker }], totalItems: 2, currentPage: 1 } }, "ambiguous"],
    [{ page: { items: [], totalItems: 0, currentPage: 1 } }, "no_match_observed"],
    ...[{ guid: "different-guid" }, { title: "Other" }, { videoLibraryId: 999 }, { storageSize: 1 },
      { status: 4 }, { length: 1 }, { encodeProgress: 1 }, { availableResolutions: "360p" },
      { dateUploaded: "2026-10-01T10:00:00Z" }].map((video) => [{ video }, "requires_review"]),
  ]) {
    const { discovery, control, runtime } = fixture();
    if (change.page) control.page = change.page;
    if (change.video) control.hosted.set(providerGuid, { ...emptyVideo, ...change.video });
    assert.deepEqual(await discovery.recover(sessionId), { status });
    assert.equal(control.queued.length, 0);
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
    assert.equal(control.hosted.has(providerGuid), true);
  }
});

test("default-off recovery and non-failed or already-bound reservations never touch Bunny", async () => {
  const disabled = fixture({ allowCleanup: false });
  assert.deepEqual(await disabled.discovery.recover(sessionId), { status: "not_enabled" });
  assert.equal(disabled.control.reads, 0);
  for (const fields of [{ status: "reserving" }, { status: "issued" }, { providerTitle: undefined },
    { assetId: "607f1f77bcf86cd799439019" }]) {
    const { discovery, control, runtime } = fixture({ seed: { sessions: [{ _id: sessionId,
      videoId, status: "failed", providerTitle: marker, createdAt, failedAt, ...fields }] } });
    assert.deepEqual(await discovery.recover(sessionId), { status: "not_applicable" });
    assert.equal(control.reads, 0);
    assert.deepEqual(await runtime.sweep(), { attempted: 0, queued: 0, failed: 0 });
  }
});
