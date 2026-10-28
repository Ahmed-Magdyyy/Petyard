import mongoose from "mongoose";
import { reject } from "./assistant.errors.js";
import { bookingContextInput } from "../customer/assistant.booking-context.js";

export const memoryKeys = Object.freeze(["food_preference", "care_preference", "communication_preference", "discussion_summary"]);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
export function fields(body, allowed) {
  if (!object(body) || Object.keys(body).some((key) => !allowed.includes(key))) reject("invalid_request");
  return body;
}
export function text(value, max, code = "invalid_request") {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\u0000")) reject(code);
  return value.trim();
}
export function objectId(value) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) reject("invalid_identifier");
  return new mongoose.Types.ObjectId(value);
}
export function subjectId(value, { allowUser = false } = {}) {
  if ((allowUser && value === "user") || value === null) return value;
  if (typeof value !== "string" || !/^(pet:[a-f\d]{24}|chat:[a-f\d-]{36})$/i.test(value)) reject("invalid_subject");
  return value;
}
export function submission(body, key, config) {
  fields(body, ["text", "subjectId", "catalogContext", "bookingContext"]);
  if (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) reject("idempotency_key_required");
  let catalogContext;
  if (body.catalogContext !== undefined) {
    fields(body.catalogContext, ["warehouseId", "language"]);
    if (!["ar", "en"].includes(body.catalogContext.language)) reject("invalid_request");
    catalogContext = { warehouseId: body.catalogContext.warehouseId === null ? null : String(objectId(body.catalogContext.warehouseId)), language: body.catalogContext.language };
    if (config.productSearchEnabled !== true) reject("product_search_unavailable", 503);
  }
  return { text: text(body.text, config.maxMessageChars, "message_too_long"),
    subjectId: body.subjectId === undefined ? undefined : subjectId(body.subjectId), key,
    ...(catalogContext === undefined ? {} : { catalogContext }),
    ...(body.bookingContext === undefined ? {} : { bookingContext: bookingContextInput(body.bookingContext) }) };
}
export function memoryInput(body, config) {
  fields(body, ["subjectId", "key", "value"]);
  if (!memoryKeys.includes(body.key)) reject("invalid_memory_key");
  const subject = subjectId(body.subjectId, { allowUser: true });
  if (!subject) reject("invalid_subject");
  return { subjectId: subject, key: body.key, value: text(body.value, config.memoryValueChars),
    kind: body.key === "discussion_summary" ? "discussion_summary" : "preference" };
}
export function page(query) {
  if (Object.keys(query).some((key) => !["before", "limit"].includes(key))) reject("invalid_request");
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const before = query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(query.before);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) reject("invalid_pagination");
  return { limit, before };
}
