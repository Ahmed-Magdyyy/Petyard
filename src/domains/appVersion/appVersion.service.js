import { ApiError } from "../../shared/utils/ApiError.js";
import {
  AppVersionPolicyModel,
  AppVersionReleaseModel,
  appVersionPattern,
  appVersionPlatforms,
} from "./appVersion.model.js";

const DEFAULT_VERSION = "0.0.0";
const DEFAULT_RELEASE_NOTES = "Default app version policy";
const APP_UPDATE_URL = "https://app.petyardstores.com";

function normalizePlatform(platform) {
  const value = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (Object.values(appVersionPlatforms).includes(value)) {
    return value;
  }
  throw new ApiError("platform must be either android or ios", 400);
}

function normalizeVersion(version, fieldName = "appVersion") {
  const value = typeof version === "string" ? version.trim() : "";
  if (!value) {
    throw new ApiError(`${fieldName} is required`, 400);
  }
  if (!appVersionPattern.test(value)) {
    throw new ApiError(
      `${fieldName} must be numeric, e.g. 1.2.3 or 1.2.3+45`,
      400,
    );
  }
  return value;
}

function parseVersion(version) {
  const normalized = normalizeVersion(version);
  const [base, build] = normalized.split("+");
  const parts = base.split(".").map((part) => Number.parseInt(part, 10));

  if (build !== undefined) {
    parts.push(Number.parseInt(build, 10));
  }

  return parts;
}

