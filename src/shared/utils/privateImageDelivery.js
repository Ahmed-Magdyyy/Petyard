import crypto from "crypto";
import { ApiError } from "./ApiError.js";
import {
  getMediaConfiguration,
  parseHttpsOrigin,
} from "./mediaConfig.js";

function getConfiguredPrivateOrigin(configuration, environment) {
  if (configuration.private?.cdnBaseUrl) {
    return configuration.private.cdnBaseUrl;
  }

  const configuredOrigin = environment.BUNNY_PRIVATE_CDN_BASE_URL;
  if (typeof configuredOrigin !== "string" || !configuredOrigin.trim()) {
    return null;
  }

  return parseHttpsOrigin(
    configuredOrigin,
    "BUNNY_PRIVATE_CDN_BASE_URL",
  );
}

export function getPrivateImageDeliveryUrl(
  url,
  {
    now = Date.now(),
    signingKey,
    config,
    environment = process.env,
  } = {},
) {
  if (typeof url !== "string" || !url) {
    return url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const media = config || getMediaConfiguration(environment);
  const privateOrigin = getConfiguredPrivateOrigin(media, environment);
  if (!privateOrigin) {
    return url;
  }

  const privateOriginUrl = new URL(privateOrigin);
  if (
    parsed.hostname === privateOriginUrl.hostname &&
    parsed.protocol !== "https:"
  ) {
    throw new ApiError("Private image URL must use HTTPS", 500);
  }
  if (parsed.origin !== privateOrigin) {
    return url;
  }

  if (parsed.hash) {
    throw new ApiError("Private image URL contains an unexpected fragment", 500);
  }

  for (const parameter of parsed.searchParams.keys()) {
    if (parameter !== "token" && parameter !== "expires") {
      throw new ApiError(
        "Private image URL contains unexpected query parameters",
        500,
      );
    }
  }

  parsed.search = "";
  parsed.hash = "";

  const key = signingKey || media.privateTokenKey;
  if (typeof key !== "string" || !key) {
    throw new ApiError(
      "BUNNY_PRIVATE_TOKEN_KEY is required for private delivery",
      500,
    );
  }

  const nowMilliseconds = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMilliseconds)) {
    throw new ApiError("Invalid private delivery timestamp", 500);
  }

  const expires =
    Math.floor(nowMilliseconds / 1000) + media.privateUrlTtlSeconds;
  const token = `HS256-${crypto
    .createHmac("sha256", key)
    .update(`${parsed.pathname}${expires}`)
    .digest("base64url")}`;

  parsed.searchParams.set("token", token);
  parsed.searchParams.set("expires", String(expires));
  return parsed.toString();
}
