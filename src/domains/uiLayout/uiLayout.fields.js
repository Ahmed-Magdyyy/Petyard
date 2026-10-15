import { isIP } from "node:net";
import { OBJECT_ID, UUID, UI_LAYOUT_ACTION_TYPES, UI_LAYOUT_ENTITY_ACTION_TYPES } from "./uiLayout.constants.js";

export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function add(errors, path, code, message) { errors.push({ path, code, message }); }

export function keys(value, allowed, path, errors, required = []) {
  if (!object(value)) { add(errors, path, "INVALID_OBJECT", "Must be an object."); return false; }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(errors, `${path}.${key}`, "UNKNOWN_FIELD", "Unknown field.");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) add(errors, `${path}.${key}`, "REQUIRED", "Required field.");
  }
  return true;
}

export function string(value, path, errors, { max, required = false } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    add(errors, path, "INVALID_STRING", `Must be a ${required ? "non-empty " : ""}string of at most ${max} characters.`);
  }
}

export function localizedText(value, path, errors, { max, required = false, localized = false } = {}) {
  if (!localized || typeof value === "string" || value === undefined) {
    return string(value, path, errors, { max, required });
  }
  if (!object(value) || Object.keys(value).some((key) => !["en", "ar"].includes(key)) ||
    Object.values(value).some((text) => typeof text !== "string" || text.length > max) ||
    (required && !Object.values(value).some((text) => typeof text === "string" && text.trim()))) {
    add(errors, path, "LOCALIZED_TEXT_INVALID", `Use text or an en/ar text map, at most ${max} characters per language${required ? ", with non-empty text" : ""}.`);
  }
}

export function bool(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== "boolean") add(errors, path, "INVALID_BOOLEAN", "Must be a boolean.");
}

export function integer(value, path, errors, min, max, required = false) {
  if (value === undefined && !required) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    add(errors, path, "INVALID_INTEGER", `Must be an integer from ${min} to ${max}.`);
  }
}

export function oneOf(value, allowed, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!allowed.has(value)) add(errors, path, "INVALID_ENUM", `Must be one of: ${[...allowed].join(", ")}.`);
}

export function uuid(value, path, errors) {
  if (typeof value !== "string" || !UUID.test(value)) add(errors, path, "INVALID_UUID", "Must be a UUID.");
}

export function color(value, path, errors) {
  if (value !== undefined && (typeof value !== "string" || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))) {
    add(errors, path, "INVALID_COLOR", "Must be #RRGGBB or #AARRGGBB.");
  }
}

export function isPublicHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return !(url.protocol !== "https:" || url.username || url.password || url.port ||
      !host.includes(".") || host === "localhost" || host.endsWith(".local") || isIP(host) ||
      /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./.test(host));
  } catch { return false; }
}

export function safeHttpsUrl(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!isPublicHttpsUrl(value)) add(errors, path, "INVALID_HTTPS_URL", "Must be a public HTTPS URL.");
}

export function action(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!keys(value, ["type", "value"], path, errors, ["type", "value"])) return;
  oneOf(value.type, new Set(UI_LAYOUT_ACTION_TYPES), `${path}.type`, errors, true);
  string(value.value, `${path}.value`, errors, { max: 2048, required: true });
  if (UI_LAYOUT_ENTITY_ACTION_TYPES.includes(value.type) &&
    typeof value.value === "string" && !OBJECT_ID.test(value.value)) {
    add(errors, `${path}.value`, "INVALID_REFERENCE_ID", "Must be a MongoDB ObjectId.");
  }
  if (value.type === "screen" && value.value !== "add_pet_profile") {
    add(errors, `${path}.value`, "INVALID_SCREEN", "Only add_pet_profile is supported.");
  }
  if (value.type === "url") {
    safeHttpsUrl(value.value, `${path}.value`, errors, true);
    try {
      const host = new URL(value.value).hostname.toLowerCase();
      if (host !== "petyardstores.com" && !host.endsWith(".petyardstores.com")) {
        add(errors, `${path}.value`, "URL_HOST_NOT_APPROVED", "Only approved PetYard hosts are supported.");
      }
    } catch { /* The URL error is already recorded. */ }
  }
}