function compareVersions(a, b) {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  const max = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < max; i += 1) {
    const left = aParts[i] || 0;
    const right = bParts[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
}

function normalizeNullableString(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeReleasePayload(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const version = normalizeVersion(payload.version, "version");

  if (typeof payload.mustUpdate !== "boolean") {
    throw new ApiError("mustUpdate is required and must be a boolean", 400);
  }

  return {
    platform,
    version,
    mustUpdate: payload.mustUpdate,
    setAsLatestVersion: payload.setAsLatestVersion,
    setAsMinVersion: Boolean(payload.setAsMinVersion),
    releaseNotes: normalizeNullableString(payload.releaseNotes) ?? null,
  };
}

function toReleaseDto(release, policy = null) {
  if (!release) return null;
  const releaseId = String(release._id);
  const latestId = policy?.latestRelease?._id
    ? String(policy.latestRelease._id)
    : null;
  const minId = policy?.minRelease?._id ? String(policy.minRelease._id) : null;

  return {
    id: releaseId,
    platform: release.platform,
    version: release.version,
    mustUpdate: Boolean(release.mustUpdate),
    releaseNotes: release.releaseNotes || null,
    storeUrl: APP_UPDATE_URL,
    isLatestVersion: latestId === releaseId,
    isMinVersion: minId === releaseId,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
  };
}

function toPublicVersionDto(release) {
  return {
    version: release.version,
    mustUpdate: Boolean(release.mustUpdate),
    releaseNotes: release.releaseNotes || null,
    storeUrl: APP_UPDATE_URL,
  };
}

function toPolicyDto(policy) {
  return {
    platform: policy.platform,
    latestAppVersion: toPublicVersionDto(policy.latestRelease),
    minAppVersion: toPublicVersionDto(policy.minRelease),
    updatedAt: policy.updatedAt,
  };
}

async function getOrCreateDefaultRelease(platform) {
  return AppVersionReleaseModel.findOneAndUpdate(
    { platform, version: DEFAULT_VERSION },
    {
      $setOnInsert: {
        platform,
        version: DEFAULT_VERSION,
        mustUpdate: false,
        releaseNotes: DEFAULT_RELEASE_NOTES,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function populatePolicy(policy) {
  return policy.populate([
    { path: "latestRelease" },
    { path: "minRelease" },
  ]);
}

function assertValidPolicyOrder({ latestRelease, minRelease }) {
  if (compareVersions(minRelease.version, latestRelease.version) > 0) {
    throw new ApiError(
      "minAppVersion cannot be greater than latestAppVersion",
      400,
    );
  }
}

function assertSinglePolicySelectionPerPlatform(releases) {
  const latestSelections = new Map();
  const minSelections = new Map();

  for (const release of releases) {
    if (release.setAsLatestVersion === true) {
      if (latestSelections.has(release.platform)) {
        throw new ApiError(
          `Only one ${release.platform} release can be setAsLatestVersion in the same request`,
          400,
        );
      }
      latestSelections.set(release.platform, release.version);
    }

    if (release.setAsMinVersion === true) {
      if (minSelections.has(release.platform)) {
        throw new ApiError(
          `Only one ${release.platform} release can be setAsMinVersion in the same request`,
          400,
        );
      }
      minSelections.set(release.platform, release.version);
    }
  }
}

function shouldPromoteReleaseToLatest({ release, currentLatest, hasExplicitLatest }) {
  if (release.setAsLatestVersion === true) return true;
  if (release.setAsLatestVersion === false) return false;
  if (hasExplicitLatest) return false;
  return compareVersions(release.version, currentLatest.version) >= 0;
}

async function getOrCreatePlatformPolicy(platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const defaultRelease = await getOrCreateDefaultRelease(normalizedPlatform);

  let policy = await AppVersionPolicyModel.findOneAndUpdate(
    { platform: normalizedPlatform },
    {
      $setOnInsert: {
        platform: normalizedPlatform,
        latestRelease: defaultRelease._id,
        minRelease: defaultRelease._id,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  policy = await populatePolicy(policy);

  const needsRepair = !policy.latestRelease || !policy.minRelease;
  if (needsRepair) {
    policy.latestRelease = policy.latestRelease?._id || defaultRelease._id;
    policy.minRelease = policy.minRelease?._id || defaultRelease._id;
    await policy.save();
    policy = await populatePolicy(policy);
  }

  return policy;
}

async function findReleaseByVersionOrThrow(platform, version, fieldName) {
  const normalizedVersion = normalizeVersion(version, fieldName);
  const release = await AppVersionReleaseModel.findOne({
    platform,
    version: normalizedVersion,
  });

  if (!release) {
    throw new ApiError(
      `No ${platform} app release found for version ${normalizedVersion}`,
      404,
    );
  }

  return release;
}

async function applyPolicySelection({
  platform,
  policy,
  latestRelease,
  minRelease,
  updatedBy,
}) {
  assertValidPolicyOrder({ latestRelease, minRelease });

  policy.latestRelease = latestRelease._id;
  policy.minRelease = minRelease._id;
  policy.updatedBy = updatedBy || null;
  await policy.save();

  return getOrCreatePlatformPolicy(platform);
}

export async function getAppVersionsService() {
  const [android, ios] = await Promise.all([
    getOrCreatePlatformPolicy(appVersionPlatforms.ANDROID),
    getOrCreatePlatformPolicy(appVersionPlatforms.IOS),
  ]);

  return {
    android: toPolicyDto(android),
    ios: toPolicyDto(ios),
  };
}

export async function checkAppVersionService({ platform, appVersion }) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedAppVersion = normalizeVersion(appVersion, "appVersion");
  const policy = await getOrCreatePlatformPolicy(normalizedPlatform);

  const belowMinVersion =
    compareVersions(normalizedAppVersion, policy.minRelease.version) < 0;
  const belowLatestVersion =
    compareVersions(normalizedAppVersion, policy.latestRelease.version) < 0;

  const mustUpdate =
    (belowMinVersion && Boolean(policy.minRelease.mustUpdate)) ||
    (belowLatestVersion && Boolean(policy.latestRelease.mustUpdate));

  return {
    platform: normalizedPlatform,
    appVersion: normalizedAppVersion,
    mustUpdate,
    updateAvailable: belowLatestVersion,
    latestAppVersion: toPublicVersionDto(policy.latestRelease),
    minAppVersion: toPublicVersionDto(policy.minRelease),
  };
}

export async function listAppVersionReleasesService(platform) {
  const normalizedPlatform = normalizePlatform(platform);
  const policy = await getOrCreatePlatformPolicy(normalizedPlatform);
  const releases = await AppVersionReleaseModel.find({
    platform: normalizedPlatform,
  }).sort({ createdAt: -1 });

  return {
    platform: normalizedPlatform,
    results: releases.length,
    data: releases.map((release) => toReleaseDto(release, policy)),
  };
}

export async function createAppVersionReleasesService({ payload = {}, actorId }) {
  const releaseInputs = Array.isArray(payload.releases)
    ? payload.releases
    : [payload];

  if (!releaseInputs.length) {
    throw new ApiError("At least one release must be provided", 400);
  }

  const normalizedReleases = releaseInputs.map(normalizeReleasePayload);
  assertSinglePolicySelectionPerPlatform(normalizedReleases);

  const seenKeys = new Set();

  for (const release of normalizedReleases) {
    const key = `${release.platform}:${release.version}`;
    if (seenKeys.has(key)) {
      throw new ApiError(
        `Duplicate release in request: ${release.platform} ${release.version}`,
        400,
      );
    }
    seenKeys.add(key);
  }

  const existingReleases = await AppVersionReleaseModel.find({
    $or: normalizedReleases.map((release) => ({
      platform: release.platform,
      version: release.version,
    })),
  }).select("platform version");

  if (existingReleases.length) {
    const existing = existingReleases
      .map((release) => `${release.platform} ${release.version}`)
      .join(", ");
    throw new ApiError(`App release already exists: ${existing}`, 409);
  }

  const platforms = Array.from(
    new Set(normalizedReleases.map((release) => release.platform)),
  );
  const policies = new Map();

  for (const platform of platforms) {
    policies.set(platform, await getOrCreatePlatformPolicy(platform));
  }

  const simulatedPolicies = new Map();

  for (const platform of platforms) {
    const policy = policies.get(platform);
    simulatedPolicies.set(platform, {
      latestRelease: policy.latestRelease,
      minRelease: policy.minRelease,
    });
  }

  for (const release of normalizedReleases) {
    const simulatedPolicy = simulatedPolicies.get(release.platform);
    const hasExplicitLatestSelection = normalizedReleases.some(
      (candidate) =>
        candidate.platform === release.platform &&
        candidate.setAsLatestVersion === true,
    );
    const setAsLatestVersion = shouldPromoteReleaseToLatest({
      release,
      currentLatest: simulatedPolicy.latestRelease,
      hasExplicitLatest: hasExplicitLatestSelection,
    });
    const setAsMinVersion = release.setAsMinVersion;

    const virtualRelease = {
      _id: null,
      platform: release.platform,
      version: release.version,
      mustUpdate: release.mustUpdate,
      releaseNotes: release.releaseNotes,
    };

    const nextLatestRelease = setAsLatestVersion
      ? virtualRelease
      : simulatedPolicy.latestRelease;
    const nextMinRelease = setAsMinVersion
      ? virtualRelease
      : simulatedPolicy.minRelease;

    assertValidPolicyOrder({
      latestRelease: nextLatestRelease,
      minRelease: nextMinRelease,
    });

    simulatedPolicy.latestRelease = nextLatestRelease;
    simulatedPolicy.minRelease = nextMinRelease;
  }

  const created = [];
  const latestSelections = new Map();
  const minSelections = new Map();

  for (const releaseInput of normalizedReleases) {
    const policy = policies.get(releaseInput.platform);
    const release = await AppVersionReleaseModel.create({
      platform: releaseInput.platform,
      version: releaseInput.version,
      mustUpdate: releaseInput.mustUpdate,
      releaseNotes: releaseInput.releaseNotes,
      createdBy: actorId || null,
      updatedBy: actorId || null,
    });

    created.push(release);

    const hasExplicitLatestSelection = normalizedReleases.some(
      (candidate) =>
        candidate.platform === releaseInput.platform &&
        candidate.setAsLatestVersion === true,
    );
    const setAsLatestVersion = shouldPromoteReleaseToLatest({
      release: releaseInput,
      currentLatest: policy.latestRelease,
      hasExplicitLatest: hasExplicitLatestSelection,
    });

    if (setAsLatestVersion) {
      latestSelections.set(releaseInput.platform, release);
      policy.latestRelease = release;
    }

    if (releaseInput.setAsMinVersion) {
      minSelections.set(releaseInput.platform, release);
      policy.minRelease = release;
    }
  }

  const updatedPolicies = new Map();

  for (const platform of platforms) {
    const policy = policies.get(platform);
    const nextLatestRelease = latestSelections.get(platform) || policy.latestRelease;
    const nextMinRelease = minSelections.get(platform) || policy.minRelease;

    if (latestSelections.has(platform) || minSelections.has(platform)) {
      updatedPolicies.set(
        platform,
        await applyPolicySelection({
          platform,
          policy,
          latestRelease: nextLatestRelease,
          minRelease: nextMinRelease,
          updatedBy: actorId,
        }),
      );
    } else {
      updatedPolicies.set(platform, policy);
    }
  }

  return {
    results: created.length,
    data: created.map((release) =>
      toReleaseDto(release, updatedPolicies.get(release.platform)),
    ),
    policies: Object.fromEntries(
      Array.from(updatedPolicies.entries()).map(([platform, policy]) => [
        platform,
        toPolicyDto(policy),
      ]),
    ),
  };
}

export async function updateAppVersionReleaseService({
  platform,
  version,
  payload = {},
  actorId,
}) {
  const normalizedPlatform = normalizePlatform(platform);
  const release = await findReleaseByVersionOrThrow(
    normalizedPlatform,
    version,
    "version",
  );

  if (payload.mustUpdate !== undefined) {
    release.mustUpdate = Boolean(payload.mustUpdate);
  }

  const releaseNotes = normalizeNullableString(payload.releaseNotes);
  if (releaseNotes !== undefined) {
    release.releaseNotes = releaseNotes;
  }

  release.updatedBy = actorId || null;
  await release.save();

  const policy = await getOrCreatePlatformPolicy(normalizedPlatform);

  return {
    data: toReleaseDto(release, policy),
    policy: toPolicyDto(policy),
  };
}

export async function updateAppVersionPolicyService({
  platform,
  payload = {},
  actorId,
}) {
  const normalizedPlatform = normalizePlatform(platform);
  const policy = await getOrCreatePlatformPolicy(normalizedPlatform);

  const latestRelease =
    payload.latestAppVersion !== undefined
      ? await findReleaseByVersionOrThrow(
          normalizedPlatform,
          payload.latestAppVersion,
          "latestAppVersion",
        )
      : policy.latestRelease;

  const minRelease =
    payload.minAppVersion !== undefined
      ? await findReleaseByVersionOrThrow(
          normalizedPlatform,
          payload.minAppVersion,
          "minAppVersion",
        )
      : policy.minRelease;

  const updatedPolicy = await applyPolicySelection({
    platform: normalizedPlatform,
    policy,
    latestRelease,
    minRelease,
    updatedBy: actorId,
  });

  return toPolicyDto(updatedPolicy);
}
