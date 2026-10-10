import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createProductVideoRepository } from "../../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoService } from "../../../../../src/domains/videos/productVideos/productVideo.service.js";
import { createReelUploadRepository } from "../../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../../src/domains/videos/reels/reelUpload.service.js";
import { createVideoProviderRuntime } from "../../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../../src/domains/videos/provider/videoAsset.service.js";
import { claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation } from "../../../../../src/domains/videos/provider/videoProviderOperation.service.js";

// Providers are mocked by default; the opt-in live runner supplies real provider/resource hooks.
export async function verifyVideoDatabaseUploadRecovery(t, { models, connection, libraryId, recordOperation,
  liveProvider, mediaBytes, prepareCurrentAsset, terminateResource,
  cases = ["product:initial", "product:replacement", "reel:initial", "reel:replacement"], onCaseComplete }) {
  for (const selectedCase of cases) {
    const [owner, purpose] = selectedCase.split(":");
    assert.ok(["product", "reel"].includes(owner) && ["initial", "replacement"].includes(purpose));
    await t.test(`real ${owner} ${purpose} recovery preserves identity and deadline after durable old-generation cleanup`, async () => {
      let now = Date.now();
      const currentTime = liveProvider ? Date.now : () => now;
      const actor = { id: String(new mongoose.Types.ObjectId()), role: "admin" };
      const productId = new mongoose.Types.ObjectId();
      const jobs = [], created = [], hosted = new Map();
      const externalProvider = liveProvider || {
        async createVideo(input) {
          const guid = randomUUID();
          hosted.set(guid, { guid, title: input.title, videoLibraryId: Number(libraryId), status: 0 });
          return { guid };
        },
        async createTusUpload({ videoId, expiresAt }) {
          return { uploadUrl: `https://video.bunnycdn.com/tusupload/${videoId}`, resourceExpiresAt: expiresAt };
        },
        createTusUploadAuthorization({ videoId, expiresAt }) { return { headers: { VideoId: videoId }, expiresAt }; },
        async getVideo(guid) { if (!hosted.has(guid)) throw { status: 404 }; return hosted.get(guid); },
        async inspectTusUpload() { return { state: "not_found" }; },
        async terminateTusUpload() { return { state: "terminated" }; },
        async deleteVideo(guid) { hosted.delete(guid); return { accepted: true }; },
      };
      const provider = { ...externalProvider, async createVideo(input) {
        const result = await externalProvider.createVideo(input);
        created.push(result.guid); return result;
      } };
      const dependencies = { ...models, connection, libraryId, recordOperation, now: currentTime };
      const repository = owner === "product" ? createProductVideoRepository(dependencies)
        : createReelUploadRepository({ ...dependencies, recoveries: models.reelRecoveries });
      const service = owner === "product" ? createProductVideoService({ repository, provider, now: currentTime,
        enqueue: async id => jobs.push(id), invalidateCaches: async () => {} })
        : createReelUploadService({ repository, provider, now: currentTime, enqueue: async id => jobs.push(id) });
      const file = { filename: "video.mp4", mimeType: "video/mp4", sizeBytes: mediaBytes || 100,
        ...(owner === "product" ? { clientId: "file" } : {}) };
      let videoId, initial, selected, request;
      if (owner === "product") {
        await models.products.collection.insertOne({ _id: productId, slug: `acceptance-${productId}`, isActive: true });
        [initial] = await service.createUploadSessions({ productId: String(productId), actorId: actor.id,
          idempotencyKey: randomUUID(), files: [file] });
        videoId = initial.productVideoId;
        selected = initial;
      } else {
        const video = await models.videos.create({ kind: "reel", status: "draft", authorId: actor.id,
          title_en: "Original", title_ar: "Original" });
        videoId = String(video._id);
        initial = await service.createSession({ videoId, actor, file, idempotencyKey: randomUUID() });
        selected = initial;
      }
      const ownerModel = owner === "product" ? models.placements : models.videos;
      const originalOwner = await ownerModel.findById(videoId);
      const activeAssetId = originalOwner.activeAssetId;
      if (purpose === "replacement") {
        if (prepareCurrentAsset) await prepareCurrentAsset({ upload: initial.upload, guid: created[0], assetId: activeAssetId });
        await models.assets.updateOne({ _id: activeAssetId }, { $set: { technicalState: "ready", providerStatus: 4 } });
        await ownerModel.updateOne({ _id: videoId }, { $set: owner === "product" ? { lifecycleState: "ready" }
          : { status: "published", publishedAt: new Date(currentTime()) } });
        selected = owner === "product" ? await service.createReplacementUploadSession({ productId: String(productId),
          videoId, actorId: actor.id, file, idempotencyKey: randomUUID() })
          : await service.createSession({ videoId, actor, file, purpose, idempotencyKey: randomUUID() });
      }
      const generation = owner === "product" ? await (purpose === "replacement" ? models.replacements.findById(selected.replacementId)
        : models.placements.findById(videoId)) : await models.sessions.findById(selected.sessionId);
      const deadline = generation.abandonAt.getTime();
      if (terminateResource) {
        await terminateResource({ upload: selected.upload, guid: created.at(-1) });
        now = Date.now();
      } else now += 6 * 60 * 60 * 1_000 + 1_000;
      request = owner === "product" ? { productId: String(productId), videoId, actorId: actor.id,
        ...(purpose === "replacement" ? { replacementId: selected.replacementId } : {}) }
        : { videoId, sessionId: selected.sessionId, actor, purpose };
      request = { ...request, file, idempotencyKey: randomUUID() };
      const runtime = createVideoProviderRuntime({ provider, now: currentTime,
        assets: createVideoAssetObserver({ model: models.assets, now: currentTime,
          ...(owner === "product" ? { onDeleted: asset => service.handleDeletedAsset(asset) } : {}) }),
        operations: {
          claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations, now: new Date(currentTime()) }),
          complete: input => completeVideoProviderOperation({ ...input, model: models.operations, now: new Date(currentTime()) }),
          fail: input => failVideoProviderOperation({ ...input, model: models.operations, now: new Date(currentTime()) }),
        } });
      const countBefore = created.length;
      assert.equal((await service.recoverUploadSession(request)).status, "recovering");
      assert.equal(created.length, countBefore);
      assert.equal((await service.recoverUploadSession(request)).status, "recovering");
      for (const id of jobs.splice(0)) {
        const outcome = await runtime.process(String(id));
        assert.equal(outcome.status, "completed");
      }
      const recovered = await service.recoverUploadSession(request);
      assert.equal(recovered.status, "awaiting_upload");
      assert.equal(created.length, countBefore + 1);
      assert.equal(owner === "product" ? recovered.productVideoId : recovered.sessionId,
        owner === "product" ? videoId : selected.sessionId);
      if (purpose === "replacement" && owner === "product") assert.equal(recovered.replacementId, selected.replacementId);
      const after = owner === "product" ? await (purpose === "replacement" ? models.replacements.findById(selected.replacementId)
        : models.placements.findById(videoId)) : await models.sessions.findById(selected.sessionId);
      assert.equal(after.abandonAt.getTime(), deadline);
      assert.ok((await service.recoverUploadSession(request)).upload.uploadUrl === recovered.upload.uploadUrl,
        "Recovery replay must retain the same TUS resource");
      if (purpose === "replacement") {
        assert.equal(String((await ownerModel.findById(videoId)).activeAssetId), String(activeAssetId));
        assert.equal((await models.assets.findById(activeAssetId)).technicalState, "ready");
        assert.equal((await provider.getVideo(created[0])).guid, created[0]);
      }
      await onCaseComplete?.({ owner, purpose });
    });
  }
}
