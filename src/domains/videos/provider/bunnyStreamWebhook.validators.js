import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "../../../shared/utils/ApiError.js";

export const MAX_BUNNY_WEBHOOK_BYTES = 16 * 1024;
const GUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const invalidPayload = () => new ApiError("Invalid Bunny webhook payload", 422,
  [{ code: "VIDEO_WEBHOOK_INVALID_PAYLOAD" }]);

export function validateBunnyStreamWebhook({ rawBody, headers, libraryId, signingKey }) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) throw invalidPayload();
  if (rawBody.length > MAX_BUNNY_WEBHOOK_BYTES) {
    throw new ApiError("Bunny webhook payload is too large", 413, [{ code: "VIDEO_WEBHOOK_TOO_LARGE" }]);
  }
  const signature = headers?.["x-bunnystream-signature"];
  if (headers?.["x-bunnystream-signature-version"] !== "v1" ||
      headers?.["x-bunnystream-signature-algorithm"] !== "hmac-sha256" ||
      typeof signature !== "string" || !/^[a-f\d]{64}$/.test(signature) ||
      !timingSafeEqual(createHmac("sha256", signingKey).update(rawBody).digest(), Buffer.from(signature, "hex"))) {
    throw new ApiError("Invalid Bunny webhook signature", 401, [{ code: "VIDEO_WEBHOOK_INVALID_SIGNATURE" }]);
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch { throw invalidPayload(); }
  if (!payload || Array.isArray(payload) || typeof payload !== "object" ||
      !Number.isSafeInteger(payload.VideoLibraryId) || payload.VideoLibraryId <= 0 ||
      typeof payload.VideoGuid !== "string" || !GUID.test(payload.VideoGuid) ||
      !Number.isInteger(payload.Status) || payload.Status < 0 || payload.Status > 10) throw invalidPayload();
  if (String(payload.VideoLibraryId) !== libraryId) {
    throw new ApiError("Bunny webhook library does not match", 422, [{ code: "VIDEO_WEBHOOK_WRONG_LIBRARY" }]);
  }
  return { libraryId, providerGuid: payload.VideoGuid.toLowerCase(),
    bodyHash: createHash("sha256").update(rawBody).digest("hex") };
}
