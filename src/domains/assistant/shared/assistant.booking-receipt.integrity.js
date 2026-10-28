import { createHash } from "node:crypto";
import { reject } from "./assistant.errors.js";

const canonical = (value) => {
  if (typeof value === "number" && !Number.isFinite(value)) reject("invalid_request");
  return Array.isArray(value) ? value.map(canonical) : value && value.constructor === Object
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
};
export const encodeBookingReceipt = (value) => {
  const json = JSON.stringify(canonical(value));
  if (typeof json !== "string" || Buffer.byteLength(json) > 65536) reject("booking_preview_too_large", 413);
  return json;
};
export const hashBookingReceipt = (value) => createHash("sha256").update(encodeBookingReceipt(value)).digest("hex");
export function bookingReceiptDto(record) {
  try {
    if (typeof record.resultJson !== "string" || Buffer.byteLength(record.resultJson) > 65536) throw new Error();
    const result = JSON.parse(record.resultJson);
    if (result.status !== "confirmed" || !Array.isArray(result.services) || !result.services.length || result.services.length > 12 ||
      new Set(result.services.map((entry) => entry.reservationId)).size !== result.services.length ||
      result.services.some((entry) => typeof entry.reservationId !== "string" || !/^[a-f\d]{24}$/.test(entry.reservationId)) ||
      hashBookingReceipt(result) !== record.resultHash || !record.recordedAt || !Number.isFinite(new Date(record.recordedAt).getTime())) throw new Error();
    return { proposalId: String(record._id), recordedAt: new Date(record.recordedAt).toISOString(), result };
  } catch { reject("booking_receipt_unavailable", 503); }
}
