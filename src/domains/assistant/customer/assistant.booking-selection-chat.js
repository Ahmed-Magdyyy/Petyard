import { createHash } from "node:crypto";
import { bookingReadsEnabled } from "../shared/assistant.config.js";
import { bookingContextInput } from "./assistant.booking-context.js";
import { storedBookingDto } from "./assistant.booking-cards.js";
import { advanceBookingSelection } from "./assistant.booking-selection.js";

const neutral = { action: "none", services: [], locationId: "", date: "", hour24: null, sourceQuote: "" };
export const selectionBinding = run => createHash("sha256").update(JSON.stringify({ owner: String(run.owner), chat: String(run.chat),
  contextVersion: run.contextVersion, subjectId: run.subjectId ?? null, profile: run.subjectFingerprint ?? null,
  configuration: run.config.signature, location: bookingContextInput(run.bookingContext ?? { location: null }).location })).digest("hex");

export async function loadBookingSelection(run, chat, config, session = null, now = new Date()) {
  if (!bookingReadsEnabled(config)) return null;
  const { AssistantMessage } = await import("../shared/assistant.models.js");
  const message = await AssistantMessage.findOne({ owner: run.owner, chat: run.chat, role: "assistant", subjectId: run.subjectId ?? null,
    sequence: { $gt: chat.contextAfterSequence, $lt: run.userSequence }, bookingSelectionJson: { $exists: true },
    expiresAt: { $gt: now }, createdAt: { $gt: new Date(now.getTime() - config.memoryDays * 86400000) } })
    .sort({ sequence: -1 }).maxTimeMS(5000).session(session).lean();
  if (!message || typeof message.bookingSelectionJson !== "string" || Buffer.byteLength(message.bookingSelectionJson) > 4096) return null;
  try {
    const state = JSON.parse(message.bookingSelectionJson), catalog = storedBookingDto(message.bookingJson);
    const result = advanceBookingSelection({ intent: neutral, catalog, binding: selectionBinding(run), previous: state });
    if (result.discardedPrevious) return null;
    return { messageId: String(message._id), state: result.state, catalog };
  } catch { return null; }
}

export function bookingSelectionContext(previous) {
  return previous ? { selection: previous.state.selection,
    services: previous.catalog.services.map(service => [service.type, service.options.map(option => [option.key, option.name])]),
    locations: previous.catalog.locations.map(location => [location.id, location.name]) } : null;
}

export function selectionCard(raw, catalog, subjectId) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096 || !catalog) return null;
  try {
    const state = JSON.parse(raw), result = advanceBookingSelection({ intent: neutral, catalog, binding: state.binding, previous: state });
    if (result.discardedPrevious) return null;
    const petId = typeof subjectId === "string" && /^pet:[a-f\d]{24}$/i.test(subjectId) ? subjectId.slice(4) : null;
    return { status: result.status, dataMode: "selection_snapshot", generatedAt: result.catalogGeneratedAt,
      selection: { ...result.state.selection, petId }, missing: result.missing, unavailable: result.unavailable,
      timezone: "Africa/Cairo", estimateOnly: true, slotReserved: false, requiresExplicitConfirmation: true,
      requiresRefreshBeforeConfirmation: true, requiresPetAndContactReview: true,
      action: result.previewSelection && catalog.action ? { type: "review_booking_selection", requiresFreshLocation: true,
        booking: { ...result.previewSelection, ...(petId ? { petId } : {}) } } : null };
  } catch { return null; }
}

export function renderBookingSelection(card, language) {
  const ar = language === "ar";
  if (card.status === "choice_unavailable") return ar ? "اختيار من الخدمة أو الفرع مبقاش موجود في الكتالوج. راجع الاختيارات المتاحة؛ لسه مفيش حجز اتعمل." : "A selected service, option or branch is no longer in the catalog. Review the available choices; no booking has been made.";
  if (card.status === "selection_complete") return ar ? "جمّعت اختيارات الحجز. افتح المراجعة عشان تتأكد من الحيوان وبياناتك وتوافر الميعاد والسعر قبل ما تأكد بنفسك. لسه مفيش ميعاد اتحجز." : "I've collected your booking choices. Open the review to check the pet, your details, availability and price before confirming yourself. No appointment is reserved.";
  const fields = [...new Set(card.missing.map(field => field.startsWith("services[") ? "option" : field))];
  const labels = ar ? { services: "الخدمة", option: "نوع الخدمة بالتحديد", locationId: "الفرع", date: "التاريخ", hour24: "الساعة مع تحديد صباحًا أو مساءً" }
    : { services: "service", option: "service option", locationId: "branch", date: "date", hour24: "hour with AM or PM" };
  return ar ? `عشان نكمّل الاختيارات، محتاج: ${fields.map(field => labels[field]).join("، ")}. لسه مفيش حجز اتعمل.`
    : `To complete your choices, I need: ${fields.map(field => labels[field]).join(", ")}. No booking has been made.`;
}
