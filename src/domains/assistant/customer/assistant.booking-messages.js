import { AssistantChat, AssistantMessage } from "../shared/assistant.models.js";
import { AssistantBookingProposal, assertBookingProposalStore } from "../shared/assistant.booking-proposal.model.js";
import { AssistantBookingReceipt } from "../shared/assistant.booking-receipt.model.js";
import { bookingActionsEnabled, bookingReadsEnabled } from "../shared/assistant.config.js";
import { event, transaction } from "../shared/assistant.store.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { access as assertBookingReadAccess } from "./assistant.booking-read-core.js";
import { bookingStateFromRecords, getBookingProposalState } from "./assistant.booking-proposals.js";
import { buildBookingReviewCard, renderBookingReview } from "./assistant.booking-review-cards.js";
import { messageDto } from "../shared/assistant.dto.js";

const reference = message => message.role === "assistant" && message.bookingReview &&
  String(message.bookingReview.proposalId) === String(message._id) && String(message.run) === String(message._id) &&
  ["en", "ar"].includes(message.bookingReview.language);

export async function ensureBookingReviewMessage(ownerValue, idValue, config) {
  const owner = objectId(String(ownerValue)), id = objectId(idValue);
  return transaction(async session => {
    await assertBookingReadAccess(owner, config, session); await assertBookingProposalStore();
    const record = await AssistantBookingProposal.findOne({ _id: id, owner }).maxTimeMS(5000).session(session).lean();
    if (!record || record.detailsRemovedAt) reject("booking_review_removed", 410);
    const until = record.chatMessageExpiresAt ?? (record.createdAt instanceof Date ? new Date(record.createdAt.getTime() + config.historyDays * 86400000) : null);
    if (!(until instanceof Date) || !Number.isFinite(until.getTime())) reject("booking_message_unavailable", 503);
    if (until <= new Date()) return null;
    const existing = await AssistantMessage.findOne({ _id: id }).maxTimeMS(5000).session(session).lean();
    if (existing) {
      if (String(existing.owner) !== String(owner) || !reference(existing)) reject("booking_message_conflict", 503);
      await assertBookingReadAccess(owner, config, session); return String(id);
    }
    let language;
    try { language = JSON.parse(record.inputJson).language; } catch { reject("booking_proposal_unavailable", 503); }
    if (!["en", "ar"].includes(language)) reject("booking_proposal_unavailable", 503);
    const chat = await AssistantChat.findOne({ owner }).maxTimeMS(5000).session(session).lean();
    if (!chat || !Number.isSafeInteger(chat.nextSequence) || chat.nextSequence < 0 || chat.nextSequence >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(chat.__v) || chat.__v < 0 || chat.__v >= Number.MAX_SAFE_INTEGER) reject("booking_context_unavailable", 503);
    const written = await AssistantChat.updateOne({ _id: chat._id, owner, nextSequence: chat.nextSequence, __v: chat.__v },
      { $inc: { nextSequence: 1, __v: 1 } }, { session });
    if (written.matchedCount !== 1 || written.modifiedCount !== 1) reject("context_changed", 409);
    await AssistantMessage.create([{ _id: id, run: id, owner, chat: chat._id, sequence: chat.nextSequence + 1, role: "assistant",
      subjectId: null, text: language === "ar" ? "مراجعة الحجز" : "Booking review", expiresAt: until,
      bookingReview: { proposalId: id, language } }], { session });
    await assertBookingReadAccess(owner, config, session);
    await event(owner, "booking_review_message_retained", config, { proposalId: String(id) }, { session });
    return String(id);
  });
}

export async function bookingReviewPresentation(ownerValue, state, config, { publish = false } = {}) {
  const owner = objectId(String(ownerValue)), id = objectId(state.proposal?.id ?? state.receipt?.proposalId);
  let chatMessageId = publish ? await ensureBookingReviewMessage(owner, String(id), config) : null;
  if (!publish) {
    const existing = await AssistantMessage.findOne({ _id: id, owner }).maxTimeMS(5000).lean();
    if (existing && reference(existing)) chatMessageId = String(id);
  }
  await assertBookingReadAccess(owner, config);
  // Reconcile after presentation work, so a concurrent confirmation cannot leave an earlier pending draft in this response.
  const current = await getBookingProposalState(owner, String(id), config);
  const bookingReview = buildBookingReviewCard(current, { actionsAllowed: bookingActionsEnabled(config) });
  await assertBookingReadAccess(owner, config);
  return { ...state, ...current, chatMessageId, bookingReview };
}

export async function bookingMessageDtos(messages, ownerValue, config) {
  const dtos = messages.map(messageDto), refs = messages.filter(reference);
  if (!refs.length || !bookingReadsEnabled(config)) return dtos;
  const owner = objectId(String(ownerValue)), ids = [...new Set(refs.map(message => String(message._id)))].map(objectId);
  if (ids.length > 100) reject("booking_history_unavailable", 503);
  try {
    await assertBookingReadAccess(owner, config); await assertBookingProposalStore();
    const indexes = await AssistantBookingReceipt.collection.indexes();
    if (!indexes.some(entry => entry.name === "_id_" && JSON.stringify(entry.key) === '{"_id":1}' && !entry.partialFilterExpression &&
      !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) || indexes.some(entry => entry.expireAfterSeconds !== undefined)) reject("booking_history_unavailable", 503);
    const proposals = await AssistantBookingProposal.find({ _id: { $in: ids }, owner }).limit(101).maxTimeMS(5000).lean();
    const receipts = await AssistantBookingReceipt.find({ _id: { $in: ids } }).limit(101).maxTimeMS(5000).lean();
    if (proposals.length > ids.length || receipts.length > ids.length) reject("booking_history_unavailable", 503);
    const byId = new Map(proposals.map(row => [String(row._id), row])), receiptById = new Map(receipts.map(row => [String(row._id), row]));
    if (byId.size !== proposals.length || receiptById.size !== receipts.length) reject("booking_history_unavailable", 503);
    for (const message of refs) {
      const index = messages.indexOf(message), id = String(message._id), row = byId.get(id);
      try {
        if (String(message.owner) !== String(owner) || !row) continue;
        const state = row.detailsRemovedAt && !receiptById.has(id) ? { proposal: { id, status: "removed" }, receipt: null }
          : bookingStateFromRecords(row, receiptById.get(id));
        const card = buildBookingReviewCard(state, { actionsAllowed: bookingActionsEnabled(config) });
        dtos[index] = { ...dtos[index], bookingReview: card, text: renderBookingReview(card, message.bookingReview.language) };
      } catch { /* A bad reference must not turn an unavailable review into a booking success. */ }
    }
    await assertBookingReadAccess(owner, config); return dtos;
  } catch { return messages.map(messageDto); }
}
