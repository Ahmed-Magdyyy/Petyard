import { createHash, createHmac } from "node:crypto";

const BUNNY_STREAM_API_ORIGIN = "https://video.bunnycdn.com";
const BUNNY_STREAM_TUS_ENDPOINT = `${BUNNY_STREAM_API_ORIGIN}/tusupload`;
const MAX_HLS_PLAYLIST_BYTES = 64 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

async function readBoundedThumbnail(response) {
  const invalid = () => new BunnyStreamProviderError({ code: "BUNNY_STREAM_INVALID_THUMBNAIL" });
  const mime = response.headers?.get?.("content-type")?.split(";")[0].trim().toLowerCase();
  if (response.status !== 200 || !["image/jpeg", "image/png", "image/webp"].includes(mime) ||
      Number(response.headers?.get?.("content-length")) > MAX_THUMBNAIL_BYTES ||
      typeof response.body?.getReader !== "function") {
    await response.body?.cancel?.();
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_THUMBNAIL_BYTES) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(Buffer.from(value));
    }
    if (!size) throw invalid();
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedPlaylist(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (contentLength > MAX_HLS_PLAYLIST_BYTES) {
    await response.body?.cancel?.();
    return null;
  }
  if (typeof response.body?.getReader !== "function") {
    const text = await response.text();
    return Buffer.byteLength(text) <= MAX_HLS_PLAYLIST_BYTES ? text : null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HLS_PLAYLIST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function isBunnyTusUploadUrl(url) {
  return typeof url === "string" && url.length <= 2048 &&
    /^https:\/\/video\.bunnycdn\.com\/tusupload\/[A-Za-z0-9_-]+$/.test(url);
}

export class BunnyStreamProviderError extends Error {
  constructor({ code, status = null }) {
    super(
      code === "BUNNY_STREAM_TIMEOUT"
        ? "Bunny Stream request timed out"
        : `Bunny Stream request failed with status ${status}`,
    );
    this.name = "BunnyStreamProviderError";
    this.code = code;
    this.status = status;
  }
}

function requireVideoId(videoId) {
  if (typeof videoId !== "string" || !/^[A-Za-z0-9-]+$/.test(videoId)) {
    throw new TypeError("videoId must be a non-empty provider GUID");
  }
  return videoId;
}

function requireExpiration(expiresAt, { now, maxTtlSeconds, purpose }) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new TypeError("expiresAt must be a positive Unix timestamp in seconds");
  }
  const currentUnixSeconds = Math.floor(now() / 1000);
  if (expiresAt <= currentUnixSeconds || expiresAt > currentUnixSeconds + maxTtlSeconds) {
    throw new RangeError(`expiresAt exceeds configured ${purpose} lifetime`);
  }
  return expiresAt;
}

