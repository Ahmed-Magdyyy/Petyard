import assert from "node:assert/strict";
import test from "node:test";

import { createReelOrphanDiscovery } from "../../../../src/domains/videos/reels/reelOrphanDiscovery.js";

const sessionId = "507f1f77bcf86cd799439012";
const marker = `petyard-reel-session:${sessionId}`;
const createdAt = new Date("2026-09-28T12:00:00Z");
const failedAt = new Date("2026-09-28T13:00:00Z");
const guid = "507f1f77-aaaa-bbbb-cccc-799439012000";

function setup({ context = { id: sessionId, providerTitle: marker, createdAt, failedAt },
  page = { items: [{ title: marker, guid }], totalItems: 1, currentPage: 1 },
  video = { guid, title: marker, videoLibraryId: 754739,
    dateUploaded: "2026-09-28T12:01:00Z", status: 0, length: 0,
    storageSize: 0, encodeProgress: 0, availableResolutions: null },
  tracked = false, allowCleanup = false, commitResult = true } = {}) {
  const calls = [];
  const discovery = createReelOrphanDiscovery({ libraryId: "754739", allowCleanup,
    enqueue: async (operationId) => {
      assert.equal(calls.at(-1), "commit");
      calls.push(`enqueue:${operationId}`);
      throw new Error("Redis unavailable");
    },
    repository: {
      async getOrphanSearchContext(id) { calls.push("load"); assert.equal(id, sessionId); return context; },
      async isGuidTracked(value) { calls.push("tracked"); assert.equal(value, guid); return tracked; },
      async commitOrphanCleanup(input) { calls.push("commit");
        assert.deepEqual(input, { sessionId, providerGuid: guid }); return commitResult; },
    },
    provider: {
      async searchReelReservation({ providerTitle }) { calls.push("search");
        assert.equal(providerTitle, marker); return page; },
      async getVideo(value) { calls.push("get"); assert.equal(value, guid); return video; },
      async deleteVideo() { throw new Error("discovery must never delete"); },
    },
  });
  return { discovery, calls };
}

test("exact empty Reel candidate is reported without deleting or recording cleanup", async () => {
  const { discovery, calls } = setup();
  assert.deepEqual(await discovery.inspect(sessionId), { status: "candidate", providerGuid: guid });
  assert.deepEqual(calls, ["load", "search", "get", "tracked"]);
});

test("unmarked or no-longer-failed sessions never query Bunny", async () => {
  const { discovery, calls } = setup({ context: null });
  assert.deepEqual(await discovery.inspect(sessionId), { status: "not_applicable" });
  assert.deepEqual(calls, ["load"]);
});

test("incomplete or duplicate search results fail closed", async () => {
  for (const page of [
    { items: [{ title: marker, guid }], totalItems: 2, currentPage: 1 },
    { items: [{ title: marker, guid }, { title: marker, guid: "other-guid" }],
      totalItems: 2, currentPage: 1 },
    { items: [{ title: marker, guid }], totalItems: 1, currentPage: 2 },
    { items: [{ title: marker, guid }], currentPage: 1 },
  ]) {
    const { discovery, calls } = setup({ page });
    assert.deepEqual(await discovery.inspect(sessionId), { status: "ambiguous" });
    assert.deepEqual(calls, ["load", "search"]);
  }
});

test("provider search with no exact marker is only an observation, not proof of absence", async () => {
  const { discovery, calls } = setup({ page: { items: [{ title: "Other", guid }],
    totalItems: 1, currentPage: 1 } });
  assert.deepEqual(await discovery.inspect(sessionId), { status: "no_match_observed" });
  assert.deepEqual(calls, ["load", "search"]);
});

test("the exact GET must prove identity, creation window, and no uploaded bytes", async () => {
  const baseline = setup();
  const valid = baseline.discovery;
  assert.equal((await valid.inspect(sessionId)).status, "candidate");
  const baseVideo = { guid, title: marker, videoLibraryId: 754739,
    dateUploaded: "2026-09-28T12:01:00Z", status: 0, length: 0,
    storageSize: 0, encodeProgress: 0, availableResolutions: null };
  for (const change of [
    { title: "Other" }, { videoLibraryId: 999 }, { status: 4 },
    { storageSize: 1 }, { length: 1 }, { encodeProgress: 1 },
    { availableResolutions: "360p" }, { dateUploaded: "2026-09-27T00:00:00Z" },
    { dateUploaded: "2026-09-28T14:00:00Z" },
  ]) {
    const { discovery, calls } = setup({ video: { ...baseVideo, ...change } });
    assert.deepEqual(await discovery.inspect(sessionId), { status: "requires_review" });
    assert.deepEqual(calls, ["load", "search", "get"]);
  }
});

test("a GUID already in PetYard is never returned as an orphan candidate", async () => {
  const { discovery } = setup({ tracked: true });
  assert.deepEqual(await discovery.inspect(sessionId), { status: "already_tracked" });
});

test("orphan cleanup stays disabled without any provider or database work", async () => {
  const { discovery, calls } = setup();
  assert.deepEqual(await discovery.recover(sessionId), { status: "not_enabled" });
  assert.deepEqual(calls, []);
});

test("opted-in recovery commits only an exact candidate and handles a stale local race", async () => {
  const found = setup({ allowCleanup: true });
  assert.deepEqual(await found.discovery.recover(sessionId), { status: "cleanup_recorded" });
  assert.deepEqual(found.calls, ["load", "search", "get", "tracked", "commit"]);
  const stale = setup({ allowCleanup: true, commitResult: false });
  assert.deepEqual(await stale.discovery.recover(sessionId), { status: "stale" });
  const ambiguous = setup({ allowCleanup: true, page: { items: [{ title: marker, guid }],
    totalItems: 2, currentPage: 1 } });
  assert.deepEqual(await ambiguous.discovery.recover(sessionId), { status: "ambiguous" });
  assert.deepEqual(ambiguous.calls, ["load", "search"]);
});

test("orphan cleanup queues only the committed obligation and survives a Redis outage", async () => {
  const found = setup({ allowCleanup: true, commitResult: { operationId: "cleanup-id" } });
  assert.deepEqual(await found.discovery.recover(sessionId), { status: "cleanup_recorded" });
  assert.deepEqual(found.calls, ["load", "search", "get", "tracked", "commit", "enqueue:cleanup-id"]);
});
