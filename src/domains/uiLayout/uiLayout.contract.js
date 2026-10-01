import { isIP } from "node:net";

import {
  UI_LAYOUT_MAX_BYTES, UI_LAYOUT_MAX_SECTIONS, UI_LAYOUT_MAX_ITEMS,
  NAVIGATION_ITEMS, BUILTIN_SECTION_TYPES, CONFIGURABLE_SECTION_TYPES,
  UUID, OBJECT_ID, SEMVER, LOCALE, COUNTRY, PROMO_LAYOUTS, PROMO_VISIBILITY,
  DISPLAY_TYPES, CARD_STYLES, PLATFORMS, AUDIENCES,
} from "./uiLayout.constants.js";
import { compareVersions } from "./uiLayout.targeting.js";

const SECTION_TYPES = new Set([...BUILTIN_SECTION_TYPES, ...CONFIGURABLE_SECTION_TYPES]);
const COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function add(errors, path, code, message) {
  errors.push({ path, code, message });
}

function keys(value, allowed, path, errors, required = []) {
  if (!object(value)) {
    add(errors, path, "INVALID_OBJECT", "Must be an object.");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(errors, `${path}.${key}`, "UNKNOWN_FIELD", "Unknown field.");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) add(errors, `${path}.${key}`, "REQUIRED", "Required field.");
  }
  return true;
}

function string(value, path, errors, { max, required = false } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    add(errors, path, "INVALID_STRING", `Must be a ${required ? "non-empty " : ""}string of at most ${max} characters.`);
  }
}

function bool(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== "boolean") add(errors, path, "INVALID_BOOLEAN", "Must be a boolean.");
}

function integer(value, path, errors, min, max, required = false) {
  if (value === undefined && !required) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    add(errors, path, "INVALID_INTEGER", `Must be an integer from ${min} to ${max}.`);
  }
}

function oneOf(value, allowed, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!allowed.has(value)) add(errors, path, "INVALID_ENUM", `Must be one of: ${[...allowed].join(", ")}.`);
}

function uuid(value, path, errors) {
  if (typeof value !== "string" || !UUID.test(value)) {
    add(errors, path, "INVALID_UUID", "Must be a UUID.");
  }
}

function color(value, path, errors) {
  if (value !== undefined && (typeof value !== "string" || !COLOR.test(value))) {
    add(errors, path, "INVALID_COLOR", "Must be #RRGGBB or #AARRGGBB.");
  }
}

export function isPublicHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !host.includes(".") || host === "localhost" || host.endsWith(".local") ||
      isIP(host) || /^(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./.test(host)) {
      return false;
    }
    return true;
  } catch { return false; }
}

function safeHttpsUrl(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!isPublicHttpsUrl(value)) {
    add(errors, path, "INVALID_HTTPS_URL", "Must be a public HTTPS URL.");
  }
}

function action(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (!keys(value, ["type", "value"], path, errors, ["type", "value"])) return;
  oneOf(value.type, new Set(["product", "category", "brand", "screen", "url"]), `${path}.type`, errors, true);
  string(value.value, `${path}.value`, errors, { max: 2048, required: true });
  if (["product", "category", "brand"].includes(value.type) &&
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
    } catch { /* INVALID_HTTPS_URL was already recorded. */ }
  }
}

function promo(data, path, errors, publish) {
  const allowed = ["enabled", "visibility", "layout", "image_url", "title", "subtitle", "cta_text",
    "background_color", "title_color", "subtitle_color", "cta_background", "cta_color", "action"];
  if (!keys(data, allowed, path, errors)) return;
  bool(data.enabled, `${path}.enabled`, errors, publish);
  oneOf(data.visibility, PROMO_VISIBILITY, `${path}.visibility`, errors, publish);
  oneOf(data.layout, PROMO_LAYOUTS, `${path}.layout`, errors, publish);
  string(data.title, `${path}.title`, errors, { max: 80, required: publish });
  string(data.subtitle, `${path}.subtitle`, errors, { max: 180 });
  string(data.cta_text, `${path}.cta_text`, errors, { max: 30 });
  safeHttpsUrl(data.image_url, `${path}.image_url`, errors);
  if (publish && ["split", "full_banner"].includes(data.layout) && !data.image_url) {
    add(errors, `${path}.image_url`, "IMAGE_REQUIRED", "This layout needs an image.");
  }
  for (const field of ["background_color", "title_color", "subtitle_color", "cta_background", "cta_color"]) {
    color(data[field], `${path}.${field}`, errors);
  }
  action(data.action, `${path}.action`, errors, publish && Boolean(data.cta_text));
}