export function createBunnyStreamAdapter({
  libraryId,
  apiKey,
  cdnHostname,
  tokenKey,
  requestTimeoutMs,
  uploadAuthorizationTtlSeconds = 21600,
  playbackTtlSeconds = 900,
  now = Date.now,
  http = fetch,
}) {
  const apiUrl = (videoId = "") =>
    `${BUNNY_STREAM_API_ORIGIN}/library/${encodeURIComponent(libraryId)}/videos${videoId ? `/${encodeURIComponent(requireVideoId(videoId))}` : ""}`;

  async function request(url, options = {}, { responseType = "json", useApiKey = true } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await http(url, {
        ...options,
        headers: {
          ...(useApiKey ? { AccessKey: apiKey } : {}),
          ...options.headers,
        },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new BunnyStreamProviderError({
          code: "BUNNY_STREAM_PROVIDER_ERROR",
          status: response.status,
        });
      }
      if (responseType === "response") return response;
      // Keep the timeout alive through body consumption, not just headers.
      if (responseType === "text") return await readBoundedPlaylist(response);
      if (responseType === "thumbnail") return await readBoundedThumbnail(response);
      return responseType === "none"
        ? { accepted: true, status: response.status }
        : await response.json();
    } catch (error) {
      if (error instanceof BunnyStreamProviderError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new BunnyStreamProviderError({ code: "BUNNY_STREAM_TIMEOUT" });
      }
      throw new BunnyStreamProviderError({
        code: "BUNNY_STREAM_PROVIDER_ERROR",
        status: null,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function searchReservation(providerTitle) {
    const query = new URLSearchParams({ page: "1", itemsPerPage: "10", search: providerTitle });
    return request(`${apiUrl()}?${query}`, { method: "GET" });
  }

  return Object.freeze({
    createVideo({ title }) {
      if (typeof title !== "string" || !title.trim()) {
        throw new TypeError("title must be a non-empty string");
      }
      return request(apiUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
    },
    getVideo(videoId) {
      return request(apiUrl(videoId), { method: "GET" });
    },
    // Read-only orphan discovery. Search is a hint; an exact GET and local
    // ownership checks are required before any cleanup can be recorded.
    searchReelReservation({ providerTitle }) {
      if (typeof providerTitle !== "string" ||
          !/^petyard-reel-(?:session|recovery):[a-f\d]{24}$/.test(providerTitle)) {
        throw new TypeError("Invalid Reel provider marker");
      }
      return searchReservation(providerTitle);
    },
    searchProductReservation({ providerTitle }) {
      if (typeof providerTitle !== "string" ||
          !/^petyard-product-(?:video|replacement|recovery):[a-f\d]{24}$/.test(providerTitle)) {
        throw new TypeError("Invalid Product Video provider marker");
      }
      return searchReservation(providerTitle);
    },
    deleteVideo(videoId) {
      return request(apiUrl(videoId), { method: "DELETE" }, { responseType: "none" });
    },
    // Request-coupled creation only; never automatically retry an uncertain POST.
    async createTusUpload({ videoId, sizeBytes, mimeType, title, expiresAt }) {
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 250 * 1024 * 1024 ||
          !["video/mp4", "video/quicktime"].includes(mimeType) ||
          typeof title !== "string" || !title.trim() || title.length > 200 || /[\x00-\x1F]/.test(title)) {
        throw new TypeError("Invalid TUS upload metadata");
      }
      const authorization = this.createTusUploadAuthorization({ videoId, expiresAt });
      const response = await request(BUNNY_STREAM_TUS_ENDPOINT, {
        method: "POST", headers: { ...authorization.headers, "Tus-Resumable": "1.0.0",
          "Upload-Length": String(sizeBytes),
          "Upload-Metadata": `filetype ${Buffer.from(mimeType).toString("base64")},title ${Buffer.from(title).toString("base64")}` },
      }, { responseType: "response", useApiKey: false });
      const location = response.headers?.get("Location");
      const uploadUrl = typeof location === "string" && /^\/tusupload\/[A-Za-z0-9_-]+$/.test(location)
        ? `${BUNNY_STREAM_API_ORIGIN}${location}` : location;
      if (response.status !== 201 || !isBunnyTusUploadUrl(uploadUrl)) {
        throw new BunnyStreamProviderError({ code: "BUNNY_STREAM_INVALID_TUS_RESPONSE", status: response.status });
      }
      return { uploadUrl, resourceExpiresAt: expiresAt };
    },
    async terminateTusUpload({ videoId, uploadUrl }) {
      if (!isBunnyTusUploadUrl(uploadUrl)) {
        throw new TypeError("Invalid Bunny TUS resource URL");
      }
      // Cleanup credentials stay server-side; they do not extend the resource or client grant.
      const authorization = this.createTusUploadAuthorization({ videoId,
        expiresAt: Math.floor(now() / 1000) + Math.min(uploadAuthorizationTtlSeconds, 60) });
      let response;
      try {
        response = await request(uploadUrl, {
          method: "DELETE", headers: { "Tus-Resumable": "1.0.0", ...authorization.headers },
        }, { responseType: "response", useApiKey: false });
      } catch (error) {
        if (error instanceof BunnyStreamProviderError && error.status === 404) return { state: "not_found" };
        throw error;
      }
      if (response.status !== 204 || response.headers?.get("Tus-Resumable") !== "1.0.0") {
        throw new BunnyStreamProviderError({ code: "BUNNY_STREAM_INVALID_TUS_RESPONSE", status: response.status });
      }
      return { state: "terminated" };
    },
    // Diagnostic only. A TUS URL's existence is not proof of its ownership,
    // provider-video absence, expiry, or safe deletion eligibility.
    async inspectTusUpload({ videoId, uploadUrl, expiresAt }) {
      if (!isBunnyTusUploadUrl(uploadUrl)) {
        throw new TypeError("Invalid Bunny TUS resource URL");
      }
      const authorization = this.createTusUploadAuthorization({ videoId, expiresAt });
      let response;
      try {
        response = await request(uploadUrl, {
          method: "HEAD", headers: { "Tus-Resumable": "1.0.0", ...authorization.headers },
        }, { responseType: "response", useApiKey: false });
      } catch (error) {
        if (error instanceof BunnyStreamProviderError && error.status === 404) return { state: "not_found" };
        throw error;
      }
      const offset = response.headers?.get("Upload-Offset");
      const size = response.headers?.get("Upload-Length");
      const offsetBytes = Number(offset);
      const sizeBytes = Number(size);
      if (![200, 204].includes(response.status) || response.headers?.get("Tus-Resumable") !== "1.0.0" ||
          !/^(0|[1-9]\d*)$/.test(offset) || !/^(0|[1-9]\d*)$/.test(size) ||
          !Number.isSafeInteger(offsetBytes) || !Number.isSafeInteger(sizeBytes) || offsetBytes > sizeBytes) {
        throw new BunnyStreamProviderError({ code: "BUNNY_STREAM_INVALID_TUS_RESPONSE", status: response.status });
      }
      return { state: offsetBytes === sizeBytes ? "complete" : "incomplete", offsetBytes, sizeBytes };
    },
    createTusUploadAuthorization({ videoId, expiresAt }) {
      const expiration = requireExpiration(expiresAt, {
        now,
        maxTtlSeconds: uploadAuthorizationTtlSeconds,
        purpose: "upload authorization",
      });
      const guid = requireVideoId(videoId);
      const signature = createHash("sha256")
        .update(`${libraryId}${apiKey}${expiration}${guid}`)
        .digest("hex");
      return {
        endpoint: BUNNY_STREAM_TUS_ENDPOINT,
        expiresAt: expiration,
        headers: {
          AuthorizationExpire: String(expiration),
          AuthorizationSignature: signature,
          LibraryId: String(libraryId),
          VideoId: guid,
        },
      };
    },
    createSignedHlsUrl({ videoId, expiresAt }) {
      const expiration = requireExpiration(expiresAt, {
        now,
        maxTtlSeconds: playbackTtlSeconds,
        purpose: "playback",
      });
      const guid = requireVideoId(videoId);
      const tokenPath = `/${guid}/`;
      const token = `HS256-${createHmac("sha256", tokenKey)
        .update(`${tokenPath}${expiration}token_path=${tokenPath}`)
        .digest("base64url")}`;
      return {
        href: `https://${cdnHostname}/bcdn_token=${token}&token_path=${encodeURIComponent(tokenPath)}&expires=${expiration}/${encodeURIComponent(guid)}/playlist.m3u8`,
        expiresAt: expiration,
      };
    },
    readThumbnail({ videoId, fileName }) {
      if (typeof fileName !== "string" || fileName.length > 160 ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(jpg|jpeg|png|webp)$/i.test(fileName) ||
          fileName.includes("..")) {
        throw new TypeError("Invalid Bunny thumbnail filename");
      }
      const grant = this.createSignedHlsUrl({ videoId,
        expiresAt: Math.floor(now() / 1000) + Math.min(playbackTtlSeconds, 60) });
      return request(grant.href.replace(/playlist\.m3u8$/, encodeURIComponent(fileName)), {
        method: "GET", headers: { Accept: "image/jpeg, image/png, image/webp" },
      }, { responseType: "thumbnail", useApiKey: false });
    },
    async probeSignedHls({ videoId, expiresAt }) {
      const grant = this.createSignedHlsUrl({ videoId, expiresAt });
      let playlist;
      try {
        playlist = await request(grant.href, {
          method: "GET", headers: { Accept: "application/vnd.apple.mpegurl" },
        }, { responseType: "text", useApiKey: false });
      } catch (error) {
        if (error instanceof BunnyStreamProviderError && error.status === 404) return null;
        throw error;
      }
      // A success response without a usable HLS playlist is not preview proof.
      if (typeof playlist !== "string" ||
          !playlist.startsWith("#EXTM3U") ||
          !/#EXT-X-STREAM-INF|#EXTINF/.test(playlist)) return null;
      return grant;
    },
  });
}
