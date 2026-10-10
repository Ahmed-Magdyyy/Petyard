// Explicit operational canary; not imported by the normal test suite or application.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import dotenvx from "@dotenvx/dotenvx";
import sharp from "sharp";
import { createBunnyStreamAdapter } from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";
import { getVideosStreamConfiguration } from "../../../../src/domains/videos/provider/streamConfig.js";
import { getMediaConfiguration } from "../../../../src/shared/utils/mediaConfig.js";
import { createVideoPosterStore } from "../../../../src/domains/videos/provider/videoPoster.store.js";
import { createEditorialCoverStore } from "../../../../src/domains/videos/editorial/editorialCover.store.js";
import { downloadBunnyObject, buildBunnyStorageUrl } from "../../../../src/shared/utils/bunnyStorage.js";
import { uploadImage } from "../../../../src/shared/utils/imageUpload.js";
import { createYouTubeVerifier } from "../../../../src/domains/videos/editorial/youtubeVerifier.js";

const mode = process.argv[2];
const directory = new URL("../../../../scripts/videos-provider-acceptance-20261009/", import.meta.url);
const manifest = new URL("private.json", directory);
const unix = () => Math.floor(Date.now() / 1000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashEnv = () => createHash("sha256").update(readFileSync(".env")).digest("hex");
const safeError = error => ({ name: error?.name || "Error", code: error?.code || null,
  status: Number.isInteger(error?.status) ? error.status : error?.statusCode || null });
let state, provider, stream, mediaConfig, poster, cover;
const save = () => {
  writeFileSync(new URL("private.tmp", directory), JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(new URL("private.tmp", directory), manifest);
};
const record = (check, result = {}) => {
  const item = { check, at: new Date().toISOString(), ...result };
  state.evidence.push(item); save(); console.log(JSON.stringify(item));
};
function requireOwned(snapshot, video) {
  assert.equal(snapshot.guid, video.id);
  assert.equal(snapshot.title, video.title);
  assert.equal(String(snapshot.videoLibraryId), stream.libraryId);
}
let requestCount = 0;
async function guardedFetch(url, options = {}) {
  assert.ok(++requestCount <= 170, "Provider request budget exhausted");
  const parsed = new URL(url);
  const method = options.method || "GET";
  const base = `/library/${stream.libraryId}/videos`;
  if (parsed.origin === "https://video.bunnycdn.com") {
    if (parsed.pathname === base && method === "POST") {
      assert.ok(state.videos.length <= 3);
      const title = JSON.parse(options.body).title;
      const video = state.videos.find(v => v.title === title && v.creationRequested && !v.postSent);
      assert.ok(video, "Allocation must be recorded and cannot be retried");
      video.postSent = true; save();
    } else if (parsed.pathname === base && method === "GET") {
      assert.ok(state.videos.some(v => v.title === parsed.searchParams.get("search")));
    } else if (parsed.pathname.startsWith(`${base}/`)) {
      assert.ok(["GET", "DELETE"].includes(method));
      assert.ok(state.videos.some(v => v.id && parsed.pathname === `${base}/${v.id}`));
    } else if (parsed.pathname === "/tusupload" && method === "POST") {
      assert.ok(state.videos.some(v => v.id === options.headers.VideoId && !v.tusRequested));
      state.videos.find(v => v.id === options.headers.VideoId).tusRequested = true; save();
    } else {
      assert.ok(["PATCH", "HEAD", "DELETE"].includes(method));
      assert.ok(state.videos.some(v => v.uploadUrl === String(url)));
    }
  } else {
    assert.equal(parsed.origin, `https://${stream.cdnHostname}`);
    assert.equal(method, "GET");
    assert.ok(state.videos.some(v => v.id && parsed.pathname.includes(`/${v.id}/`)));
  }
  return fetch(url, { ...options, redirect: "error",
    signal: options.signal || AbortSignal.timeout(stream.requestTimeoutMs) });
}
async function allocate(label, bytes) {
  const video = { label, title: `petyard-reel-session:${randomBytes(12).toString("hex")}`,
    creationRequested: true };
  assert.ok(state.videos.length < 3);
  state.videos.push(video); save();
  const created = await provider.createVideo({ title: video.title });
  video.id = created.guid; save(); requireOwned(created, video);
  const upload = await provider.createTusUpload({ videoId: video.id, sizeBytes: bytes.length,
    mimeType: "video/mp4", title: video.title, expiresAt: unix() + 120 });
  video.uploadUrl = upload.uploadUrl; save();
  record(`${label}:allocated`, { identityVerified: true, bytes: bytes.length });
  return video;
}
async function patch(video, offset, bytes, expiresAt) {
  const authorization = provider.createTusUploadAuthorization({ videoId: video.id, expiresAt });
  const response = await guardedFetch(video.uploadUrl, { method: "PATCH", headers: {
    ...authorization.headers, "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream",
    "Upload-Offset": String(offset) }, body: bytes });
  await response.body?.cancel();
  assert.equal(response.status, 204);
  assert.equal(Number(response.headers.get("Upload-Offset")), offset + bytes.length);
}
async function waitStatus(video, accepted) {
  for (let i = 0; i < 45; i++) {
    const snapshot = await provider.getVideo(video.id); requireOwned(snapshot, video);
    if (accepted.includes(snapshot.status)) return snapshot;
    if (snapshot.status === 5 || snapshot.status === 6) return snapshot;
    await pause(5000);
  }
  throw new Error("Processing did not reach an accepted status in the bounded window");
}
async function verifyStored(object) {
  const buffer = await downloadBunnyObject({ ...mediaConfig.public, objectKey: object.key,
    timeoutMs: mediaConfig.storageTimeoutMs });
  const metadata = await sharp(buffer).metadata(); assert.equal(metadata.format, "webp");
  const response = await fetch(`${mediaConfig.public.cdnBaseUrl}/${object.key}`,
    { redirect: "error", signal: AbortSignal.timeout(15000) });
  await response.body?.cancel(); assert.equal(response.status, 200);
  record(`${object.kind}:stored`, { authenticatedRead: true, cdnRead: true,
    width: metadata.width, height: metadata.height });
}
async function cleanup() {
  for (const object of state.objects) {
    if (object.absent) continue;
    try {
      if (object.kind === "poster") await poster.remove({ assetId: object.id });
      else await cover.remove({ coverId: object.id, storage: cover.identity() });
      const response = await fetch(buildBunnyStorageUrl({ ...mediaConfig.public, objectKey: object.key }),
        { headers: { AccessKey: mediaConfig.public.accessKey }, redirect: "error",
          signal: AbortSignal.timeout(15000) });
      await response.body?.cancel(); object.absent = response.status === 404;
      record(`${object.kind}:cleanup`, { absent: object.absent });
    } catch (error) { record(`${object.kind}:cleanup-error`, safeError(error)); }
  }
  for (const video of state.videos) {
    if (video.absent && (!video.uploadUrl || video.tusAbsent)) continue;
    try {
      // A lost creation response is discovered only by this run's exact marker.
      if (!video.id && video.postSent) {
        const result = await provider.searchReelReservation({ providerTitle: video.title });
        const matches = result.items?.filter(v => v.title === video.title) || [];
        assert.equal(matches.length, 1, "Uncertain allocation requires one exact candidate");
        video.id = matches[0].guid; save();
      }
      assert.ok(video.id);
      if (!video.absent) {
        try { const snapshot = await provider.getVideo(video.id); requireOwned(snapshot, video); }
        catch (error) { if (error.status !== 404) throw error; video.absent = true; save(); }
      }
      if (video.uploadUrl && !video.tusAbsent) {
        const terminated = await provider.terminateTusUpload({ videoId: video.id, uploadUrl: video.uploadUrl });
        video.tusAbsent = ["terminated", "not_found"].includes(terminated.state); save();
      }
      if (!video.absent) {
        await provider.deleteVideo(video.id);
        try { await provider.getVideo(video.id); }
        catch (error) { if (error.status !== 404) throw error; video.absent = true; }
      }
      record(`${video.label}:cleanup`, { absent: video.absent === true, tusRemoved: video.tusAbsent === true });
    } catch (error) {
      record(`${video.label}:cleanup-error`, safeError(error));
    }
  }
  const clean = state.objects.every(v => v.absent) && state.videos.every(v => v.absent && (!v.tusRequested || v.tusAbsent));
  record("cleanup-summary", { clean, videos: state.videos.length, objects: state.objects.length,
    envUnchanged: state.envHash === hashEnv(), providerRequests: requestCount });
  assert.ok(clean, "Retain private manifest for unresolved cleanup; do not allocate again");
  assert.equal(state.envHash, hashEnv());
}

try {
  assert.ok(["preflight", "run", "cleanup"].includes(mode));
  const environment = {};
  dotenvx.config({ path: ".env", envKeysFile: ".env.keys", processEnv: environment,
    quiet: true, strict: true, noOps: true, logLevel: "error" });
  const config = getVideosStreamConfiguration(environment); stream = config.stream;
  mediaConfig = getMediaConfiguration(environment);
  assert.ok(stream && Object.values(config.flags).every(v => !v));
  assert.equal(stream.libraryId, "754739");
  assert.equal(mediaConfig.publicProvider, "bunny");
  assert.equal(mediaConfig.public.zone, "petyardpublicmedia");
  const media = readFileSync(new URL("../../../../scripts/bunny-tus-media-canary/synthetic-two-second.mp4", import.meta.url));
  assert.equal(createHash("sha256").update(media).digest("hex"), "38769e110542ce0f0d0fbe813b6eaf26de7acb20eabb9abdc5962d6367a5dc1c");
  if (mode === "preflight") {
    console.log(JSON.stringify({ valid: true, library: stream.libraryId, zone: mediaConfig.public.zone,
      flagsOff: true, allocations: 3, imageKeys: 3, mediaBytes: media.length }));
  } else {
    if (mode === "run") {
      if (existsSync(manifest)) {
        const previous = JSON.parse(readFileSync(manifest));
        assert.ok(previous.videos.length === 0 && previous.objects.length === 0,
          "Canary scope already consumed; use cleanup only");
      }
      mkdirSync(directory, { recursive: true });
      state = { library: stream.libraryId, zone: mediaConfig.public.zone, envHash: hashEnv(), videos: [], objects: [], evidence: [] };
      save();
    } else {
      state = JSON.parse(readFileSync(manifest));
      assert.equal(state.library, stream.libraryId); assert.equal(state.zone, mediaConfig.public.zone);
    }
    provider = createBunnyStreamAdapter({ ...stream, http: guardedFetch });
    poster = createVideoPosterStore({ configuration: () => mediaConfig });
    cover = createEditorialCoverStore({ configuration: () => mediaConfig });
    try {
      if (mode === "run") {
        const verifier = createYouTubeVerifier({ apiKey: environment.YOUTUBE_DATA_API_KEY });
        await verifier("dQw4w9WgXcQ"); record("youtube:eligible", { verified: true });
        const video = await allocate("resume", media);
        const split = Math.floor(media.length / 2);
        await patch(video, 0, media.subarray(0, split), unix() + 120);
        const head = await provider.inspectTusUpload({ videoId: video.id, uploadUrl: video.uploadUrl, expiresAt: unix() + 180 });
        assert.equal(head.offsetBytes, split); assert.equal(head.state, "incomplete");
        await pause(1100);
        await patch(video, split, media.subarray(split), unix() + 180);
        const complete = await provider.inspectTusUpload({ videoId: video.id, uploadUrl: video.uploadUrl, expiresAt: unix() + 180 });
        assert.equal(complete.state, "complete"); record("tus:resume-fresh-authorization", { partialOffset: split, complete: true });
        const empty = await allocate("termination", media);
        const terminated = await provider.terminateTusUpload({ videoId: empty.id, uploadUrl: empty.uploadUrl });
        assert.equal(terminated.state, "terminated");
        const absent = await provider.inspectTusUpload({ videoId: empty.id, uploadUrl: empty.uploadUrl, expiresAt: unix() + 180 });
        assert.equal(absent.state, "not_found"); empty.tusAbsent = true; save(); record("tus:termination", { absent: true });
        const invalid = Buffer.alloc(1024);
        const rejected = await allocate("invalid-media", invalid);
        await patch(rejected, 0, invalid, unix() + 180);
        const ready = await waitStatus(video, [4]); assert.equal(ready.status, 4);
        assert.ok(ready.length > 0 && ready.length < 10);
        record("stream:ready", { duration: ready.length, status: ready.status });
        const hls = await provider.probeSignedHls({ videoId: video.id, expiresAt: unix() + 60 });
        assert.ok(hls); record("stream:signed-hls", { playablePlaylist: true });
        const thumbnail = await provider.readThumbnail({ videoId: video.id, fileName: ready.thumbnailFileName });
        assert.ok(thumbnail.length); record("stream:thumbnail", { bytes: thumbnail.length });
        const failure = await waitStatus(rejected, [5, 6]); assert.ok([5, 6].includes(failure.status));
        record("stream:invalid-media-rejected", { status: failure.status });
        const portrait = await sharp({ create: { width: 120, height: 200, channels: 3, background: "#238947" } }).png().toBuffer();
        for (const kind of ["poster", "cover", "lost-ack-cover"]) {
          const id = randomBytes(12).toString("hex");
          const object = { kind, id, key: `petyard/${kind === "poster" ? "video-posters" : "video-covers"}/${id}.webp` };
          state.objects.push(object); save();
          if (kind === "poster") await poster.upload({ assetId: id, buffer: thumbnail });
          else if (kind === "cover") await cover.upload({ coverId: id, buffer: portrait, storage: cover.identity() });
          else {
            const lost = createEditorialCoverStore({ configuration: () => mediaConfig, upload: async (...args) => {
              await uploadImage(...args); throw new Error("Injected lost PUT response after real storage success");
            } });
            await assert.rejects(lost.upload({ coverId: id, buffer: portrait, storage: lost.identity() }), /Injected lost PUT/);
          }
          await verifyStored(object);
        }
        record("acceptance-checks", { passed: true });
      }
    } finally { await cleanup(); }
  }
} catch (error) {
  console.error(JSON.stringify({ failed: true, ...safeError(error) })); process.exitCode = 1;
}
