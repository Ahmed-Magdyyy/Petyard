import { parseBoundedInt } from "./env.js";
import { ApiError } from "./ApiError.js";

export const MEDIA_STORAGE_PROVIDERS = Object.freeze({
  CLOUDINARY: "cloudinary",
  BUNNY: "bunny",
});

const PROVIDERS = new Set(Object.values(MEDIA_STORAGE_PROVIDERS));

export function parseMediaProvider(value, variableName) {
  const provider =
    value == null || String(value).trim() === ""
      ? MEDIA_STORAGE_PROVIDERS.CLOUDINARY
      : String(value).trim().toLowerCase();

  if (!PROVIDERS.has(provider)) {
    throw new ApiError(`${variableName} must be cloudinary or bunny`, 500);
  }

  return provider;
}

export function parseHttpsOrigin(
  value,
  variableName,
  { storageEndpoint = false } = {},
) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(`${variableName} is required`, 500);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError(`${variableName} must be an HTTPS origin`, 500);
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ApiError(
      `${variableName} must be an HTTPS origin without a path, query, credentials, or fragment`,
      500,
    );
  }

  if (
    storageEndpoint &&
    parsed.hostname.toLowerCase() !== "storage.bunnycdn.com"
  ) {
    throw new ApiError(
      `${variableName} must be the Bunny Storage HTTPS origin without a storage zone`,
      500,
    );
  }

  return parsed.origin;
}

function parseZone(environment, visibility, { required }) {
  const prefix = `BUNNY_${visibility.toUpperCase()}_`;
  const variableNames = {
    zone: `${prefix}STORAGE_ZONE`,
    accessKey: `${prefix}STORAGE_ACCESS_KEY`,
    endpoint: `${prefix}STORAGE_ENDPOINT`,
    cdnBaseUrl: `${prefix}CDN_BASE_URL`,
  };
  const values = Object.fromEntries(
    Object.entries(variableNames).map(([key, variableName]) => [
      key,
      environment[variableName],
    ]),
  );
  const hasCompleteOptionalConfiguration = Object.values(values).every(
    (value) => typeof value === "string" && value.trim(),
  );

  if (!required && !hasCompleteOptionalConfiguration) {
    return null;
  }

  for (const [key, variableName] of Object.entries(variableNames)) {
    if (typeof values[key] !== "string" || !values[key].trim()) {
      throw new ApiError(`${variableName} is required`, 500);
    }
  }

  const zone = values.zone.trim();
  if (/[\\/?#\0-\x1f]/.test(zone)) {
    throw new ApiError(`${variableNames.zone} is invalid`, 500);
  }

  return {
    zone,
    accessKey: values.accessKey.trim(),
    endpoint: parseHttpsOrigin(values.endpoint, variableNames.endpoint, {
      storageEndpoint: true,
    }),
    cdnBaseUrl: parseHttpsOrigin(
      values.cdnBaseUrl,
      variableNames.cdnBaseUrl,
    ),
  };
}

export function getMediaConfiguration(environment = process.env) {
  const publicProvider = parseMediaProvider(
    environment.PUBLIC_MEDIA_STORAGE_PROVIDER,
    "PUBLIC_MEDIA_STORAGE_PROVIDER",
  );
  const privateProvider = parseMediaProvider(
    environment.PRIVATE_MEDIA_STORAGE_PROVIDER,
    "PRIVATE_MEDIA_STORAGE_PROVIDER",
  );

  return {
    publicProvider,
    privateProvider,
    public: parseZone(environment, "public", {
      required: publicProvider === MEDIA_STORAGE_PROVIDERS.BUNNY,
    }),
    private: parseZone(environment, "private", {
      required: privateProvider === MEDIA_STORAGE_PROVIDERS.BUNNY,
    }),
    privateTokenKey:
      typeof environment.BUNNY_PRIVATE_TOKEN_KEY === "string" &&
      environment.BUNNY_PRIVATE_TOKEN_KEY
        ? environment.BUNNY_PRIVATE_TOKEN_KEY
        : null,
    privateUrlTtlSeconds: parseBoundedInt(
      environment.BUNNY_PRIVATE_URL_TTL_SECONDS,
      300,
      60,
      3600,
    ),
    storageTimeoutMs: parseBoundedInt(
      environment.BUNNY_STORAGE_TIMEOUT_MS,
      15000,
      1000,
      60000,
    ),
  };
}

export function validateMediaConfiguration(environment = process.env) {
  const config = getMediaConfiguration(environment);

  if (
    config.privateProvider === MEDIA_STORAGE_PROVIDERS.BUNNY &&
    !config.privateTokenKey
  ) {
    throw new ApiError(
      "BUNNY_PRIVATE_TOKEN_KEY is required when PRIVATE_MEDIA_STORAGE_PROVIDER is bunny",
      500,
    );
  }

  return config;
}
