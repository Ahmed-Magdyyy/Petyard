import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import dotenvx from "@dotenvx/dotenvx";
import mongoose from "mongoose";
import sharp from "sharp";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { ProductVideoModel } from "../../../../src/domains/videos/productVideos/productVideo.model.js";
import { ProductVideoUploadBatchModel } from "../../../../src/domains/videos/productVideos/productVideoUploadBatch.model.js";
import { ProductVideoReplacementModel } from "../../../../src/domains/videos/productVideos/productVideoReplacement.model.js";
import { ProductVideoUploadRecoveryModel } from "../../../../src/domains/videos/productVideos/productVideoUploadRecovery.model.js";
import { VideoAssetModel } from "../../../../src/domains/videos/provider/videoAsset.model.js";
import { VideoProviderOperationModel } from "../../../../src/domains/videos/provider/videoProviderOperation.model.js";
import { VideoUploadAttemptModel } from "../../../../src/domains/videos/provider/videoUploadAttempt.model.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { EditorialCoverModel } from "../../../../src/domains/videos/editorial/editorialCover.model.js";
import { ReelUploadSessionModel } from "../../../../src/domains/videos/reels/reelUploadSession.model.js";
import { ReelResourceRecoveryModel } from "../../../../src/domains/videos/reels/reelResourceRecovery.model.js";
import { createBunnyStreamAdapter } from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";
import { getVideosStreamConfiguration } from "../../../../src/domains/videos/provider/streamConfig.js";
import { recordVideoProviderOperation } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { verifyVideoDatabaseUploadRecovery } from "./fixtures/videoDatabaseUploadRecovery.js";
import { verifyVideoLiveWebhook } from "./fixtures/videoLiveWebhookAcceptance.js";
import { verifyVideoLiveMedia } from "./fixtures/videoLiveMediaAcceptance.js";
import { verifyVideoReplacementRaces } from "./fixtures/videoReplacementRaces.js";
import { verifyVideoEditorialOrphanAcceptance } from "./fixtures/videoEditorialOrphanAcceptance.js";
import { createEditorialCoverStore } from "../../../../src/domains/videos/editorial/editorialCover.store.js";
import { getMediaConfiguration } from "../../../../src/shared/utils/mediaConfig.js";
import { uploadImage } from "../../../../src/shared/utils/imageUpload.js";
import { uploadBunnyObject, deleteBunnyObject, downloadBunnyObject, buildBunnyStorageUrl } from "../../../../src/shared/utils/bunnyStorage.js";

const followup = process.env.VIDEOS_LIVE_RECOVERY_FOLLOWUP === "true";
const mediaScope = process.env.VIDEOS_LIVE_MEDIA_ACCEPTANCE === "true";
const replacementRaces = process.env.VIDEOS_LIVE_REPLACEMENT_RACES === "true";
const editorialOrphan = process.env.VIDEOS_LIVE_EDITORIAL_ORPHAN === "true";
const portraitRetryMode = process.env.VIDEOS_LIVE_MEDIA_PORTRAIT_RETRY;
assert.ok([undefined, "false", "true", "second", "deletion"].includes(portraitRetryMode), "Unknown portrait retry scope");
const portraitRetry = ["true", "second", "deletion"].includes(portraitRetryMode);
assert.ok(!portraitRetry || mediaScope, "Portrait retry requires the media acceptance mode");
assert.ok(!(followup && mediaScope));
assert.ok(!(replacementRaces && (followup || mediaScope)));
assert.ok(!(editorialOrphan && (replacementRaces || followup || mediaScope)));
const allocationLimit = editorialOrphan || replacementRaces ? 4 : portraitRetry ? 1 : mediaScope ? 2 : followup ? 5 : 10;
const directory = new URL(editorialOrphan ? "../../../../scripts/videos-live-editorial-orphan-20261009/" : replacementRaces ? "../../../../scripts/videos-live-replacement-races-20261009/" : portraitRetryMode === "deletion" ? "../../../../scripts/videos-live-deletion-race-20261009/" : portraitRetryMode === "second" ? "../../../../scripts/videos-live-portrait-retry-second-20261009/" : portraitRetry ? "../../../../scripts/videos-live-portrait-retry-20261009/" : mediaScope ? "../../../../scripts/videos-live-media-acceptance-20261009/" : followup
  ? "../../../../scripts/videos-live-recovery-followup-20261009/"
  : "../../../../scripts/videos-live-recovery-acceptance-20261009/", import.meta.url);
