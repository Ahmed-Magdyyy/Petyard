import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createProductVideoRepository } from "../../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createReelUploadRepository } from "../../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../../src/domains/videos/reels/reelUpload.service.js";
import { createReelUploadRecovery } from "../../../../../src/domains/videos/reels/reelUploadRecovery.service.js";
import { createEditorialCoverReferencePersistence } from "../../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createVideoAssetObserver } from "../../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { claimVideoProviderOperationById, completeVideoProviderOperation, failVideoProviderOperation } from "../../../../../src/domains/videos/provider/videoProviderOperation.service.js";

const seconds = () => Math.floor(Date.now() / 1000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isExpiredTusRejection(status, body) {
  return [401, 403].includes(status) || (status === 400 &&
    /\bexpired\b|\b(?:expiry|expiration|authorizationexpire)\b[\s\S]{0,120}\bpast\b/i.test(body));
}

export async function verifyVideoLiveMedia(t, { models, connection, provider, recordOperation, stream,
  portrait, overLimit, http, record, registerPlaybackUrl, portraitOnly = false, deletionOnly = false }) {
  let completedCases = 0;
  const jobs = [];
  const actor = { id: String(new mongoose.Types.ObjectId()), role: "admin" };
  const dependencies = { ...models, connection, libraryId: stream.libraryId, recordOperation };
  const productService = createProductVideoService({ repository: createProductVideoRepository(dependencies), provider,
    enqueue: async id => jobs.push(String(id)), invalidateCaches: async () => {} });
  const reelRepository = createReelUploadRepository({ ...dependencies, recoveries: models.reelRecoveries,
    coverReferences: createEditorialCoverReferencePersistence({ videos: models.videos, covers: models.covers, recordOperation }) });
  const reelService = createReelUploadService({ repository: reelRepository, provider, enqueue: async id => jobs.push(String(id)) });
  const reelRecovery = createReelUploadRecovery({ repository: reelRepository, enqueue: async id => jobs.push(String(id)) });
  const observer = createVideoAssetObserver({ model: models.assets,
    onApplied: asset => asset.ownerType === "product_video" ? productService.handleVerifiedAsset(asset) : reelRecovery.handleVerifiedAsset(asset),
    onDeleted: asset => productService.handleDeletedAsset(asset) });
  function runtime(runtimeProvider = provider) {
    return createVideoProviderRuntime({ provider: runtimeProvider, assets: observer, operations: {
      claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations }),
      complete: input => completeVideoProviderOperation({ ...input, model: models.operations }),
      fail: input => failVideoProviderOperation({ ...input, model: models.operations }),
    } });
  }
  async function patch(upload, offset, bytes, headers = upload.headers) {
    const response = await http(upload.uploadUrl, { method: "PATCH", headers: { ...headers,
      "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) }, body: bytes });
    const expiryRejected = response.ok ? false : isExpiredTusRejection(response.status, await response.text());
    if (response.ok) await response.body?.cancel();
    return { status: response.status, headers: response.headers, expiryRejected };
  }
  async function ready(guid) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await provider.getVideo(guid);
      if (snapshot.status === 4) return snapshot;
      assert.ok(![5, 6].includes(snapshot.status), "Synthetic media must transcode successfully before application-policy checks");
      await pause(2000);
    }
    assert.fail("Synthetic media did not reach provider Ready within the bounded poll");
  }
  async function drain() {
    for (const id of jobs.splice(0)) assert.equal((await runtime().process(id)).status, "completed");
  }

  await t.test(deletionOnly ? "Product deletion beats a late real provider Ready response"
    : "portrait TUS token expiry, same-resource refresh, HLS expiry and deletion beating a late real provider response", async () => {
    const productId = new mongoose.Types.ObjectId();
    await models.products.collection.insertOne({ _id: productId, slug: `media-${productId}`, isActive: true });
    const file = { filename: "synthetic-portrait.mp4", mimeType: "video/mp4", sizeBytes: portrait.length, clientId: "portrait" };
    const [session] = await productService.createUploadSessions({ productId: String(productId), actorId: actor.id,
      idempotencyKey: randomUUID(), files: [file] });
    const owner = await models.placements.findById(session.productVideoId);
    const asset = await models.assets.findById(owner.activeAssetId);
    const deadline = owner.abandonAt.getTime(), half = Math.floor(portrait.length / 2);
    let expiredTusStatus;
    if (deletionOnly) {
      const completed = await patch(session.upload, 0, portrait);
      assert.equal(completed.status, 204);
      assert.equal(Number(completed.headers.get("Upload-Offset")), portrait.length);
    } else {
    const first = await patch(session.upload, 0, portrait.subarray(0, half));
    assert.equal(first.status, 204); assert.equal(Number(first.headers.get("Upload-Offset")), half);
    const expiresAt = seconds() + 2;
    const expiredGrant = provider.createTusUploadAuthorization({ videoId: asset.providerGuid, expiresAt });
    await pause(Math.max(0, (expiresAt + 2) * 1000 - Date.now()));
    const rejected = await patch(session.upload, half, portrait.subarray(half), expiredGrant.headers);
    expiredTusStatus = rejected.status;
    record("expired-tus-grant-response", { status: rejected.status, expiryRejected: rejected.expiryRejected });
    assert.ok(rejected.expiryRejected, "Expired TUS authorization must be rejected with an authorization or explicit expiry error");
    const afterExpiry = await provider.inspectTusUpload({ videoId: asset.providerGuid, uploadUrl: session.upload.uploadUrl, expiresAt: seconds() + 60 });
    assert.equal(afterExpiry.offsetBytes, half);
    const refreshed = await productService.refreshUploadAuthorization({ productId: String(productId), videoId: session.productVideoId, actorId: actor.id });
    assert.ok(refreshed.upload.uploadUrl === session.upload.uploadUrl, "Refresh must keep the exact resource");
    assert.equal((await models.placements.findById(owner._id)).abandonAt.getTime(), deadline);
    const completed = await patch(refreshed.upload, half, portrait.subarray(half));
    assert.equal(completed.status, 204); assert.equal(Number(completed.headers.get("Upload-Offset")), portrait.length);
    record("portrait-tus-resume", { expiredTusStatus: rejected.status, offsetPreserved: true,
      sameResourceRefresh: true, deadlinePreserved: true });
    }
    const snapshot = await ready(asset.providerGuid);
    assert.ok(snapshot.height > snapshot.width && snapshot.length > 0 && snapshot.length <= 90);
    if (!deletionOnly) {
    const playback = provider.createSignedHlsUrl({ videoId: asset.providerGuid, expiresAt: seconds() + 6 });
    registerPlaybackUrl(playback.href);
    const valid = await http(playback.href); assert.equal(valid.status, 200); assert.match(await valid.text(), /^#EXTM3U/);
    await pause(Math.max(0, (playback.expiresAt + 2) * 1000 - Date.now()));
    const expired = await http(playback.href); await expired.body?.cancel(); assert.equal(expired.status, 403);
    record("portrait-and-token-expiry", { portrait: true, expiredTusStatus, offsetPreserved: true,
      sameResourceRefresh: true, deadlinePreserved: true, expiredHlsStatus: expired.status });
    }

    await observer.applySnapshot({ operation: { assetId: asset._id, libraryId: stream.libraryId, providerGuid: asset.providerGuid }, snapshot });
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "ready");
    let received, release;
    const receivedResponse = new Promise(resolve => { received = resolve; });
    const allowResponse = new Promise(resolve => { release = resolve; });
    const lateProvider = { ...provider, async getVideo(guid) {
      const result = await provider.getVideo(guid); received(); await allowResponse; return result;
    } };
    const operation = await recordOperation({ type: "reconcile", assetId: asset._id, libraryId: stream.libraryId,
      providerGuid: asset.providerGuid, dedupeKey: `media-late-ready:${asset._id}` });
    const processing = runtime(lateProvider).process(String(operation._id));
    try {
      await Promise.race([receivedResponse, processing.then(() => { throw new Error("Reconcile ended before the provider response barrier"); })]);
      await productService.requestDeletion({ productId: String(productId), videoId: session.productVideoId });
    } finally { release(); }
    assert.equal((await processing).status, "completed");
    const deletingAsset = await models.assets.findById(asset._id);
    assert.equal(deletingAsset.technicalState, "ready");
    assert.ok(deletingAsset.deletionRequestedAt);
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "deleting");
    await drain();
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "removed");
    assert.equal((await models.placements.findById(owner._id)).activeSlot, false);
    await observer.applySnapshot({ operation: { assetId: asset._id, libraryId: stream.libraryId, providerGuid: asset.providerGuid }, snapshot });
    assert.equal((await models.assets.findById(asset._id)).technicalState, "deleted");
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "removed");
    record("real-late-ready-versus-product-deletion", { deletionWon: true, slotReleased: true, lateReplayDidNotRevive: true });
    completedCases++;
  });

  if (!portraitOnly) await t.test("real over-90-second Reel is rejected, detached and durably deleted", async () => {
    const video = await models.videos.create({ kind: "reel", status: "draft", authorId: actor.id, title_en: "Synthetic duration test", title_ar: "Synthetic duration test" });
    const session = await reelService.createSession({ videoId: String(video._id), actor, idempotencyKey: randomUUID(),
      file: { filename: "synthetic-over-limit.mp4", mimeType: "video/mp4", sizeBytes: overLimit.length } });
    const owner = await models.videos.findById(video._id), asset = await models.assets.findById(owner.activeAssetId);
    const upload = await patch(session.upload, 0, overLimit); assert.equal(upload.status, 204);
    const snapshot = await ready(asset.providerGuid); assert.ok(snapshot.length > 90);
    await observer.applySnapshot({ operation: { assetId: asset._id, libraryId: stream.libraryId, providerGuid: asset.providerGuid }, snapshot });
    const rejected = await models.sessions.findById(session.sessionId);
    assert.equal(rejected.status, "failed"); assert.equal(rejected.failureCode, "VIDEO_DURATION_EXCEEDED");
    assert.ok(!(await models.videos.findById(video._id)).activeAssetId);
    assert.equal((await models.assets.findById(asset._id)).technicalState, "deleting");
    assert.ok(jobs.length > 0); await drain();
    await observer.applySnapshot({ operation: { assetId: asset._id, libraryId: stream.libraryId, providerGuid: asset.providerGuid }, snapshot });
    assert.ok(!(await models.videos.findById(video._id)).activeAssetId);
    assert.equal((await models.assets.findById(asset._id)).technicalState, "deleted");
    record("real-duration-policy-and-cleanup", { providerDurationSeconds: snapshot.length,
      failureCode: rejected.failureCode, ownerDetached: true, durableCleanupCompleted: true, lateReplayDidNotRevive: true });
    completedCases++;
  });
  return completedCases;
}
