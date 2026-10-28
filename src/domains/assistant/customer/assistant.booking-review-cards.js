import { reject } from "../shared/assistant.errors.js";

export const BOOKING_REVIEW_CARD_MAX_BYTES = 65536;
const id = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const label = value => value === null || typeof value === "string" && value.length <= 256 && !value.includes("\u0000");
const fail = () => reject("booking_review_card_unavailable", 503);
function service(value, confirmed) {
  if (!value || !["GROOMING", "SHOWERING", "CLINIC"].includes(value.serviceType) ||
    !label(value.serviceName) || !label(value.serviceOptionName) || !label(value.label) ||
    value.serviceOptionKey !== null && (typeof value.serviceOptionKey !== "string" || value.serviceOptionKey.length > 128) ||
    !["CLINIC_ROOM", "GROOMING_ROOM"].includes(value.roomType) || !Number.isInteger(value.hour24) || value.hour24 < 0 || value.hour24 > 23 ||
    typeof value.price !== "number" || !Number.isFinite(value.price) || value.price < 0 || !Number.isSafeInteger(Math.round(value.price * 100)) ||
    value.currency !== "EGP" || typeof value.startsAt !== "string" || typeof value.endsAt !== "string" ||
    !Number.isFinite(Date.parse(value.startsAt)) || !Number.isFinite(Date.parse(value.endsAt)) || new Date(value.startsAt) >= new Date(value.endsAt) ||
    confirmed && !id(value.reservationId)) fail();
  return { serviceType: value.serviceType, serviceOptionKey: value.serviceOptionKey, serviceName: value.serviceName,
    serviceOptionName: value.serviceOptionName, roomType: value.roomType, hour24: value.hour24, label: value.label,
    startsAt: value.startsAt, endsAt: value.endsAt, price: value.price, currency: "EGP",
    ...(confirmed ? { reservationId: value.reservationId } : {}) };
}
export function buildBookingReviewCard(state, { actionsAllowed = false, capturedAt = new Date().toISOString() } = {}) {
  const proposal = { ...state?.proposal }, receipt = state?.receipt ?? null, confirmed = proposal.status === "confirmed";
  if (proposal.status === "pending" && new Date(proposal.expiresAt) <= new Date(capturedAt)) proposal.status = "expired";
  if (!id(proposal?.id) || !["pending", "expired", "confirmed", "removed", "unavailable"].includes(proposal.status) ||
    typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt)) || typeof actionsAllowed !== "boolean") fail();
  const hidden = ["removed", "unavailable"].includes(proposal.status);
  let details = null, recordedAt = null;
  if (!hidden) {
    const source = confirmed ? receipt?.result : proposal.quote;
    const locationId = confirmed ? source?.locationId : source?.location?.id;
    if (proposal.version !== 1 || typeof proposal.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(proposal.fingerprint) ||
      !Number.isFinite(Date.parse(proposal.expiresAt)) || !source || !id(locationId) || source.timezone !== "Africa/Cairo" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.date ?? "") || source.currency !== "EGP" || !Number.isFinite(source.totalPrice) || source.totalPrice < 0 ||
      !Number.isSafeInteger(Math.round(source.totalPrice * 100)) || !Array.isArray(source.services) || !source.services.length || source.services.length > 12) fail();
    if (confirmed && (receipt.proposalId !== proposal.id || source.status !== "confirmed" || !Number.isFinite(Date.parse(receipt.recordedAt)))) fail();
    if (!confirmed && (receipt || source.estimateOnly !== true || source.slotReserved !== false)) fail();
    const location = proposal.quote?.location;
    if (!location || location.id !== locationId || !label(location.name) || !/^alexandria$/i.test(location.city ?? "")) fail();
    const pet = source.pet;
    if (!pet || pet.id !== null && !id(pet.id) || !label(pet.name) || !label(pet.type) || !label(pet.gender) ||
      pet.age !== null && (typeof pet.age !== "number" || !Number.isFinite(pet.age) || pet.age < 0)) fail();
    details = { location: { id: locationId, name: location.name, city: location.city }, date: source.date, timezone: source.timezone, currency: "EGP", totalPrice: source.totalPrice,
      pet: { id: pet.id, name: pet.name, type: pet.type, age: pet.age, gender: pet.gender }, services: source.services.map(value => service(value, confirmed)) };
    if (new Set(details.services.map(value => value.startsAt)).size !== details.services.length ||
      confirmed && new Set(details.services.map(value => value.reservationId)).size !== details.services.length) fail();
    recordedAt = confirmed ? receipt.recordedAt : null;
  }
  const card = { proposalId: proposal.id, kind: confirmed ? "creation_result" : "review", status: proposal.status,
    dataMode: confirmed ? "creation_snapshot" : "review_snapshot", capturedAt, recordedAt,
    expiresAt: hidden ? null : proposal.expiresAt, version: hidden ? null : proposal.version, fingerprint: hidden ? null : proposal.fingerprint,
    details, requiresExplicitConfirmation: !confirmed, currentStatusIncluded: false,
    action: confirmed ? { type: "refresh_booking_status", proposalId: proposal.id }
      : proposal.status === "pending" && actionsAllowed ? { type: "confirm_booking_review", proposalId: proposal.id,
        expectedVersion: proposal.version, fingerprint: proposal.fingerprint, requiresFreshLocation: true } : null };
  if (Buffer.byteLength(JSON.stringify(card)) > BOOKING_REVIEW_CARD_MAX_BYTES) fail();
  return card;
}
export function renderBookingReview(card, language) {
  const ar = language === "ar";
  if (card.status === "confirmed") return ar ? "إنشاء الحجز متسجّل بالتفاصيل دي. دي بيانات وقت الإنشاء؛ حدّث حالة الحجز عشان تعرف حالته دلوقتي." : "Booking creation is recorded with these details. This is the creation snapshot; refresh the booking status to see its current state.";
  if (card.status === "removed") return ar ? "تفاصيل المراجعة اللي ما اتأكدتش اتمسحت. لو لسه محتاج الحجز، ابدأ مراجعة جديدة." : "The unused review details were removed. Start a new review if you still want to book.";
  if (card.status === "unavailable") return ar ? "مش قادر أعرض تفاصيل مراجعة الحجز دلوقتي. راجع حالة نفس المراجعة قبل ما تبدأ حجز جديد." : "I can't show this booking review right now. Check the same review before starting another booking.";
  if (card.status === "expired") return ar ? "المراجعة دي انتهت صلاحيتها ومفيش ميعاد اتحجز منها حسب السجل المتاح. لازم تراجع اختيار جديد قبل التأكيد." : "This review expired and the available record has no committed booking from it. Review a new selection before confirming.";
  return ar ? "راجع الخدمة والفرع والميعاد والحيوان والسعر قبل ما تضغط تأكيد بنفسك. لسه مفيش ميعاد اتحجز من المراجعة دي حسب السجل المتاح." : "Review the service, branch, time, pet and price before tapping Confirm yourself. The available record has no committed booking from this review yet.";
}
