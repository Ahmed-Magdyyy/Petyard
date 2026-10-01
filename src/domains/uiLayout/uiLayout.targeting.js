import { createHash } from "node:crypto";
import { stableStringify } from "../../shared/utils/cache.js";

export const DEFAULT_TARGETING = Object.freeze({
  platforms: [],
  locales: [],
  country_codes: [],
  location_ids: [],
  min_app_version: null,
  max_app_version: null,
  audience: "all",
  priority: 0,
});

export function normalizeTargeting(value = {}) {
  const result = { ...DEFAULT_TARGETING, ...value };
  for (const field of ["platforms", "locales", "country_codes", "location_ids"]) {
    result[field] = [...(result[field] ?? [])].sort();
  }
  return result;
}

export function targetingScopeKey(targeting) {
  return createHash("sha256").update(stableStringify(normalizeTargeting(targeting))).digest("hex");
}

export function isGlobalTargeting(targeting) {
  const rule = normalizeTargeting(targeting);
  return ["platforms", "locales", "country_codes", "location_ids"].every((field) => !rule[field].length) &&
    !rule.min_app_version && !rule.max_app_version && rule.audience === "all";
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

function listMatches(allowed, actual) {
  return !allowed?.length || (actual !== null && actual !== undefined && allowed.includes(actual));
}

export function matchesTargeting(targeting, request) {
  const rule = normalizeTargeting(targeting);
  if (!listMatches(rule.platforms, request.platform)) return false;
  if (!listMatches(rule.locales, request.locale)) return false;
  if (!listMatches(rule.country_codes, request.countryCode)) return false;
  if (!listMatches(rule.location_ids, request.locationId)) return false;
  if (rule.audience !== "all" && rule.audience !== request.audience) return false;
  if (rule.min_app_version && (!request.appVersion ||
    compareVersions(request.appVersion, rule.min_app_version) < 0)) return false;
  if (rule.max_app_version && (!request.appVersion ||
    compareVersions(request.appVersion, rule.max_app_version) > 0)) return false;
  return true;
}

function listsOverlap(left, right) {
  return !left?.length || !right?.length || left.some((item) => right.includes(item));
}

export function targetingOverlaps(first, second) {
  const a = normalizeTargeting(first);
  const b = normalizeTargeting(second);
  if (a.priority !== b.priority) return false;
  for (const field of ["platforms", "locales", "country_codes", "location_ids"]) {
    if (!listsOverlap(a[field], b[field])) return false;
  }
  if (a.audience !== "all" && b.audience !== "all" && a.audience !== b.audience) return false;
  if (a.max_app_version && b.min_app_version &&
    compareVersions(a.max_app_version, b.min_app_version) < 0) return false;
  if (b.max_app_version && a.min_app_version &&
    compareVersions(b.max_app_version, a.min_app_version) < 0) return false;
  return true;
}

export function targetingSpecificity(targeting) {
  const rule = normalizeTargeting(targeting);
  let score = 0;
  for (const field of ["platforms", "locales", "country_codes", "location_ids"]) {
    if (rule[field].length) score += 1000 / rule[field].length;
  }
  if (rule.audience !== "all") score += 1000;
  if (rule.min_app_version) score += 100;
  if (rule.max_app_version) score += 100;
  return score;
}

export function chooseActiveVersion(activeRows, request) {
  const candidates = activeRows.filter((row) => matchesTargeting(row.targeting, request));
  candidates.sort((a, b) =>
    b.priority - a.priority ||
    targetingSpecificity(b.targeting) - targetingSpecificity(a.targeting) ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
    a.versionId.localeCompare(b.versionId));
  return candidates[0] ?? null;
}
