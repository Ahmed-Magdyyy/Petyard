import assert from "node:assert/strict";
import test from "node:test";
import { createVideoOrphanRecovery } from "../../../../src/domains/videos/provider/videoOrphanRecovery.service.js";
import { createProductVideoRepository } from "../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";

const productId = "507f1f77bcf86cd799439011";
const sessionId = "507f1f77bcf86cd799439012";
const recoveryId = "507f1f77bcf86cd799439013";
const now = Date.parse("2026-10-08T12:00:00Z");
const candidate = (target, age) => ({ target, updatedAt: new Date(now - age) });
function fixture({ product = [], reel = [], claim = async () => true, recover = async () => ({ status: "cleanup_recorded" }) } = {}) {
  const calls = [];
  const repo = (owner, rows) => ({
    async listOrphanRecoveryCandidates(input) { calls.push([owner, "list", input]); return rows; },
    async claimOrphanRecoveryCandidate(input) { calls.push([owner, "claim", input]); return claim(input); },
  });
  const recovery = createVideoOrphanRecovery({
    productRepository: repo("product", product), reelRepository: repo("reel", reel),
    productVideos: { async recoverUncertainCreation(target) { calls.push(["product", "recover", target]); return recover(target); } },
    reelDiscovery: { async recover(id, recoveryId) { calls.push(["reel", "recover", { sessionId: id, recoveryId }]); return recover({ sessionId: id, recoveryId }); } },
    now: () => now, retryAfterMs: 300_000,
  });
  return { recovery, calls };
}

test("the orphan sweep shares one limit across owners and processes the oldest reservations first", async () => {
  const f = fixture({ product: [candidate({ videoId: productId }, 400_000)],
    reel: [candidate({ sessionId }, 600_000), candidate({ sessionId, recoveryId }, 500_000)] });
  assert.deepEqual(await f.recovery.sweep({ limit: 2 }), { found: 2, examined: 2, cleanupRecorded: 2, deferred: 0, failed: 0 });
  assert.deepEqual(f.calls.filter(c => c[1] === "recover").map(c => c[2]), [
    { sessionId, recoveryId: undefined }, { sessionId, recoveryId },
  ]);
  for (const call of f.calls.filter(c => c[1] === "list")) assert.equal(call[2].before.getTime(), now - 300_000);
});

test("a lost atomic claim never performs provider discovery or cleanup", async () => {
  const f = fixture({ product: [candidate({ videoId: productId }, 400_000)], claim: async () => false });
  assert.deepEqual(await f.recovery.sweep({ limit: 1 }), { found: 1, examined: 0, cleanupRecorded: 0, deferred: 0, failed: 0 });
  assert.equal(f.calls.filter(c => c[1] === "recover").length, 0);
});

test("a provider failure does not prevent another claimed owner from recovering", async () => {
  const f = fixture({ product: [candidate({ videoId: productId }, 500_000)], reel: [candidate({ sessionId }, 400_000)],
    recover: async target => { if (target.videoId) throw new Error("Provider unavailable"); return { status: "cleanup_recorded" }; } });
  assert.deepEqual(await f.recovery.sweep({ limit: 2 }), { found: 2, examined: 2, cleanupRecorded: 1, deferred: 0, failed: 1 });
});

test("ambiguous, non-empty and missing provider matches are deferred without being counted as cleanup", async () => {
  for (const status of ["ambiguous", "requires_review", "no_match_observed", "already_tracked", "stale", "not_applicable"]) {
    const f = fixture({ product: [candidate({ videoId: productId }, 400_000)], recover: async () => ({ status }) });
    assert.deepEqual(await f.recovery.sweep({ limit: 1 }), { found: 1, examined: 1, cleanupRecorded: 0, deferred: 1, failed: 0 });
  }
});

test("invalid sweep bounds and retry intervals fail before any database or provider call", async () => {
  const f = fixture();
  for (const limit of [0, -1, 101, 1.5]) await assert.rejects(f.recovery.sweep({ limit }), RangeError);
  assert.equal(f.calls.length, 0);
  assert.throws(() => createVideoOrphanRecovery({ retryAfterMs: 0 }), TypeError);
});

