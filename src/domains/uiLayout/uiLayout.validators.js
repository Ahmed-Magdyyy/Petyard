import { UiLayoutError } from "./uiLayout.error.js";
import { decodePageCursor } from "./uiLayout.pagination.js";
import { CUSTOMER_HOME_LAYOUT_ID, UUID, OBJECT_ID, SEMVER, LOCALE, COUNTRY,
  PLATFORMS } from "./uiLayout.constants.js";

function invalid(path, message = "Invalid value.") {
  throw new UiLayoutError("UI_LAYOUT_INVALID_REQUEST", message, 400, [{ path, code: "INVALID_VALUE", message }]);
}

export function requireUuid(value, path) {
  if (typeof value !== "string" || !UUID.test(value)) invalid(path, "Must be a UUID.");
  return value;
}

export function requireRevision(value, path = "revision") {
  if (!Number.isSafeInteger(value) || value < 1) invalid(path, "Must be a positive integer.");
  return value;
}

export function parseIfMatch(req) {
  const header = req.headers["if-match"];
  if (typeof header !== "string" || !/^"[1-9]\d*"$/.test(header)) {
    throw new UiLayoutError("UI_DRAFT_IF_MATCH_REQUIRED", 'If-Match: "<revision>" is required.', 400);
  }
  return requireRevision(Number(header.slice(1, -1)), "If-Match");
}

export function parseIdempotencyKey(req) {
  return requireUuid(req.headers["idempotency-key"], "Idempotency-Key");
}

export function parseMutationId(req) {
  const value = req.headers["x-client-mutation-id"];
  return value === undefined ? null : requireUuid(value, "X-Client-Mutation-Id");
}

export function parseDraftId(req) {
  return requireUuid(req.params.draftId, "draftId");
}

export function parseVersionId(req) {
  return requireUuid(req.params.versionId, "versionId");
}

export function parsePreviewId(req) {
  return requireUuid(req.params.previewId, "previewId");
}

export function parsePreviewContext(body) {
  const context = {};
  if (body.device_profile !== undefined) {
    if (typeof body.device_profile !== "string" || !body.device_profile.trim() ||
      body.device_profile.length > 40) invalid("body.device_profile", "Must be a non-empty device profile of at most 40 characters.");
    context.device_profile = body.device_profile;
  }
  if (body.locale !== undefined) {
    if (typeof body.locale !== "string" || !LOCALE.test(body.locale)) {
      invalid("body.locale", "Must be a locale such as en or en-US.");
    }
    context.locale = body.locale;
  }
  if (body.platform !== undefined) {
    if (!PLATFORMS.has(body.platform)) invalid("body.platform", "Unsupported platform.");
    context.platform = body.platform;
  }
  if (body.location_id !== undefined) {
    if (typeof body.location_id !== "string" ||
      !(UUID.test(body.location_id) || OBJECT_ID.test(body.location_id))) {
      invalid("body.location_id", "Must be a UUID or MongoDB ObjectId.");
    }
    context.location_id = body.location_id;
  }
  return context;
}

export function assertBodyKeys(body, allowed, required = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("body", "Must be a JSON object.");
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) invalid(`body.${key}`, "Unknown field.");
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) invalid(`body.${key}`, "Required field.");
  }
}

export function parseList(req, { allowedStatuses = null, defaultLimit = 20 } = {}) {
  for (const key of Object.keys(req.query)) {
    if (!["limit", "before", "status"].includes(key)) invalid(`query.${key}`, "Unknown query parameter.");
  }
  const limit = req.query.limit === undefined ? defaultLimit : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("query.limit", "Must be 1 to 100.");
  let before = null;
  if (req.query.before !== undefined) {
    before = decodePageCursor(req.query.before);
  }
  const status = req.query.status;
  if (status !== undefined && (!allowedStatuses || !allowedStatuses.includes(status))) {
    invalid("query.status", "Unsupported status filter.");
  }
  return { limit, before, status };
}

export function parseHistoryList(req) {
  for (const key of Object.keys(req.query)) {
    if (!["limit", "before"].includes(key)) invalid(`query.${key}`, "Unknown query parameter.");
  }
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("query.limit", "Must be 1 to 100.");
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) invalid("query.before", "Must be a positive version number.");
  return { limit, before };
}

