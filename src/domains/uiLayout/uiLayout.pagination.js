import { UiLayoutError } from "./uiLayout.error.js";
import { OBJECT_ID } from "./uiLayout.constants.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEGACY_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function invalidCursor() {
  throw new UiLayoutError("UI_LAYOUT_INVALID_REQUEST", "Invalid pagination cursor.", 400,
    [{ path: "query.before", code: "INVALID_VALUE", message: "Invalid pagination cursor." }]);
}

export function encodePageCursor(row, field) {
  return Buffer.from(JSON.stringify({
    v: 1, at: new Date(row[field]).toISOString(), id: String(row._id),
  })).toString("base64url");
}

export function decodePageCursor(value) {
  if (typeof value !== "string" || value.length > 256) invalidCursor();
  // Existing callers may still send a timestamp; generated cursors include an ID
  // so they do not skip records that share the same millisecond.
  try {
    const canonicalTimestamp = LEGACY_ISO_UTC.test(value)
      ? `${value.slice(0, -1)}.000Z` : value;
    if ((ISO_UTC.test(value) || LEGACY_ISO_UTC.test(value)) &&
      new Date(value).toISOString() === canonicalTimestamp) {
      return { at: new Date(value), id: "000000000000000000000000" };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.v !== 1 || !ISO_UTC.test(decoded.at) ||
      new Date(decoded.at).toISOString() !== decoded.at ||
      !OBJECT_ID.test(decoded.id) || Object.keys(decoded).length !== 3) invalidCursor();
    return { at: new Date(decoded.at), id: decoded.id };
  } catch { invalidCursor(); }
}

export function beforePageFilter(field, cursor) {
  return [{ [field]: { $lt: cursor.at } },
    { [field]: cursor.at, _id: { $lt: cursor.id } }];
}
