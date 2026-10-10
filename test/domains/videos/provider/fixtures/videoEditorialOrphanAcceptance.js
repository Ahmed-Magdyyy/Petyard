import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import sharp from "sharp";
import { createEditorialVideoRepository } from "../../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoService } from "../../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialCoverRepository, createEditorialCoverReferencePersistence } from "../../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createEditorialCoverService } from "../../../../../src/domains/videos/editorial/editorialCover.service.js";
import { createEditorialCoverStore } from "../../../../../src/domains/videos/editorial/editorialCover.store.js";
import { uploadImage } from "../../../../../src/shared/utils/imageUpload.js";
import { createReelUploadRepository } from "../../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../../src/domains/videos/reels/reelUpload.service.js";
import { createReelLifecycleRepository } from "../../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createReelLifecycle } from "../../../../../src/domains/videos/reels/reelLifecycle.service.js";
import { createReelPreviewService } from "../../../../../src/domains/videos/reels/reelPreview.service.js";
import { createReelOrphanDiscovery } from "../../../../../src/domains/videos/reels/reelOrphanDiscovery.js";
import { createProductVideoRepository } from "../../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createPublicVideoRepository } from "../../../../../src/domains/videos/public/publicVideo.repository.js";
import { createVideoOrphanRecovery } from "../../../../../src/domains/videos/provider/videoOrphanRecovery.service.js";
import { createVideoAssetObserver } from "../../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { claimVideoProviderOperationById, completeVideoProviderOperation, failVideoProviderOperation } from "../../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { createSimulatedAcceptanceProvider } from "./videoReplacementRaces.js";

function simulatedCoverStore() {
  const objects = new Map();
  const configuration = { publicProvider: "bunny", storageTimeoutMs: 15000,
    public: { zone: "acceptance", endpoint: "https://storage.bunnycdn.com", cdnBaseUrl: "https://acceptance.example" } };
  const store = createEditorialCoverStore({ configuration: () => configuration,
    upload: (file, options) => uploadImage(file, { ...options, bunnyUpload: async ({ objectKey, buffer }) => {
      assert.ok(!objects.has(objectKey)); objects.set(objectKey, buffer);
    } }),
    remove: async ({ objectKey }) => { objects.delete(objectKey); },
  });
  return { store, verifyCover: async cover => {
    const bytes = objects.get(`petyard/video-covers/${cover._id}.webp`);
    assert.ok(bytes); assert.equal((await sharp(bytes).metadata()).format, "webp");
  }, verifyCoverAbsent: async cover => assert.ok(!objects.has(`petyard/video-covers/${cover._id}.webp`)) };
}

