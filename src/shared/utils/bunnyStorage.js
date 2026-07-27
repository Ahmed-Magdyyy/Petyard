import axios from "axios";
import crypto from "crypto";
import { ApiError } from "./ApiError.js";
import { parseHttpsOrigin } from "./mediaConfig.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 10;

function validateZone(zone) {
  if (
    typeof zone !== "string" ||
    !zone ||
    /[\\/?#\0-\x1f]/.test(zone)
  ) {
    throw new ApiError("Invalid Bunny storage zone", 400);
  }
  return zone;
}

function decodeUrlSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new ApiError("Invalid Bunny object URL path", 400);
  }

  if (decoded.includes("/") || /\\/.test(decoded)) {
    throw new ApiError("Invalid Bunny object URL path", 400);
  }

  return decoded;
}

export function validateBunnyObjectKey(objectKey, { allowedRoot } = {}) {
  if (
    typeof objectKey !== "string" ||
    !objectKey ||
    /\\/.test(objectKey) ||
    objectKey.includes("://")
  ) {
    throw new ApiError("Invalid Bunny object key", 400);
  }

  const segments = objectKey.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\0-\x1f?#]/.test(segment),
    )
  ) {
    throw new ApiError("Invalid Bunny object key", 400);
  }

  if (allowedRoot && segments[0] !== allowedRoot) {
    throw new ApiError("Bunny object key is outside its allowed root", 400);
  }

  return segments;
}

export function buildBunnyStorageUrl({ endpoint, zone, objectKey }) {
  const origin = parseHttpsOrigin(endpoint, "Bunny storage endpoint", {
    storageEndpoint: true,
  });
  const encodedKey = validateBunnyObjectKey(objectKey)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${encodeURIComponent(validateZone(zone))}/${encodedKey}`;
}

function createStatusError(status, headers) {
  const error = new Error("Bunny storage request failed");
  error.response = { status, headers: headers || {} };
  return error;
}

function isRetryable(error) {
  const status = error?.response?.status;
  return status == null || status === 429 || status >= 500;
}

function retryDelayMs(error, attempt, random) {
  const retryAfter = Number(error?.response?.headers?.["retry-after"]);
  if (
    Number.isFinite(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= MAX_RETRY_AFTER_SECONDS
  ) {
    return retryAfter * 1000;
  }
  return Math.min(250 * 2 ** attempt + Math.floor(random() * 50), 1100);
}

async function requestWithRetry(
  request,
  {
    transport = axios,
    acceptStatus,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
  } = {},
) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await transport.request(request);
      if (!acceptStatus(response.status)) {
        throw createStatusError(response.status, response.headers);
      }
      return response;
    } catch (error) {
      if (error?.response?.status === 404) {
        throw new ApiError("Bunny storage object was not found", 404);
      }
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) {
        throw new ApiError("Bunny storage request failed", 502);
      }
      await sleep(retryDelayMs(error, attempt, random));
    }
  }
  throw new ApiError("Bunny storage request failed", 502);
}

export async function uploadBunnyObject({
  zone,
  accessKey,
  endpoint,
  objectKey,
  buffer,
  contentType,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transport = axios,
  sleep,
  random,
}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new ApiError("Bunny upload body must be a Buffer", 400);
  }
  if (typeof accessKey !== "string" || !accessKey) {
    throw new ApiError("Bunny storage access key is required", 500);
  }
  if (typeof contentType !== "string" || !contentType) {
    throw new ApiError("Bunny upload content type is required", 400);
  }

  return requestWithRetry(
    {
      method: "PUT",
      url: buildBunnyStorageUrl({ endpoint, zone, objectKey }),
      data: buffer,
      timeout: timeoutMs,
      headers: {
        AccessKey: accessKey,
        "Content-Type": contentType,
        Checksum: crypto
          .createHash("sha256")
          .update(buffer)
          .digest("hex")
          .toUpperCase(),
      },
    },
    {
      transport,
      acceptStatus: (status) => status === 201,
      sleep,
      random,
    },
  );
}

export async function downloadBunnyObject({
  zone,
  accessKey,
  endpoint,
  objectKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transport = axios,
  sleep,
  random,
}) {
  const response = await requestWithRetry(
    {
      method: "GET",
      url: buildBunnyStorageUrl({ endpoint, zone, objectKey }),
      timeout: timeoutMs,
      responseType: "arraybuffer",
      headers: { AccessKey: accessKey },
    },
    {
      transport,
      acceptStatus: (status) => status >= 200 && status < 300,
      sleep,
      random,
    },
  );
  return Buffer.from(response.data);
}

export async function deleteBunnyObject({
  zone,
  accessKey,
  endpoint,
  objectKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transport = axios,
}) {
  let response;
  try {
    response = await transport.request({
      method: "DELETE",
      url: buildBunnyStorageUrl({ endpoint, zone, objectKey }),
      timeout: timeoutMs,
      headers: { AccessKey: accessKey },
      validateStatus: () => true,
    });
  } catch {
    throw new ApiError("Bunny storage delete failed", 502);
  }

  if (
    (response.status >= 200 && response.status < 300) ||
    response.status === 404
  ) {
    return;
  }
  throw new ApiError("Bunny storage delete failed", 502);
}

export function buildBunnyCdnUrl({ cdnBaseUrl, objectKey }) {
  const origin = parseHttpsOrigin(cdnBaseUrl, "Bunny CDN base URL");
  const encodedKey = validateBunnyObjectKey(objectKey)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/${encodedKey}`;
}

export function getBunnyObjectKeyFromUrl({
  url,
  cdnBaseUrl,
  allowedRoot,
}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const expectedOrigin = parseHttpsOrigin(
    cdnBaseUrl,
    "Bunny CDN base URL",
  );
  if (
    parsed.origin !== expectedOrigin ||
    parsed.protocol !== "https:" ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const segments = parsed.pathname
    .slice(1)
    .split("/")
    .map(decodeUrlSegment);
  const objectKey = segments.join("/");
  validateBunnyObjectKey(objectKey, { allowedRoot });
  return objectKey;
}