export function parsePublicTarget(req) {
  const platform = req.headers["x-app-platform"] ?? null;
  if (platform !== null && !PLATFORMS.has(platform)) invalid("X-App-Platform");
  const appVersion = req.headers["x-app-version"] ?? null;
  if (appVersion !== null && (typeof appVersion !== "string" || !SEMVER.test(appVersion))) invalid("X-App-Version");
  const locale = req.headers["x-app-locale"] ?? req.lang ?? null;
  if (locale !== null && (typeof locale !== "string" || !LOCALE.test(locale))) invalid("X-App-Locale");
  const locationId = req.headers["x-location-id"] ?? null;
  if (locationId !== null && (typeof locationId !== "string" ||
    !(UUID.test(locationId) || OBJECT_ID.test(locationId)))) invalid("X-Location-Id");
  const countryCode = req.headers["x-country-code"] ?? null;
  if (countryCode !== null && (typeof countryCode !== "string" || !COUNTRY.test(countryCode))) invalid("X-Country-Code");
  return {
    platform, appVersion, locale, locationId, countryCode,
    audience: req.user ? "logged_in" : "guest",
  };
}

// Normalize HTTP input once. Business and publication validation remain in the service.
function requestValidator(parse) {
  return (req, res, next) => {
    res.locals.uiLayoutInput = parse(req);
    next();
  };
}

export const listAssetsValidator = requestValidator((req) => parseList(req, { defaultLimit: 30 }));
export const listDraftsValidator = requestValidator((req) => parseList(req, {
  allowedStatuses: ["draft", "scheduled", "published", "archived"],
}));
export const historyValidator = requestValidator(parseHistoryList);
export const auditValidator = requestValidator(parseList);
export const publishedLayoutValidator = requestValidator(parsePublicTarget);
export const draftIdValidator = requestValidator((req) => ({ id: parseDraftId(req) }));
export const versionIdValidator = requestValidator((req) => ({ id: parseVersionId(req) }));
export const previewIdValidator = requestValidator((req) => ({ id: parsePreviewId(req) }));

export const createDraftValidator = requestValidator((req) => {
  assertBodyKeys(req.body, ["layout_key", "name", "source", "change_note"],
    ["layout_key", "name", "source"]);
  if (req.body.layout_key !== CUSTOMER_HOME_LAYOUT_ID) {
    throw new UiLayoutError("UI_LAYOUT_UNSUPPORTED_KEY", "Only customer_home is supported.", 400);
  }
  return { name: req.body.name, source: req.body.source, changeNote: req.body.change_note ?? null };
});

export const saveDraftValidator = requestValidator((req) => {
  const id = parseDraftId(req);
  const revision = parseIfMatch(req);
  assertBodyKeys(req.body, ["name", "change_note", "targeting", "content"],
    ["name", "targeting", "content"]);
  return { id, revision, body: req.body, mutationId: parseMutationId(req) };
});

export const emptyDraftBodyValidator = requestValidator((req) => {
  assertBodyKeys(req.body ?? {}, [], []);
  return { id: parseDraftId(req) };
});

export const createPreviewValidator = requestValidator((req) => {
  assertBodyKeys(req.body, ["revision", "device_profile", "locale", "platform",
    "location_id", "expires_in_seconds"], ["revision"]);
  return {
    id: parseDraftId(req), revision: requireRevision(req.body.revision),
    expiresInSeconds: req.body.expires_in_seconds ?? 1800,
    context: parsePreviewContext(req.body),
  };
});

export const publishDraftValidator = requestValidator((req) => {
  assertBodyKeys(req.body, ["revision", "mode", "scheduled_for", "change_note"],
    ["revision", "mode", "change_note"]);
  return {
    id: parseDraftId(req), revision: requireRevision(req.body.revision),
    idempotencyKey: parseIdempotencyKey(req), mode: req.body.mode,
    scheduledFor: req.body.scheduled_for, changeNote: req.body.change_note,
  };
});

export const rollbackValidator = requestValidator((req) => {
  assertBodyKeys(req.body, ["change_note"], ["change_note"]);
  return { versionId: parseVersionId(req), changeNote: req.body.change_note,
    idempotencyKey: parseIdempotencyKey(req) };
});