// Same application flow runs on the copied database with simulated or live providers.
export async function verifyVideoEditorialOrphanAcceptance(t, { models, connection, libraryId, recordOperation,
  provider, http, media = Buffer.alloc(7062), coverStore, verifyCover, verifyCoverAbsent, record = () => {} }) {
  const providerMocked = !provider;
  if (!provider) ({ provider, http } = createSimulatedAcceptanceProvider(libraryId));
  if (!coverStore) ({ store: coverStore, verifyCover, verifyCoverAbsent } = simulatedCoverStore());
  const admin = { id: String(new mongoose.Types.ObjectId()), role: "admin" };
  const superAdmin = { id: String(new mongoose.Types.ObjectId()), role: "superAdmin" };
  const dependencies = { ...models, connection, libraryId, recordOperation };
  const enqueue = async () => {}; // Durable rows, rather than queue success, drive this fixture's runtime.
  const coverReferences = createEditorialCoverReferencePersistence(dependencies);
  const coverRepository = createEditorialCoverRepository(dependencies);
  const covers = createEditorialCoverService({ repository: coverRepository, store: coverStore, enqueue });
  const lifecycleRepository = createReelLifecycleRepository({ ...dependencies, coverReferences });
  let previewProbeCalls = 0, denyAutomaticPreview = false;
  const previewProvider = { ...provider, async probeSignedHls(input) {
    previewProbeCalls++; return provider.probeSignedHls(input);
  } };
  const preview = createReelPreviewService({ repository: lifecycleRepository, provider: previewProvider });
  const lifecycle = createReelLifecycle({ repository: lifecycleRepository, enqueue,
    verifyPreviewReady: async asset => {
      const grant = await previewProvider.probeSignedHls({ videoId: asset.providerGuid,
        expiresAt: Math.floor(Date.now() / 1000) + 60 });
      if (denyAutomaticPreview) { denyAutomaticPreview = false; return false; }
      return Boolean(grant);
    } });
  const observer = createVideoAssetObserver({ model: models.assets, onApplied: asset => lifecycle.handleVerifiedAsset(asset) });
  const runtime = createVideoProviderRuntime({ provider, assets: observer, covers, operations: {
    claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations }),
    complete: input => completeVideoProviderOperation({ ...input, model: models.operations }),
    fail: input => failVideoProviderOperation({ ...input, model: models.operations }),
  } });
  const uploadRepository = createReelUploadRepository({ ...dependencies, recoveries: models.reelRecoveries, coverReferences });
  const uploads = createReelUploadService({ repository: uploadRepository, provider, enqueue });
  const editorial = createEditorialVideoService({
    repository: createEditorialVideoRepository({ ...dependencies, coverReferences, reelLifecycle: lifecycleRepository,
      reelUploads: uploadRepository, deletion: dependencies }),
    covers, enqueue, verifyYouTube: async () => assert.fail("This fixture creates only Reels"),
    verifyReelReady: video => preview.verifyReady(video),
    verifyReelReplacementReady: video => preview.verifyReady(video, "pending"),
  });
  const publicRepository = createPublicVideoRepository(dependencies);
  const file = { filename: "synthetic-two-second.mp4", mimeType: "video/mp4", sizeBytes: media.length };
  const input = { kind: "reel", title_en: "Synthetic acceptance Reel", title_ar: "Synthetic acceptance Reel" };
  const portrait = await sharp({ create: { width: 120, height: 180, channels: 3, background: "#2563eb" } }).png().toBuffer();
  let completedCases = 0;
  async function uploadReady(videoId, actor, purpose = "initial") {
    const session = await uploads.createSession({ videoId, actor, purpose, file, idempotencyKey: randomUUID() });
    const upload = session.upload;
    const response = await http(upload.uploadUrl, { method: "PATCH", body: media, headers: { ...upload.headers,
      "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" } });
    await response.body?.cancel(); assert.equal(response.status, 204);
    assert.equal(Number(response.headers.get("Upload-Offset")), media.length);
    const asset = await models.assets.findById((await models.sessions.findById(session.sessionId)).assetId);
    let snapshot;
    for (let attempt = 0; attempt < 60; attempt++) {
      snapshot = await provider.getVideo(asset.providerGuid);
      if (snapshot.status === 4) break;
      assert.ok(![5, 6].includes(snapshot.status));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.equal(snapshot.status, 4);
    let grant;
    for (let attempt = 0; attempt < 12; attempt++) {
      grant = await previewProvider.probeSignedHls({ videoId: asset.providerGuid, expiresAt: Math.floor(Date.now() / 1000) + 60 });
      if (grant) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(grant, "Ready media must also have a usable signed HLS playlist within the bounded poll");
    await observer.applySnapshot({ operation: { assetId: asset._id, libraryId, providerGuid: asset.providerGuid }, snapshot });
    assert.equal((await models.assets.findById(asset._id)).technicalState, "ready");
    return asset;
  }
  async function drain() {
    for (const operation of await models.operations.find({ status: "pending" })) {
      assert.equal((await runtime.process(String(operation._id))).status, "completed");
    }
  }

  await t.test("real Reel review, separate Publish and reviewed media/cover cutover retain public isolation", async () => {
    const video = await editorial.createReelDraft({ actor: admin, input });
    const current = await uploadReady(video.id, admin);
    assert.equal(await publicRepository.getPublished(video.id), null);
    await assert.rejects(editorial.approve({ id: video.id, actor: admin }), error => error.statusCode === 403);
    await editorial.editCover({ id: video.id, actor: admin, buffer: portrait });
    const oldCover = await models.covers.findById((await models.videos.findById(video.id)).activeCoverId);
    await verifyCover(oldCover);
    await editorial.submit({ id: video.id, actor: admin });
    await editorial.approve({ id: video.id, actor: superAdmin });
    assert.equal((await models.videos.findById(video.id)).status, "approved");
    assert.equal(await publicRepository.getPublished(video.id), null);
    await editorial.publish({ id: video.id, actor: superAdmin });
    const initialPublic = await publicRepository.getPublished(video.id);
    assert.equal(String(initialPublic.activeAssetId), String(current._id)); assert.ok(initialPublic.cover.url);
    const pending = await uploadReady(video.id, admin, "replacement");
    await editorial.editCover({ id: video.id, actor: admin, buffer: portrait });
    const pendingOwner = await models.videos.findById(video.id);
    const newCover = await models.covers.findById(pendingOwner.pendingChange.content.coverId);
    await verifyCover(newCover);
    const beforeApproval = await publicRepository.getPublished(video.id);
    assert.equal(String(beforeApproval.activeAssetId), String(current._id));
    assert.equal(beforeApproval.cover.url, initialPublic.cover.url);
    const probesBeforeForbidden = previewProbeCalls;
    await assert.rejects(preview.grant({ id: video.id, actor: { id: admin.id, role: "user" }, asset: "pending" }),
      error => error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
    assert.equal(previewProbeCalls, probesBeforeForbidden, "Unauthorized preview must not contact the provider");
    assert.ok(await preview.grant({ id: video.id, actor: admin, asset: "pending" }));
    await editorial.submit({ id: video.id, actor: admin });
    await editorial.approve({ id: video.id, actor: superAdmin });
    const approved = await publicRepository.getPublished(video.id);
    assert.equal(String(approved.activeAssetId), String(pending._id));
    assert.notEqual(approved.cover.url, initialPublic.cover.url);
    assert.equal((await models.assets.findById(current._id)).technicalState, "deleting");
    await drain();
    await assert.rejects(provider.getVideo(current.providerGuid), error => error.status === 404);
    await verifyCoverAbsent(oldCover);
    assert.equal((await models.covers.findById(oldCover._id)).state, "deleted");
    await editorial.editCover({ id: video.id, actor: superAdmin, remove: true });
    assert.equal((await publicRepository.getPublished(video.id)).cover ?? null, null);
    await drain(); await verifyCoverAbsent(newCover);
    assert.equal((await models.covers.findById(newCover._id)).state, "deleted");
    assert.equal((await provider.getVideo(pending.providerGuid)).status, 4);
    record("reviewed-reel-cover-cutover", { providerMocked, approvalHiddenUntilPublish: true,
      pendingMediaAndCoverExcludedFromPublicResponse: true, previewVerified: true, unauthorizedPreviewMadeNoProviderCall: true,
      oldMediaAndBothCoversCleaned: true });
    completedCases++;
  });
  await t.test("super-admin initial Reel publishes automatically only after verified Ready and preview", async () => {
    const video = await editorial.createReelDraft({ actor: superAdmin, input });
    assert.equal(await publicRepository.getPublished(video.id), null);
    // Inject one denied verifier result; Ready metadata alone must not publish.
    denyAutomaticPreview = true;
    const asset = await uploadReady(video.id, superAdmin);
    assert.equal((await models.videos.findById(video.id)).status, "draft");
    assert.equal(await publicRepository.getPublished(video.id), null);
    assert.equal((await lifecycle.handleVerifiedAsset(await models.assets.findById(asset._id))).status, "published");
    const published = await publicRepository.getPublished(video.id);
    assert.equal(published.status, "published"); assert.equal(String(published.activeAssetId), String(asset._id));
    record("super-admin-reel-auto-publication", { providerMocked, deniedPreviewKeptDraft: true, publishedAfterVerifiedPreview: true });
    completedCases++;
  });
  await t.test("lost create response survives exclusive orphan sweep adoption and durable cleanup without queue acknowledgment", async () => {
    const video = await editorial.createReelDraft({ actor: admin, input });
    let orphanGuid;
    const lostResponse = createReelUploadService({ repository: uploadRepository, enqueue,
      provider: { ...provider, async createVideo(input) {
        const created = await provider.createVideo(input); orphanGuid = created.guid;
        throw new Error("Isolated lost provider create response");
      } } });
    await assert.rejects(lostResponse.createSession({ videoId: video.id, actor: admin, file, idempotencyKey: randomUUID() }),
      error => error.statusCode === 503 && error.errors[0].code === "VIDEO_PROVIDER_UNAVAILABLE");
    const session = await models.sessions.findOne({ videoId: video.id });
    assert.equal(session.status, "failed"); assert.ok(!session.assetId && !session.issuedAt);
    let lostQueueAcknowledgments = 0;
    const discovery = createReelOrphanDiscovery({ repository: uploadRepository, provider, libraryId, allowCleanup: true,
      enqueue: async () => { lostQueueAcknowledgments++; throw new Error("Isolated queue acknowledgment loss"); } });
    let inspection;
    for (let attempt = 0; attempt < 6; attempt++) {
      inspection = await discovery.inspect(String(session._id));
      if (inspection.status !== "no_match_observed") break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.deepEqual(inspection, { status: "candidate", providerGuid: orphanGuid });
    // Advance only this owned candidate's due timestamp, retaining actual provider creation/failure times.
    await models.sessions.updateOne({ _id: session._id }, { $set: { updatedAt: new Date(Date.now() - 360000) } }, { timestamps: false });
    const productRepository = createProductVideoRepository(dependencies);
    const sweep = createVideoOrphanRecovery({ productRepository, reelRepository: uploadRepository, reelDiscovery: discovery,
      productVideos: createProductVideoService({ repository: productRepository, provider, enqueue }) });
    const outcomes = await Promise.all([sweep.sweep({ limit: 1 }), sweep.sweep({ limit: 1 })]);
    assert.equal(outcomes.reduce((sum, result) => sum + result.examined, 0), 1);
    assert.equal(outcomes.reduce((sum, result) => sum + result.cleanupRecorded, 0), 1);
    assert.equal(outcomes.reduce((sum, result) => sum + result.failed, 0), 0);
    assert.equal(lostQueueAcknowledgments, 1);
    assert.equal(await models.assets.countDocuments({ providerGuid: orphanGuid }), 1);
    assert.equal(await models.operations.countDocuments({ providerGuid: orphanGuid, status: "pending" }), 1);
    await drain();
    await assert.rejects(provider.getVideo(orphanGuid), error => error.status === 404);
    assert.equal((await models.assets.findOne({ providerGuid: orphanGuid })).technicalState, "deleted");
    assert.equal((await discovery.recover(String(session._id))).status, "not_applicable");
    assert.equal(await publicRepository.getPublished(video.id), null);
    record("live-orphan-sweep-cleanup", { providerMocked, exclusiveClaim: true, lostQueueAcknowledgmentRecovered: true,
      exactAdoptionAndDeletion: true, replayDidNotAllocate: true });
    completedCases++;
  });
  return completedCases;
}