function dynamic(data, path, errors, publish) {
  const allowed = ["enabled", "title", "subtitle", "display_type", "card_style",
    "columns_per_row", "limit", "show_see_all", "background_color", "action", "items"];
  if (!keys(data, allowed, path, errors)) return;
  bool(data.enabled, `${path}.enabled`, errors, publish);
  string(data.title, `${path}.title`, errors, { max: 80, required: publish });
  string(data.subtitle, `${path}.subtitle`, errors, { max: 180 });
  oneOf(data.display_type, DISPLAY_TYPES, `${path}.display_type`, errors, publish);
  oneOf(data.card_style, CARD_STYLES, `${path}.card_style`, errors, publish);
  integer(data.columns_per_row, `${path}.columns_per_row`, errors, 1, 4);
  integer(data.limit, `${path}.limit`, errors, 1, UI_LAYOUT_MAX_ITEMS);
  bool(data.show_see_all, `${path}.show_see_all`, errors);
  color(data.background_color, `${path}.background_color`, errors);
  action(data.action, `${path}.action`, errors, publish && data.show_see_all === true);
  if (data.items === undefined && !publish) return;
  if (!Array.isArray(data.items) || data.items.length > UI_LAYOUT_MAX_ITEMS ||
    (publish && data.items.length < 1)) {
    add(errors, `${path}.items`, "INVALID_ITEMS", "Must contain 1 to 20 items when published.");
    return;
  }
  const ids = new Set();
  data.items.forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`;
    if (!keys(item, ["id", "name", "subtitle", "image_url", "action"], itemPath, errors)) return;
    uuid(item.id, `${itemPath}.id`, errors);
    if (ids.has(item.id)) add(errors, `${itemPath}.id`, "DUPLICATE_ID", "Item ID must be unique.");
    ids.add(item.id);
    string(item.name, `${itemPath}.name`, errors, { max: 80, required: publish });
    string(item.subtitle, `${itemPath}.subtitle`, errors, { max: 100 });
    safeHttpsUrl(item.image_url, `${itemPath}.image_url`, errors);
    action(item.action, `${itemPath}.action`, errors);
  });
}

function navigation(value, errors, publish) {
  if (!keys(value, ["items"], "content.navigation", errors, publish ? ["items"] : [])) return;
  if (value.items === undefined && !publish) return;
  if (!Array.isArray(value.items) || value.items.length > Object.keys(NAVIGATION_ITEMS).length) {
    add(errors, "content.navigation.items", "INVALID_NAVIGATION", "Must contain at most five items.");
    return;
  }
  const seen = new Set();
  const orders = new Set();
  let enabledCount = 0;
  value.items.forEach((item, index) => {
    const path = `content.navigation.items[${index}]`;
    if (!keys(item, ["key", "label_key", "icon_key", "destination", "order", "enabled"], path, errors)) return;
    const fixed = typeof item.key === "string" && Object.hasOwn(NAVIGATION_ITEMS, item.key)
      ? NAVIGATION_ITEMS[item.key] : null;
    if (!fixed || item.destination !== item.key || item.icon_key !== fixed.icon_key ||
      item.label_key !== fixed.label_key) add(errors, path, "INVALID_NAVIGATION_ITEM", "Must use a supported destination, icon, and label.");
    if (seen.has(item.key)) add(errors, `${path}.key`, "DUPLICATE_NAVIGATION", "Navigation key must be unique.");
    seen.add(item.key);
    integer(item.order, `${path}.order`, errors, 0, Object.keys(NAVIGATION_ITEMS).length - 1, true);
    if (orders.has(item.order)) add(errors, `${path}.order`, "DUPLICATE_ORDER", "Order must be unique.");
    orders.add(item.order);
    bool(item.enabled, `${path}.enabled`, errors, true);
    if (item.enabled === true) enabledCount += 1;
  });
  if (publish && (!value.items.some((item) => item?.key === "home" && item.enabled === true) ||
    enabledCount < 1)) {
    add(errors, "content.navigation.items", "HOME_NAVIGATION_REQUIRED", "An enabled home destination is required.");
  }
}

function fab(value, errors) {
  if (value === undefined) return;
  const path = "content.floating_action_button";
  if (!keys(value, ["enabled", "key", "icon_key", "action"], path, errors, ["enabled"])) return;
  bool(value.enabled, `${path}.enabled`, errors, true);
  if (value.key !== undefined && value.key !== "chatbot") add(errors, `${path}.key`, "INVALID_FAB", "Must be chatbot.");
  if (value.icon_key !== undefined && value.icon_key !== "chatbot") add(errors, `${path}.icon_key`, "INVALID_FAB", "Must be chatbot.");
  if (value.action !== undefined &&
    (!object(value.action) || value.action.type !== "route" || value.action.destination !== "chatbot" ||
      Object.keys(value.action).some((key) => !["type", "destination"].includes(key)))) {
    add(errors, `${path}.action`, "INVALID_FAB", "Must route to chatbot.");
  }
}

export function inspectLayoutContent(value, { publish = false } = {}) {
  const errors = [];
  if (!keys(value, ["sections", "navigation", "floating_action_button"], "content", errors,
    publish ? ["sections", "navigation"] : [])) return { valid: false, errors, content: null };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > UI_LAYOUT_MAX_BYTES) {
    add(errors, "content", "PAYLOAD_TOO_LARGE", "Layout exceeds 256 KiB.");
  }
  if (value.sections !== undefined) {
    if (!Array.isArray(value.sections) || value.sections.length > UI_LAYOUT_MAX_SECTIONS ||
      (publish && value.sections.length < 1)) {
      add(errors, "content.sections", "INVALID_SECTIONS", "Must contain 1 to 30 sections when published.");
    } else {
      const ids = new Set();
      const sectionKeys = new Set();
      const builtins = new Set();
      const positions = new Set();
      value.sections.forEach((section, index) => {
        const path = `content.sections[${index}]`;
        if (!keys(section, ["id", "section_type", "key", "name", "position", "data"], path, errors)) return;
        uuid(section.id, `${path}.id`, errors);
        if (ids.has(section.id)) add(errors, `${path}.id`, "DUPLICATE_ID", "Section ID must be unique.");
        ids.add(section.id);
        if (!SECTION_TYPES.has(section.section_type)) add(errors, `${path}.section_type`, "UNSUPPORTED_SECTION", "Section type is not supported by the customer app.");
        if (BUILTIN_SECTION_TYPES.includes(section.section_type)) {
          if (builtins.has(section.section_type)) add(errors, `${path}.section_type`, "DUPLICATE_BUILTIN", "Built-in section cannot repeat.");
          builtins.add(section.section_type);
        }
        string(section.key, `${path}.key`, errors, { max: 80 });
        if (section.key !== undefined) {
          if (sectionKeys.has(section.key)) add(errors, `${path}.key`, "DUPLICATE_KEY", "Section key must be unique.");
          sectionKeys.add(section.key);
        }
        string(section.name, `${path}.name`, errors, { max: 120, required: publish });
        integer(section.position, `${path}.position`, errors, 0, UI_LAYOUT_MAX_SECTIONS - 1, true);
        if (positions.has(section.position)) add(errors, `${path}.position`, "DUPLICATE_POSITION", "Position must be unique.");
        positions.add(section.position);
        if (!object(section.data)) add(errors, `${path}.data`, "INVALID_OBJECT", "Must be an object.");
        else if (BUILTIN_SECTION_TYPES.includes(section.section_type) && Object.keys(section.data).length) {
          add(errors, `${path}.data`, "BUILTIN_DATA_UNSUPPORTED", "Built-in section data must be empty.");
        } else if (section.section_type === "admin_promo") promo(section.data, `${path}.data`, errors, publish);
        else if (section.section_type === "dynamic_section") dynamic(section.data, `${path}.data`, errors, publish);
      });
    }
  }
  if (value.navigation !== undefined) navigation(value.navigation, errors, publish);
  fab(value.floating_action_button, errors);
  if (errors.length) return { valid: false, errors, content: null };
  const content = structuredClone(value);
  if (Array.isArray(content.sections)) {
    content.sections.sort((a, b) => a.position - b.position);
    content.sections.forEach((section, position) => { section.position = position; });
  }
  if (Array.isArray(content.navigation?.items)) {
    content.navigation.items.sort((a, b) => a.order - b.order);
    content.navigation.items.forEach((item, order) => { item.order = order; });
  }
  return { valid: true, errors: [], content };
}

export function inspectTargeting(value) {
  const errors = [];
  const path = "targeting";
  const allowed = ["platforms", "locales", "country_codes", "location_ids",
    "min_app_version", "max_app_version", "audience", "priority"];
  if (!keys(value, allowed, path, errors)) return { valid: false, errors };
  for (const [field, enumSet, max] of [["platforms", PLATFORMS, 3], ["locales", null, 20],
    ["country_codes", null, 250], ["location_ids", null, 100]]) {
    const list = value[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > max || new Set(list).size !== list.length ||
      list.some((item) => typeof item !== "string" || (enumSet && !enumSet.has(item)) ||
        (field === "locales" && !LOCALE.test(item)) ||
        (field === "country_codes" && !COUNTRY.test(item)) ||
        (field === "location_ids" && !UUID.test(item) && !OBJECT_ID.test(item)))) {
      add(errors, `${path}.${field}`, "INVALID_TARGET_LIST", "Contains invalid or duplicate target values.");
    }
  }
  for (const field of ["min_app_version", "max_app_version"]) {
    const version = value[field];
    if (version !== undefined && version !== null && (typeof version !== "string" || !SEMVER.test(version))) {
      add(errors, `${path}.${field}`, "INVALID_APP_VERSION", "Must be a semantic version.");
    }
  }
  if (typeof value.min_app_version === "string" && SEMVER.test(value.min_app_version) &&
    typeof value.max_app_version === "string" && SEMVER.test(value.max_app_version)) {
    if (compareVersions(value.min_app_version, value.max_app_version) > 0) {
      add(errors, `${path}.max_app_version`, "INVALID_APP_VERSION_RANGE", "Maximum app version precedes minimum.");
    }
  }
  oneOf(value.audience, AUDIENCES, `${path}.audience`, errors);
  integer(value.priority, `${path}.priority`, errors, 0, 1000);
  return { valid: errors.length === 0, errors };
}

export function publicLayoutContent(content) {
  // The setting is saved with drafts/versions but the current Flutter app cannot apply it.
  return { sections: content.sections, navigation: content.navigation };
}