const manifest = new URL("private.json", directory);
const unix = () => Math.floor(Date.now() / 1000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = input => createHash("sha256").update(input).digest("hex");
function loadConfiguration() {
  const environment = {};
  dotenvx.config({ path: ".env", envKeysFile: ".env.keys", processEnv: environment,
    quiet: true, strict: true, noOps: true, logLevel: "error" });
  const config = getVideosStreamConfiguration(environment);
  assert.ok(config.stream && config.stream.libraryId === "754739");
  assert.ok(Object.values(config.flags).every(flag => !flag));
  const media = readFileSync(new URL("../../../../scripts/bunny-tus-media-canary/synthetic-two-second.mp4", import.meta.url));
  assert.equal(hash(media), "38769e110542ce0f0d0fbe813b6eaf26de7acb20eabb9abdc5962d6367a5dc1c");
  const additionalMedia = {};
  if (mediaScope) {
    for (const [key, filename, expectedHash] of [
      ["portrait", "videos-synthetic-portrait-20261009/synthetic-portrait.mp4", "dc2b9855692b6de8b479dcd06924a5dfc92e5db007f9f3d137c6941f7b43b930"],
      ["overLimit", "videos-synthetic-over-limit-20261009/synthetic-over-limit.mp4", "aca800c95fee22fa473f5fe321d7aea9f23358600a1d890dfe63457a73c50320"],
    ]) {
      const bytes = readFileSync(new URL(`../../../../scripts/${filename}`, import.meta.url));
      assert.equal(hash(bytes), expectedHash); additionalMedia[key] = bytes;
    }
  }
  let mediaConfiguration;
  if (editorialOrphan) {
    mediaConfiguration = getMediaConfiguration(environment);
    assert.equal(mediaConfiguration.publicProvider, "bunny");
    assert.equal(mediaConfiguration.public.zone, "petyardpublicmedia");
  }
  return { stream: config.stream, media, mediaConfiguration, ...additionalMedia };
}
if (process.argv.includes("--preflight")) {
  const { stream, media, portrait, overLimit } = loadConfiguration();
  console.log(JSON.stringify({ ready: true, library: stream.libraryId, maxAllocations: allocationLimit,
    temporaryCollections: 12, flagsOff: true, syntheticBytes: media.length,
    priorScopeExists: existsSync(manifest), noNetworkCalls: true,
    ...(editorialOrphan ? { maxImageObjects: 2 } : {}),
    ...(mediaScope ? { portraitBytes: portrait.length, overLimitBytes: overLimit.length } : {}) }));
}

test(editorialOrphan ? "real Bunny and copied-Mongo editorial cover cutover and orphan adoption" : replacementRaces ? "real Bunny and copied-Mongo replacement deletion/cancellation races" : "real Bunny and copied-Mongo initial/replacement non-resumable recovery", {
  skip: process.env.VIDEOS_LIVE_RECOVERY_ENABLED !== "true", timeout: editorialOrphan || replacementRaces ? 600_000 : 240_000,
}, async t => {
  const uri = process.env.VIDEOS_ACCEPTANCE_MONGO_URI;
  assert.ok(uri, "Explicit copied Mongo URI required; never use ambient .env database");
  const { stream, media, portrait, overLimit, mediaConfiguration } = loadConfiguration();
  const cleanupOnly = process.env.VIDEOS_LIVE_RECOVERY_CLEANUP_ONLY === "true";
  const continueScope = process.env.VIDEOS_LIVE_RECOVERY_CONTINUE === "true";
  assert.ok(!(cleanupOnly && continueScope));
  assert.ok(!(followup && continueScope));
  assert.ok(!(mediaScope && continueScope));
  assert.ok(!(replacementRaces && continueScope));
  assert.ok(!(editorialOrphan && continueScope));
  let state;
  if (cleanupOnly || continueScope) {
    state = JSON.parse(readFileSync(manifest)); assert.equal(state.uriHash, hash(uri));
    assert.equal(state.library, stream.libraryId);
    assert.match(state.prefix, /^videos_live_recovery_[a-f\d]{24}$/);
    if (continueScope) {
      assert.equal(state.videos.length, 5, "Only the failed five-allocation scope can continue");
      assert.ok(state.videos.every(video => video.absent && (video.tusAbsent || video.tusWriteDenied)));
      assert.equal(state.envHash, hash(readFileSync(".env")));
    }
  } else {
    assert.ok(!existsSync(manifest), "Scope consumed or uncertain: cleanup only, never allocate again");
    mkdirSync(directory, { recursive: true });
    state = { prefix: `videos_live_recovery_${randomBytes(12).toString("hex")}`,
      library: stream.libraryId, uriHash: hash(uri), envHash: hash(readFileSync(".env")),
      collections: [], videos: [], objects: [], evidence: [], requests: 0 };
  }
  const save = () => {
    writeFileSync(new URL("private.tmp", directory), JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(new URL("private.tmp", directory), manifest);
  };
  const record = (check, data = {}) => {
    state.evidence.push({ check, ...data }); save(); console.log(JSON.stringify({ check, ...data }));
  };
  save();
  const requireOwned = (snapshot, video) => {
    assert.equal(snapshot.guid, video.guid);
    assert.ok(snapshot.title === video.title || (video.submittedTitle && snapshot.title === video.submittedTitle),
      "Provider title must match this run's creation or exact submitted TUS title");
    assert.equal(String(snapshot.videoLibraryId), stream.libraryId);
  };
  let requestCount = 0, cleanupRequests = 0, cleanupPhase = false;
  const guardedFetch = async (url, options = {}) => {
    // Reserve cleanup requests even when the work exhausts its polling budget.
    if (cleanupPhase) assert.ok(++cleanupRequests <= allocationLimit * 8 + 8 + (editorialOrphan ? 10 : 0), "Bounded cleanup request budget exceeded");
    else assert.ok(++requestCount <= 180, "Bounded provider request budget exceeded");
    state.requests++;
    const parsed = new URL(url), method = options.method || "GET";
    if (parsed.origin === `https://${stream.cdnHostname}`) {
      assert.equal(method, "GET");
      assert.ok((mediaScope && state.playbackUrls?.includes(String(url))) || (editorialOrphan &&
        state.videos.some(video => video.guid && parsed.pathname.endsWith(`/${video.guid}/playlist.m3u8`))),
      "Only this run's synthetic-media playback URLs may be read");
      return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store" });
    }
    const base = `/library/${stream.libraryId}/videos`;
    assert.equal(parsed.origin, "https://video.bunnycdn.com");
    if (parsed.pathname === base && method === "POST") {
      const title = JSON.parse(options.body).title;
      assert.ok(/^petyard-(?:product-(?:video|replacement|recovery)|reel-(?:session|recovery)):[a-f\d]{24}$/.test(title));
      assert.ok(state.videos.length < allocationLimit);
      state.videos.push({ title, requested: true }); save();
    } else if (parsed.pathname === base && method === "GET") {
      assert.ok(state.videos.some(video => video.title === parsed.searchParams.get("search")));
    } else if (parsed.pathname.startsWith(`${base}/`)) {
      assert.ok(["GET", "DELETE"].includes(method));
      assert.ok(state.videos.some(video => video.guid && parsed.pathname === `${base}/${video.guid}`));
    } else if (parsed.pathname === "/tusupload" && method === "POST") {
      const video = state.videos.find(video => video.guid === options.headers.VideoId);
      assert.ok(video && !video.tusRequested); video.tusRequested = true; save();
    } else {
      assert.ok(["HEAD", "PATCH", "DELETE"].includes(method));
      assert.ok(state.videos.some(video => video.uploadUrl === String(url)));
    }
    return fetch(url, { ...options, redirect: "error", signal: options.signal || AbortSignal.timeout(15_000) });
  };
  const adapter = createBunnyStreamAdapter({ ...stream, http: guardedFetch });
  const provider = { ...adapter,
    async createVideo(input) {
      const result = await adapter.createVideo(input);
      const video = state.videos.find(video => video.title === input.title && !video.guid);
      assert.ok(video); video.guid = result.guid; save(); requireOwned(result, video); return result;
    },
    async createTusUpload(input) {
      const video = state.videos.find(video => video.guid === input.videoId);
      assert.ok(video); video.submittedTitle = input.title; save();
      const result = await adapter.createTusUpload(input);
      video.uploadUrl = result.uploadUrl; save(); return result;
    },
    async getVideo(guid) {
      const result = await adapter.getVideo(guid);
      requireOwned(result, state.videos.find(video => video.guid === guid)); return result;
    },
    async terminateTusUpload(input) {
      const result = await adapter.terminateTusUpload(input);
      const head = await adapter.inspectTusUpload({ ...input, expiresAt: unix() + 60 });
      const video = state.videos.find(video => video.guid === input.videoId);
      if ((mediaScope || replacementRaces || editorialOrphan) && head.state === "complete") video.tusTerminationAccepted = true;
      else { assert.equal(head.state, "not_found"); video.tusAbsent = true; }
      save(); return result;
    },
  };
  const connection = mongoose.createConnection(uri, { autoCreate: false, autoIndex: false,
    serverSelectionTimeoutMS: 15_000 });
  const models = {};
  const imageTransport = { async request(options) {
    assert.ok(editorialOrphan);
    const method = options.method.toUpperCase();
    assert.ok(["PUT", "GET", "DELETE"].includes(method));
    assert.ok(state.objects?.some(object => options.url === buildBunnyStorageUrl({ ...mediaConfiguration.public, objectKey: object.key })));
    assert.equal(options.headers.AccessKey, mediaConfiguration.public.accessKey);
    if (cleanupPhase) assert.ok(++cleanupRequests <= 50, "Bounded cleanup request budget exceeded");
    else assert.ok(++requestCount <= 180, "Bounded provider request budget exceeded");
    state.requests++;
    const response = await fetch(options.url, { method, headers: options.headers, body: options.data,
      redirect: "error", signal: AbortSignal.timeout(15000) });
    const data = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), data };
  } };
  const coverStore = editorialOrphan ? createEditorialCoverStore({ configuration: () => mediaConfiguration,
    upload: (file, options) => uploadImage(file, { ...options, bunnyUpload: async input => {
      assert.match(input.objectKey, /^petyard\/video-covers\/[a-f\d]{24}\.webp$/);
      const id = input.objectKey.split("/").at(-1).slice(0, -5);
      assert.ok(await models.covers.exists({ _id: id }), "Cover must be reserved in this run's cloned collection");
      assert.ok(state.objects.length < 2 && !state.objects.some(object => object.key === input.objectKey));
      state.objects.push({ key: input.objectKey, id, requested: true }); save();
      return uploadBunnyObject({ ...input, transport: imageTransport });
    } }), remove: input => deleteBunnyObject({ ...input, transport: imageTransport }),
  }) : undefined;
  const readImageCdn = async object => {
    assert.ok(editorialOrphan && state.objects.includes(object));
    if (cleanupPhase) assert.ok(++cleanupRequests <= 50, "Bounded cleanup request budget exceeded");
    else assert.ok(++requestCount <= 180, "Bounded provider request budget exceeded");
    state.requests++;
    const response = await fetch(`${mediaConfiguration.public.cdnBaseUrl}/${object.key}`,
      { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000) });
    await response.body?.cancel(); return response.status;
  };
  const verifyCoverAbsent = async cover => {
    const object = state.objects.find(object => object.id === String(cover._id)); assert.ok(object);
    const response = await imageTransport.request({ method: "GET",
      url: buildBunnyStorageUrl({ ...mediaConfiguration.public, objectKey: object.key }),
      headers: { AccessKey: mediaConfiguration.public.accessKey } });
    assert.equal(response.status, 404); object.absent = true; save();
    // Public CDN cache lifetime is separate from authoritative origin deletion.
    object.cdnStatusAfterOriginDelete = await readImageCdn(object);
    assert.ok([200, 404].includes(object.cdnStatusAfterOriginDelete)); save();
  };
  try {
    try { await connection.asPromise(); }
    catch (error) { throw new Error(`Live recovery connection failed (${error?.name || "connection error"})`); }
    if (!cleanupOnly) {
      assert.equal((await connection.db.listCollections({ name: { $regex: `^${state.prefix}_` } }).toArray()).length, 0);
      const originals = { products: ProductModel, placements: ProductVideoModel, batches: ProductVideoUploadBatchModel,
        replacements: ProductVideoReplacementModel, recoveries: ProductVideoUploadRecoveryModel,
        assets: VideoAssetModel, operations: VideoProviderOperationModel, attempts: VideoUploadAttemptModel,
        videos: EditorialVideoModel, covers: EditorialCoverModel, sessions: ReelUploadSessionModel,
        reelRecoveries: ReelResourceRecoveryModel };
      for (const [key, original] of Object.entries(originals)) {
        const name = `${state.prefix}_${original.collection.name}`;
        if (!state.collections.includes(name)) state.collections.push(name);
        save();
        // The validator marker proves ownership even if Mongo's create response is lost.
        await connection.db.createCollection(name, {
          validator: { $jsonSchema: { bsonType: "object", description: state.prefix } },
        });
        models[key] = connection.model(original.modelName, original.schema.clone(), name);
        await models[key].createIndexes();
      }
      const recordOperation = input => recordVideoProviderOperation({ ...input, model: models.operations });
      let completedCases = 0;
      if (editorialOrphan) {
        completedCases = await verifyVideoEditorialOrphanAcceptance(t, { models, connection, libraryId: stream.libraryId,
          recordOperation, provider, http: guardedFetch, media, coverStore, verifyCoverAbsent, record,
          verifyCover: async cover => {
            const object = state.objects.find(object => object.id === String(cover._id)); assert.ok(object);
            const bytes = await downloadBunnyObject({ ...mediaConfiguration.public, objectKey: object.key, transport: imageTransport });
            const metadata = await sharp(bytes).metadata(); assert.equal(metadata.format, "webp");
            assert.ok(metadata.height > metadata.width);
            assert.equal(await readImageCdn(object), 200);
          } });
        assert.equal(state.objects.length, 2);
      } else if (replacementRaces) {
        completedCases = await verifyVideoReplacementRaces(t, { models, connection, libraryId: stream.libraryId,
          recordOperation, provider, http: guardedFetch, media, record });
      } else if (mediaScope) {
        completedCases = await verifyVideoLiveMedia(t, { models, connection, provider, recordOperation, stream, portrait, overLimit, portraitOnly: portraitRetry,
          deletionOnly: portraitRetryMode === "deletion",
          http: guardedFetch, record, registerPlaybackUrl: href => {
            const parsed = new URL(href);
            assert.equal(parsed.origin, `https://${stream.cdnHostname}`);
            assert.ok(state.videos.some(video => video.guid && parsed.pathname.endsWith(`/${video.guid}/playlist.m3u8`)));
            (state.playbackUrls ||= []).push(href); save();
          } });
      } else await verifyVideoDatabaseUploadRecovery(t, { models, connection, libraryId: stream.libraryId,
        recordOperation, liveProvider: provider, mediaBytes: media.length,
        ...(followup ? { cases: ["product:replacement", "reel:initial"] }
          : continueScope ? { cases: ["product:initial", "reel:replacement"] } : {}),
        onCaseComplete: data => { completedCases++; record("recovery-case-passed", data); },
        async prepareCurrentAsset({ upload, guid, assetId }) {
          const response = await guardedFetch(upload.uploadUrl, { method: "PATCH", body: media,
            headers: { ...upload.headers, "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" } });
          await response.body?.cancel(); assert.equal(response.status, 204);
          assert.equal(Number(response.headers.get("Upload-Offset")), media.length);
          let snapshot;
          for (let i = 0; i < 30; i++) {
            snapshot = await provider.getVideo(guid);
            if (snapshot.status === 4 || [5, 6].includes(snapshot.status)) break;
            await pause(2000);
          }
          assert.equal(snapshot.status, 4);
          if (followup) {
            await verifyVideoLiveWebhook({ models, provider, recordOperation, stream, guid, assetId, snapshot });
            record("local-webhook-provider-reconciliation", { signedReplays: 2, durableHints: 1, enqueueLossRecovered: true });
          } else {
            await createVideoAssetObserver({ model: models.assets }).applySnapshot({
              operation: { assetId, libraryId: stream.libraryId, providerGuid: guid }, snapshot });
          }
          assert.equal((await models.assets.findById(assetId)).technicalState, "ready");
        },
        async terminateResource({ upload, guid }) {
          const result = await provider.terminateTusUpload({ videoId: guid, uploadUrl: upload.uploadUrl });
          assert.ok(["terminated", "not_found"].includes(result.state));
          const head = await provider.inspectTusUpload({ videoId: guid, uploadUrl: upload.uploadUrl, expiresAt: unix() + 60 });
          assert.equal(head.state, "not_found");
        },
      });
      assert.equal(state.videos.length, allocationLimit);
      const expectedCases = editorialOrphan ? 3 : portraitRetry ? 1 : replacementRaces || mediaScope || continueScope || followup ? 2 : 4;
      record("completed-case-count", { completedCases, expectedCases });
      assert.equal(completedCases, expectedCases, "Every selected case must pass before recording combined acceptance");
      record(editorialOrphan ? "combined-editorial-orphan-checks" : replacementRaces ? "combined-replacement-race-checks" : mediaScope ? "combined-media-checks" : "combined-recovery-checks",
        { completedCases, allocations: allocationLimit });
    }
  } finally {
    cleanupPhase = true;
    const failures = [];
    for (const object of state.objects || []) {
      if (object.absent) continue;
      try {
        await coverStore.remove({ coverId: object.id, storage: coverStore.identity() });
        await verifyCoverAbsent({ _id: object.id });
      } catch (error) { failures.push({ kind: "image", name: error?.name || "Error", code: error?.code || null }); }
    }
    for (const video of state.videos) {
      if (video.absent && (!video.uploadUrl || video.tusAbsent || video.tusWriteDenied)) continue;
      try {
        if (!video.guid) {
          const search = video.title.startsWith("petyard-product") ? adapter.searchProductReservation : adapter.searchReelReservation;
          const result = await search({ providerTitle: video.title });
          const matches = result.items?.filter(item => item.title === video.title) || [];
          assert.equal(matches.length, 1); video.guid = matches[0].guid; save();
        }
        if (!video.absent) {
          try { await provider.getVideo(video.guid); }
          catch (error) { if (error.status !== 404) throw error; video.absent = true; save(); }
        }
        assert.ok(!video.tusRequested || video.uploadUrl, "Unknown TUS location retains cleanup obligation");
        if (video.uploadUrl && !video.tusAbsent && !video.tusTerminationAccepted) {
          const terminated = await adapter.terminateTusUpload({ videoId: video.guid, uploadUrl: video.uploadUrl });
          assert.ok(["terminated", "not_found"].includes(terminated.state));
          video.tusTerminationAccepted = true; save();
        }
        if (!video.absent) {
          await provider.deleteVideo(video.guid);
          try { await provider.getVideo(video.guid); }
          catch (error) { if (error.status !== 404) throw error; video.absent = true; save(); }
        }
        assert.ok(video.absent);
        if (video.uploadUrl && !video.tusAbsent) {
          const head = await adapter.inspectTusUpload({ videoId: video.guid, uploadUrl: video.uploadUrl, expiresAt: unix() + 60 });
          video.cleanupHeadState = head.state; save();
          if (head.state === "not_found") video.tusAbsent = true;
          else {
            // Bunny retains completed metadata after deletion; verify media absence and write denial separately.
            assert.equal(head.state, "complete");
            const grant = adapter.createTusUploadAuthorization({ videoId: video.guid, expiresAt: unix() + 60 });
            const response = await guardedFetch(video.uploadUrl, { method: "PATCH", body: Buffer.from([0]),
              headers: { ...grant.headers, "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": String(head.offsetBytes) } });
            await response.body?.cancel();
            video.cleanupWriteStatus = response.status; save();
            assert.ok([401, 403, 404, 410].includes(response.status),
              "Deleted video must deny authorization or report the TUS resource absent");
            video.tusWriteDenied = true;
          }
          save();
        }
      } catch (error) { failures.push({ kind: "provider", name: error?.name || "Error", code: error?.code || null,
        status: error?.status || null, observedStatus: Number.isInteger(error?.actual) ? error.actual : null }); }
    }
    if (connection.readyState === 1) {
      for (const name of state.collections) {
        try { assert.ok(name.startsWith(`${state.prefix}_`));
          const metadata = await connection.db.listCollections({ name }).toArray();
          if (!metadata.length) continue;
          assert.equal(metadata[0].options?.validator?.$jsonSchema?.description, state.prefix,
            "Only collections carrying this run's ownership marker may be removed");
          try { await connection.dropCollection(name); } catch (error) { if (error.code !== 26) throw error; }
        } catch (error) { failures.push({ kind: "collection", name: error?.name || "Error" }); }
      }
      try { assert.equal((await connection.db.listCollections({ name: { $regex: `^${state.prefix}_` } }).toArray()).length, 0); }
      catch (error) { failures.push({ kind: "collection-verification", name: error?.name || "Error" }); }
    } else if (state.collections.length) failures.push({ kind: "Mongo-unavailable", name: "CleanupRetained" });
    await connection.close();
    record("combined-cleanup", { failures, ownedVideos: state.videos.length,
      ...(editorialOrphan ? { ownedImages: state.objects.length, imageAbsences: state.objects.filter(object => object.absent).length,
        cdnStatusesAfterOriginDelete: state.objects.map(object => object.cdnStatusAfterOriginDelete ?? null) } : {}),
      providerAbsences: state.videos.filter(video => video.absent).length,
      tusAbsences: state.videos.filter(video => video.tusAbsent).length,
      completedTusMetadataRetained: state.videos.filter(video => video.tusWriteDenied && !video.tusAbsent).length,
      envUnchanged: state.envHash === hash(readFileSync(".env")) });
    assert.deepEqual(failures, [], "Retain manifest and run cleanup only; no fresh allocations");
    assert.equal(state.envHash, hash(readFileSync(".env")));
  }
});
