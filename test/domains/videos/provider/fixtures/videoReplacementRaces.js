import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createProductVideoRepository } from "../../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createProductVideoProductDeletionRepository } from "../../../../../src/domains/videos/productVideos/productVideoProductDeletion.repository.js";
import { createReelUploadRepository } from "../../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../../src/domains/videos/reels/reelUpload.service.js";
import { createReelUploadRecovery } from "../../../../../src/domains/videos/reels/reelUploadRecovery.service.js";
import { createEditorialCoverReferencePersistence } from "../../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createVideoAssetObserver } from "../../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { claimVideoProviderOperationById, completeVideoProviderOperation, failVideoProviderOperation } from "../../../../../src/domains/videos/provider/videoProviderOperation.service.js";

export function createSimulatedAcceptanceProvider(libraryId) {
  const videos = new Map(), uploads = new Map();
  const missing = () => { throw { status: 404 }; };
  const provider = {
    async createVideo({ title }) {
      const guid = randomUUID();
      const video = { guid, title, videoLibraryId: Number(libraryId), status: 0,
        dateUploaded: new Date().toISOString(), length: 0, storageSize: 0, encodeProgress: 0 };
      videos.set(guid, video); return video;
    },
    async createTusUpload({ videoId, sizeBytes, expiresAt }) {
      const uploadUrl = `https://video.bunnycdn.com/tusupload/${videoId}`;
      uploads.set(videoId, { uploadUrl, sizeBytes, offsetBytes: 0 });
      return { uploadUrl, resourceExpiresAt: expiresAt };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
    async getVideo(guid) { return videos.get(guid) || missing(); },
    async searchReelReservation({ providerTitle }) {
      const items = [...videos.values()].filter(video => video.title === providerTitle);
      return { items, totalItems: items.length, currentPage: 1 };
    },
    async probeSignedHls({ videoId, expiresAt }) {
      assert.equal(videos.get(videoId)?.status, 4);
      return { href: `https://acceptance.example/${videoId}/playlist.m3u8`, expiresAt };
    },
    async terminateTusUpload({ videoId }) { uploads.delete(videoId); return { state: "terminated" }; },
    async deleteVideo(guid) { videos.delete(guid); return { accepted: true, status: 204 }; },
  };
  const http = async (url, options) => {
    assert.equal(options.method, "PATCH");
    const guid = options.headers.VideoId, upload = uploads.get(guid);
    assert.ok(upload && url === upload.uploadUrl);
    assert.equal(Number(options.headers["Upload-Offset"]), upload.offsetBytes);
    upload.offsetBytes += options.body.length;
    assert.equal(upload.offsetBytes, upload.sizeBytes);
    Object.assign(videos.get(guid), { status: 4, length: 2, width: 320, height: 240, availableResolutions: ["240p"] });
    return new Response(null, { status: 204, headers: { "Upload-Offset": String(upload.offsetBytes) } });
  };
  return { provider, http };
}

// The copied-database preflight uses this same flow with an in-memory provider.
export async function verifyVideoReplacementRaces(t, { models, connection, libraryId, recordOperation,
  provider, http, media = Buffer.alloc(7062), record = () => {} }) {
  const providerMocked = !provider;
  if (!provider) ({ provider, http } = createSimulatedAcceptanceProvider(libraryId));
  const jobs = [], actor = { id: String(new mongoose.Types.ObjectId()), role: "admin" };
  let completedCases = 0;
  const dependencies = { ...models, connection, libraryId, recordOperation };
  const productService = createProductVideoService({ repository: createProductVideoRepository(dependencies), provider,
    enqueue: async id => jobs.push(String(id)), invalidateCaches: async () => {} });
  const reelRepository = createReelUploadRepository({ ...dependencies, recoveries: models.reelRecoveries,
    coverReferences: createEditorialCoverReferencePersistence({ videos: models.videos, covers: models.covers, recordOperation }) });
  const reelService = createReelUploadService({ repository: reelRepository, provider, enqueue: async id => jobs.push(String(id)) });
  const recovery = createReelUploadRecovery({ repository: reelRepository, enqueue: async id => jobs.push(String(id)) });
  const observer = createVideoAssetObserver({ model: models.assets,
    onApplied: asset => asset.ownerType === "product_video" ? productService.handleVerifiedAsset(asset) : recovery.handleVerifiedAsset(asset),
    onDeleted: asset => productService.handleDeletedAsset(asset) });
  const runtime = runtimeProvider => createVideoProviderRuntime({ provider: runtimeProvider, assets: observer, operations: {
    claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations }),
    complete: input => completeVideoProviderOperation({ ...input, model: models.operations }),
    fail: input => failVideoProviderOperation({ ...input, model: models.operations }),
  } });
  const specification = asset => ({ assetId: asset._id, libraryId, providerGuid: asset.providerGuid });
  async function uploadReady(upload, asset) {
    const response = await http(upload.uploadUrl, { method: "PATCH", body: media, headers: { ...upload.headers,
      "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" } });
    await response.body?.cancel();
    assert.equal(response.status, 204); assert.equal(Number(response.headers.get("Upload-Offset")), media.length);
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await provider.getVideo(asset.providerGuid);
      if (snapshot.status === 4) {
        assert.ok(snapshot.length > 0 && snapshot.length <= 90 && snapshot.width > 0 && snapshot.height > 0);
        return snapshot;
      }
      assert.ok(![5, 6].includes(snapshot.status));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.fail("Synthetic replacement did not reach Ready within the bounded poll");
  }
  async function lateReady(asset, mutation) {
    let received, release;
    const receivedResponse = new Promise(resolve => { received = resolve; });
    const allowResponse = new Promise(resolve => { release = resolve; });
    const heldProvider = { ...provider, async getVideo(guid) {
      assert.equal(guid, asset.providerGuid);
      const snapshot = await provider.getVideo(guid); assert.equal(snapshot.status, 4);
      received(); await allowResponse; return snapshot;
    } };
    const operation = await recordOperation({ ...specification(asset), type: "reconcile", dedupeKey: `replacement-late-ready:${asset._id}` });
    const processing = runtime(heldProvider).process(String(operation._id));
    try {
      await Promise.race([receivedResponse, processing.then(() => { throw new Error("Reconcile ended before the response barrier"); })]);
      await mutation();
    } finally { release(); await processing; }
    assert.equal((await processing).status, "completed");
    assert.equal((await models.assets.findById(asset._id)).technicalState, "deleting");
  }
  async function drain() {
    for (const id of jobs.splice(0)) assert.equal((await runtime(provider).process(id)).status, "completed");
  }
  const file = { filename: "synthetic-two-second.mp4", mimeType: "video/mp4", sizeBytes: media.length, clientId: "replacement-race" };

  await t.test("whole-Product deletion beats a late replacement Ready response and cleans both generations", async () => {
    const productId = new mongoose.Types.ObjectId();
    await models.products.collection.insertOne({ _id: productId, slug: `replacement-race-${productId}`, isActive: true });
    const [initial] = await productService.createUploadSessions({ productId: String(productId), actorId: actor.id,
      idempotencyKey: randomUUID(), files: [file] });
    const owner = await models.placements.findById(initial.productVideoId);
    const current = await models.assets.findById(owner.activeAssetId);
    const currentSnapshot = await uploadReady(initial.upload, current);
    await observer.applySnapshot({ operation: specification(current), snapshot: currentSnapshot });
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "ready");
    const replacement = await productService.createReplacementUploadSession({ productId: String(productId), videoId: String(owner._id),
      actorId: actor.id, idempotencyKey: randomUUID(), file });
    const pending = await models.assets.findById((await models.placements.findById(owner._id)).pendingAssetId);
    const snapshot = await uploadReady(replacement.upload, pending);
    const deletion = createProductVideoProductDeletionRepository({ ...dependencies, productId });
    await lateReady(pending, async () => { jobs.push(...await deletion.deleteWithVideos()); });
    assert.equal(await models.products.countDocuments({ _id: productId }), 0);
    assert.equal((await models.placements.findById(owner._id)).activeSlot, false);
    await drain();
    for (const [asset, observed] of [[current, currentSnapshot], [pending, snapshot]]) {
      await assert.rejects(provider.getVideo(asset.providerGuid), error => error.status === 404);
      await observer.applySnapshot({ operation: specification(asset), snapshot: observed });
      assert.equal((await models.assets.findById(asset._id)).technicalState, "deleted");
    }
    assert.equal((await models.placements.findById(owner._id)).lifecycleState, "removed");
    record("product-replacement-versus-cascade", { providerMocked, bothGenerationsDeleted: true, slotReleased: true, lateReplayDidNotRevive: true });
    completedCases++;
  });

  await t.test("cancelled Reel replacement rejects a late Ready response and retains published current media", async () => {
    const reelFile = { filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
    const video = await models.videos.create({ kind: "reel", status: "draft", authorId: actor.id,
      title_en: "Synthetic current Reel", title_ar: "Synthetic current Reel" });
    const initial = await reelService.createSession({ videoId: String(video._id), actor, file: reelFile, idempotencyKey: randomUUID() });
    const current = await models.assets.findById((await models.videos.findById(video._id)).activeAssetId);
    const currentSnapshot = await uploadReady(initial.upload, current);
    await observer.applySnapshot({ operation: specification(current), snapshot: currentSnapshot });
    // Seed publication in isolated data; this test does not establish review/publish authorization.
    await models.videos.updateOne({ _id: video._id }, { $set: { status: "published", publishedAt: new Date() } });
    const replacement = await reelService.createSession({ videoId: String(video._id), actor, file: reelFile,
      purpose: "replacement", idempotencyKey: randomUUID() });
    const pending = await models.assets.findById((await models.videos.findById(video._id)).pendingChange.assetId);
    const snapshot = await uploadReady(replacement.upload, pending);
    await lateReady(pending, () => reelService.cancelUpload({ videoId: String(video._id), sessionId: replacement.sessionId,
      actor, purpose: "replacement" }));
    await drain();
    await assert.rejects(provider.getVideo(pending.providerGuid), error => error.status === 404);
    await observer.applySnapshot({ operation: specification(pending), snapshot });
    const retained = await models.videos.findById(video._id), active = await models.assets.findById(current._id);
    assert.equal(retained.status, "published"); assert.equal(String(retained.activeAssetId), String(current._id));
    assert.equal(String(retained.activeUploadSessionId), initial.sessionId);
    assert.ok(!retained.pendingChange?.assetId);
    assert.equal(active.technicalState, "ready"); assert.ok(!active.deletionRequestedAt);
    assert.equal((await provider.getVideo(current.providerGuid)).status, 4);
    assert.equal((await models.assets.findById(pending._id)).technicalState, "deleted");
    const cancelled = await models.sessions.findById(replacement.sessionId);
    assert.equal(cancelled.status, "failed"); assert.equal(cancelled.failureCode, "VIDEO_UPLOAD_CANCELLED");
    record("reel-replacement-versus-cancellation", { providerMocked, pendingGenerationDeleted: true,
      publishedCurrentPreserved: true, lateReplayDidNotRevive: true });
    completedCases++;
  });
  return completedCases;
}
