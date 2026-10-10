import { ApiError } from "../../../shared/utils/ApiError.js";
import { parseBoundedInt } from "../../../shared/utils/env.js";

function requireNonEmptyString(environment, variableName) {
  const value = environment[variableName];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(
      `${variableName} is required when a Videos feature is enabled`,
      500,
    );
  }

  return value.trim();
}

function parseCdnHostname(value) {
  if (/[/\\?#\s]/.test(value)) {
    throw new ApiError(
      "BUNNY_STREAM_CDN_HOSTNAME must be a hostname without a path, query, or fragment",
      500,
    );
  }

  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.hostname !== value.toLowerCase() || parsed.port) {
      throw new Error("invalid hostname");
    }
  } catch {
    throw new ApiError("BUNNY_STREAM_CDN_HOSTNAME must be a hostname", 500);
  }

  return value.toLowerCase();
}

function parseFeatureSwitch(environment, variableName) {
  const value = environment[variableName];
  if (value == null || value === "") return false;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ApiError(`${variableName} must be true or false`, 500);
}

function getFlags(environment) {
  return {
    videosPublicEnabled: parseFeatureSwitch(environment, "VIDEOS_PUBLIC_ENABLED"),
    reelUploadsEnabled: parseFeatureSwitch(environment, "REEL_UPLOADS_ENABLED"),
    reelPipelineReady: parseFeatureSwitch(environment, "REEL_UPLOAD_PIPELINE_READY"),
    coverPipelineReady: parseFeatureSwitch(environment, "VIDEO_COVER_PIPELINE_READY"),
    productVideoUploadsEnabled: parseFeatureSwitch(
      environment,
      "PRODUCT_VIDEO_UPLOADS_ENABLED",
    ),
    productVideosPublicEnabled: parseFeatureSwitch(
      environment,
      "PRODUCT_VIDEOS_PUBLIC_ENABLED",
    ),
  };
}

function hasEnabledFeature(flags) {
  return Object.values(flags).some(Boolean);
}

const STREAM_REQUIRED_NAMES = [
  "BUNNY_STREAM_LIBRARY_ID",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_STREAM_READ_ONLY_API_KEY",
  "BUNNY_STREAM_CDN_HOSTNAME",
  "BUNNY_STREAM_TOKEN_KEY",
];

export function getVideosStreamConfiguration(environment = process.env) {
  const flags = getFlags(environment);
  const hasCompleteStreamSettings = STREAM_REQUIRED_NAMES.every(
    (name) => typeof environment[name] === "string" && environment[name].trim(),
  );
  if (!hasEnabledFeature(flags) && !hasCompleteStreamSettings) {
    return { flags, stream: null };
  }

  const libraryId = requireNonEmptyString(environment, "BUNNY_STREAM_LIBRARY_ID");
  if (!/^\d+$/.test(libraryId)) {
    throw new ApiError("BUNNY_STREAM_LIBRARY_ID must be numeric", 500);
  }

  return {
    flags,
    stream: {
      libraryId,
      apiKey: requireNonEmptyString(environment, "BUNNY_STREAM_API_KEY"),
      readOnlyApiKey: requireNonEmptyString(
        environment,
        "BUNNY_STREAM_READ_ONLY_API_KEY",
      ),
      cdnHostname: parseCdnHostname(
        requireNonEmptyString(environment, "BUNNY_STREAM_CDN_HOSTNAME"),
      ),
      tokenKey: requireNonEmptyString(environment, "BUNNY_STREAM_TOKEN_KEY"),
      uploadAuthorizationTtlSeconds: parseBoundedInt(
        environment.BUNNY_STREAM_UPLOAD_AUTH_TTL_SECONDS,
        21600,
        3600,
        21600,
      ),
      playbackTtlSeconds: parseBoundedInt(
        environment.BUNNY_STREAM_PLAYBACK_TTL_SECONDS,
        900,
        60,
        900,
      ),
      requestTimeoutMs: parseBoundedInt(
        environment.BUNNY_STREAM_REQUEST_TIMEOUT_MS,
        15000,
        1000,
        60000,
      ),
    },
  };
}

export function validateVideosStreamConfiguration(environment = process.env) {
  return getVideosStreamConfiguration(environment);
}
