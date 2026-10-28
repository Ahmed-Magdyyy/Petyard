import { writeConfirmedAssistantBooking } from "../../serviceReservation/reservations/serviceReservation.assistant-confirmation.js";
import { bookingPreviewForComparison } from "../../serviceReservation/reservations/serviceReservation.preview.js";
import { AssistantBookingReceipt } from "../shared/assistant.booking-receipt.model.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { encodeBookingReceipt as encode, hashBookingReceipt as hash, bookingReceiptDto as receiptDto } from "../shared/assistant.booking-receipt.integrity.js";

function request(value) {
  fields(value, ["owner", "proposalId", "proposalFingerprint", "booking", "language", "expectedQuote", "resolvedLocation"]);
  const owner = objectId(String(value.owner)), id = objectId(value.proposalId);
  if (typeof value.proposalFingerprint !== "string" || !/^[a-f\d]{64}$/.test(value.proposalFingerprint) ||
    !["en", "ar"].includes(value.language) || value.booking?.constructor !== Object) reject("invalid_request");
  const booking = structuredClone(value.booking), expectedQuote = JSON.parse(encode(value.expectedQuote));
  if (expectedQuote?.eligible !== true || expectedQuote.status !== "ready" || expectedQuote.slotReserved !== false || expectedQuote.estimateOnly !== true ||
    !Array.isArray(expectedQuote.services) || expectedQuote.services.length < 1 || expectedQuote.services.length > 12) reject("invalid_request");
  const requestHash = hash({ owner: String(owner), id: String(id), fingerprint: value.proposalFingerprint, booking,
    language: value.language, quote: bookingPreviewForComparison(expectedQuote) });
  return { owner, id, booking, expectedQuote, language: value.language, requestHash, resolvedLocation: structuredClone(value.resolvedLocation) };
}
function active(session) { if (!session?.inTransaction?.()) reject("booking_transaction_required", 503); }
function receiptForRequest(record, args) {
  if (String(record._id) !== String(args.id) || String(record.owner) !== String(args.owner) || record.requestHash !== args.requestHash) reject("idempotency_conflict", 409);
  return { receipt: receiptDto(record), duplicate: true };
}
export const validateBookingReceipt = (record, value) => receiptForRequest(record, request(value));
async function retained(args, session) {
  active(session);
  let indexes;
  try { indexes = await AssistantBookingReceipt.collection.indexes(); } catch { reject("booking_receipt_store_unavailable", 503); }
  if (!indexes.some((entry) => entry.name === "_id_" && JSON.stringify(entry.key) === '{"_id":1}' && !entry.partialFilterExpression &&
    !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) || indexes.some((entry) => entry.expireAfterSeconds !== undefined)) reject("booking_receipt_store_unavailable", 503);
  const record = await AssistantBookingReceipt.findOne({ _id: args.id }).maxTimeMS(5000).session(session).lean();
  if (!record) return null;
  return receiptForRequest(record, args);
}
// Internal staging only. The authenticated proposal coordinator owns authorization, context/expiry and commit.
export async function stageBookingWithReceipt(value, { session } = {}) {
  active(session); const args = request(value);
  const previous = await retained(args, session); if (previous) return previous;
  const result = await writeConfirmedAssistantBooking({ userId: String(args.owner), payload: args.booking, lang: args.language, resolvedLocation: args.resolvedLocation }, args.expectedQuote, { session });
  const [record] = await AssistantBookingReceipt.create([{ _id: args.id, owner: args.owner, requestHash: args.requestHash,
    resultJson: encode(result), resultHash: hash(result), recordedAt: new Date(), notificationPending: true }], { session });
  return { receipt: receiptDto(record), duplicate: false };
}
export async function recoverBookingReceipt(value, { session } = {}) { active(session); return retained(request(value), session); }
export { receiptDto as bookingReceiptDto };
