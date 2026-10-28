import { reject } from "../shared/assistant.errors.js";

export const BOOKING_CARD_MAX_BYTES = 65536;
const states = ["ready", "empty", "ineligible", "needs_location", "unavailable"];
const fail = () => reject("invalid_booking_options", 503);
const label = value => typeof value === "string" && value.trim() && value.length <= 256 && !value.includes("\u0000");
const id = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

export function buildBookingSnapshot(value, { actionsAllowed = false, generatedAt = new Date().toISOString() } = {}) {
  if (!value || !states.includes(value.status) || typeof actionsAllowed !== "boolean" || typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) fail();
  let services = [], locations = [];
  if (["ready", "empty"].includes(value.status)) {
    if (value.eligible !== true || value.governorateCode !== "alexandria" || value.estimateOnly !== true ||
      !Array.isArray(value.services) || value.services.length > 3 || !Array.isArray(value.locations) || value.locations.length > 50) fail();
    const types = new Set(), branchIds = new Set();
    services = value.services.map(service => {
      if (!["GROOMING", "SHOWERING", "CLINIC"].includes(service.type) || types.has(service.type) || !label(service.name) ||
        !Array.isArray(service.options) || service.options.length > 100) fail();
      types.add(service.type); const keys = new Set();
      return { type: service.type, name: service.name, options: service.options.map(option => {
        if (typeof option.key !== "string" || !option.key.trim() || option.key !== option.key.trim() || option.key.length > 128 ||
          option.key.includes("\u0000") || keys.has(option.key) || !label(option.name) || option.currency !== "EGP" ||
          typeof option.price !== "number" || !Number.isFinite(option.price) || option.price < 0 || !Number.isSafeInteger(Math.round(option.price * 100))) fail();
        keys.add(option.key); return { key: option.key, name: option.name, price: option.price, currency: "EGP" };
      }) };
    });
    locations = value.locations.map(location => {
      if (!id(location.id) || branchIds.has(location.id.toLowerCase()) || !label(location.name) ||
        !/^alexandria$/i.test(location.city ?? "") || !label(location.slug) || location.timezone !== "Africa/Cairo") fail();
      branchIds.add(location.id.toLowerCase());
      return { id: location.id, name: location.name, city: location.city, slug: location.slug, timezone: location.timezone };
    });
    if ((value.status === "ready") !== Boolean(services.some(service => service.options.length) && locations.length)) fail();
  }
  const reason = value.status === "ineligible" ? "booking_region_unavailable" : value.status === "needs_location" ? "booking_location_required" : null;
  if (value.status === "ineligible" && (value.eligible !== false || value.reason !== reason)) fail();
  const snapshot = { status: value.status, reason, generatedAt, dataMode: "catalog_snapshot", estimateOnly: true,
    slotReserved: false, requiresRefreshBeforeConfirmation: true, requiresExplicitConfirmation: true,
    services, locations, action: value.status === "ready" && actionsAllowed ? { type: "review_booking_options", requiresFreshLocation: true } : null };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > BOOKING_CARD_MAX_BYTES) fail();
  return snapshot;
}
export function storedBookingDto(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > BOOKING_CARD_MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value.generatedAt !== "string" || value.dataMode !== "catalog_snapshot" || value.estimateOnly !== true || value.slotReserved !== false ||
      value.requiresRefreshBeforeConfirmation !== true || value.requiresExplicitConfirmation !== true ||
      value.action !== null && (value.action?.type !== "review_booking_options" || value.action.requiresFreshLocation !== true)) return null;
    return buildBookingSnapshot({ ...value, eligible: ["ready", "empty"].includes(value.status), governorateCode: "alexandria" },
      { actionsAllowed: value.action !== null, generatedAt: value.generatedAt });
  } catch { return null; }
}
export function renderBookingResponse(snapshot, language) {
  const ar = language === "ar";
  if (snapshot.status === "needs_location") return ar ? "اختار منطقتك الحالية في التطبيق الأول عشان أقدر أراجع خدمات بيتيارد. الحجز متاح في إسكندرية بس دلوقتي." : "Select your current area in the app so I can check Petyard services. Booking is currently available only in Alexandria.";
  if (snapshot.status === "ineligible") return ar ? "خدمات الحجز متاحة في إسكندرية بس دلوقتي، ومش متاحة في منطقتك الحالية." : "Booking services are currently available only in Alexandria and are unavailable in your current area.";
  if (snapshot.status === "unavailable") return ar ? "مش قادر أراجع الخدمات دلوقتي. جرّب تاني أو راجع الحجز من التطبيق؛ لسه مفيش حجز اتعمل." : "I can't check services right now. Try again or review booking in the app; no booking has been made.";
  if (snapshot.status === "empty") return ar ? "مفيش خدمات وفروع متاحة للاختيار دلوقتي. جرّب تراجع الحجز من التطبيق بعدين." : "There are no services and branches available to choose from right now. Check booking in the app again later.";
  return ar ? "دي خدمات بيتيارد وفروع إسكندرية من الكتالوج. اختار الخدمة والفرع والميعاد والحيوان، وبعدها راجع التفاصيل والأسعار قبل ما تأكد بنفسك. عرض الخدمات مش تأكيد لتوافر ميعاد ولسه مفيش حجز اتعمل." : "These are Petyard's catalog services and Alexandria branches. Select the service, branch, time and pet, then review the details and prices before confirming yourself. This list does not confirm appointment availability; no booking has been made.";
}