function persistenceFixture() {
  const old = new Date(now - 600_000);
  const db = replacementDatabase({
    placements: [{ _id: productId, activeSlot: false, lifecycleState: "failed", updatedAt: old }],
    replacements: [{ _id: recoveryId, videoId: productId, status: "failed", failureCode: "VIDEO_PROVIDER_UNAVAILABLE", updatedAt: old }],
    sessions: [{ _id: sessionId, videoId: productId, status: "failed", providerTitle: `petyard-reel-session:${sessionId}`,
      failedAt: old, abandonAt: new Date(now + 60_000), updatedAt: old }],
    recoveries: [{ _id: "507f1f77bcf86cd799439014", videoId: productId, sessionId, status: "failed", finishedAt: old, updatedAt: old }],
  });
  const product = createProductVideoRepository({ ...db, libraryId: "754739", now: () => now });
  const reel = createReelUploadRepository({ ...db, videos: db.placements, libraryId: "754739", now: () => now });
  return { db, product, reel };
}

test("both owner repositories enumerate initial, replacement and resource-recovery reservations", async () => {
  const f = persistenceFixture();
  const before = new Date(now - 300_000);
  const product = await f.product.listOrphanRecoveryCandidates({ before, limit: 10 });
  const reel = await f.reel.listOrphanRecoveryCandidates({ before, limit: 10 });
  assert.equal(product.length, 3);
  assert.equal(reel.length, 2);
  assert.ok(product.some(row => row.target.replacementId === recoveryId));
  assert.ok(product.some(row => row.target.recoveryId));
  assert.ok(reel.some(row => row.target.recoveryId));
});

test("claims are exclusive and space subsequent probes without changing failure times or deadlines", async () => {
  const before = new Date(now - 300_000);
  for (const owner of ["product", "reel"]) {
    const f = persistenceFixture();
    const repository = f[owner];
    for (const candidate of await repository.listOrphanRecoveryCandidates({ before, limit: 10 })) {
      const claim = { ...candidate, claimedAt: new Date(now) };
      const results = await Promise.all([repository.claimOrphanRecoveryCandidate(claim), repository.claimOrphanRecoveryCandidate(claim)]);
      assert.deepEqual(results.sort(), [false, true]);
    }
    assert.deepEqual(await repository.listOrphanRecoveryCandidates({ before, limit: 10 }), []);
    assert.equal((await f.db.sessions.findOne({ _id: sessionId })).failedAt.getTime(), now - 600_000);
    assert.equal((await f.db.sessions.findOne({ _id: sessionId })).abandonAt.getTime(), now + 60_000);
    assert.equal((await f.db.recoveries.findOne({})).finishedAt.getTime(), now - 600_000);
  }
});

test("issued, tracked and still-reserving resources are excluded from automatic orphan discovery", async () => {
  const f = persistenceFixture();
  await f.db.sessions.updateOne({ _id: sessionId }, { $set: { issuedAt: new Date(now - 900_000) } });
  await f.db.replacements.updateOne({ _id: recoveryId }, { $set: { status: "reserving" } });
  await f.db.recoveries.updateOne({}, { $set: { assetId: "507f1f77bcf86cd799439016" } });
  await f.db.placements.updateOne({ _id: productId }, { $set: { activeAssetId: "507f1f77bcf86cd799439017" } });
  const input = { before: new Date(now - 300_000), limit: 10 };
  assert.deepEqual(await f.product.listOrphanRecoveryCandidates(input), []);
  assert.deepEqual(await f.reel.listOrphanRecoveryCandidates(input), []);
});

test("a generation attached after enumeration makes the probe claim stale", async () => {
  const f = persistenceFixture();
  const [candidate] = await f.reel.listOrphanRecoveryCandidates({ before: new Date(now - 300_000), limit: 1 });
  await f.db.sessions.updateOne({ _id: sessionId }, { $set: { assetId: "507f1f77bcf86cd799439016" } });
  assert.equal(await f.reel.claimOrphanRecoveryCandidate({ ...candidate, claimedAt: new Date(now) }), false);
});
