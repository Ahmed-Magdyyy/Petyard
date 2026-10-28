import { notices } from "./assistant.errors.js";
import { storedCatalogDto } from "../products/assistant.product-cards.js";
import { cartActionsEnabled, bookingReadsEnabled, bookingActionsEnabled } from "./assistant.config.js";
import { storedCheckoutDto } from "../customer/assistant.checkout-cards.js";
import { storedBookingDto } from "../customer/assistant.booking-cards.js";
import { buildBookingReviewCard, renderBookingReview } from "../customer/assistant.booking-review-cards.js";
import { selectionCard } from "../customer/assistant.booking-selection-chat.js";
const date = (value) => value ? new Date(value).toISOString() : null;
export const messageDto = (message) => {
  const catalog = message.role === "assistant" ? storedCatalogDto(message.catalogJson) : null;
  const checkout = message.role === "assistant" ? storedCheckoutDto(message.checkoutJson) : null;
  const booking = message.role === "assistant" ? storedBookingDto(message.bookingJson) : null;
  const selection = booking ? selectionCard(message.bookingSelectionJson, booking, message.subjectId) : null;
  const review = message.role === "assistant" && message.bookingReview && String(message.bookingReview.proposalId) === String(message._id) &&
    String(message.run) === String(message._id) && ["en", "ar"].includes(message.bookingReview.language)
    ? buildBookingReviewCard({ proposal: { id: String(message._id), status: "unavailable" } }) : null;
  return { id: String(message._id), runId: String(message.run), sequence: message.sequence,
    role: message.role, text: message.text, subjectId: message.subjectId ?? null, createdAt: date(message.createdAt), expiresAt: date(message.expiresAt),
    ...(catalog ? { catalog } : {}), ...(checkout ? { checkout } : {}), ...(booking ? { booking } : {}),
    ...(selection ? { bookingSelection: selection } : {}),
    ...(review ? { runId: null, kind: "booking_review", bookingReview: review, text: renderBookingReview(review, message.bookingReview.language) } : {}) };
};
export const runDto = (run) => ({ id: String(run._id), status: run.status, subjectId: run.subjectId ?? null,
  userSequence: run.userSequence, responseMessageId: run.responseMessage ? String(run.responseMessage) : null,
  code: run.publicCode ?? null, retryAt: date(run.retryAt), message: run.status === "uncertain" ? notices.uncertain
    : ["daily_spending_limit", "monthly_budget_limit"].includes(run.publicCode) ? notices.limited : run.status === "failed" ? notices.failed : null,
  createdAt: date(run.createdAt), updatedAt: date(run.updatedAt), pollAfterMs: ["queued", "dispatching"].includes(run.status) ? 1500 : null,
  retry: "reuse_original_idempotency_key", needsReview: run.status === "uncertain" });
export const memoryDto = (memory) => ({ id: String(memory._id), subjectId: memory.subjectId, key: memory.key, kind: memory.kind,
  value: memory.state === "active" ? memory.value : null, state: memory.state, version: memory.version,
  sourceMessageId: memory.sourceMessage ? String(memory.sourceMessage) : null, updatedAt: date(memory.updatedAt), validUntil: date(memory.validUntil) });
export const chatDto = (chat, subjects) => ({ id: String(chat._id), activeSubjectId: chat.activeSubject ?? null,
  awaitingSubject: chat.awaitingSubject ?? false, contextVersion: chat.contextVersion,
  subjects: subjects.map(({ id, name, species, saved, expiresAt }) => ({ id, name: name ?? null, species: species ?? null, saved, expiresAt: date(expiresAt) })) });

export function usageLimitsDto(config, account, period) {
  return config.enabled ? { dailyMessages: config.dailyMessageLimit,
      remainingMessages: Math.max(0, config.dailyMessageLimit - (account?.day === period.day ? account.dayMessages : 0)),
      resetsAt: date(period.dayReset), maxMessageChars: config.maxMessageChars, maxOutputChars: config.maxOutputChars,
      rateWindowSeconds: config.rateWindowSeconds, rateMax: config.rateMax, oneActiveRequest: true } : null;
}

export function metadataDto(config, account, period) {
  return { identity: "Petyard's pet-care assistant", available: config.enabled && !account?.blocked,
    state: !config.enabled ? "unavailable" : account?.blocked ? "restricted" : "available",
    limits: usageLimitsDto(config, account, period),
    activeRunId: account?.activeRun ? String(account.activeRun) : null,
    clinicalScope: "education_and_veterinary_referral", capabilities: { history: true, memory: true, unsavedPets: true,
      polling: true, streaming: false, commerceActions: false, cartAdditions: !account?.blocked && cartActionsEnabled(config),
      checkoutSummary: !account?.blocked && cartActionsEnabled(config),
      bookingReads: !account?.blocked && bookingReadsEnabled(config),
      bookingActions: !account?.blocked && bookingActionsEnabled(config),
      liveCatalog: config.enabled && !account?.blocked && config.productSearchEnabled === true, webSearch: false },
    fallback: { shopping: true, booking: true } };
}
