import { reject } from "../shared/assistant.errors.js";
import { storedBookingDto } from "./assistant.booking-cards.js";
import { parseCairoDateOrThrow } from "../../serviceReservation/reservations/serviceReservation.utils.js";

const types = ["GROOMING", "SHOWERING", "CLINIC"];
const identifier = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const option = value => typeof value === "string" && value === value.trim() && value.length <= 128 && !value.includes("\u0000");
const exact = (value, keys) => value?.constructor === Object && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => reject("invalid_booking_selection", 503);
const empty = () => ({ services: [], locationId: null, date: null, hour24: null });

// Internal interpretation contract only; composing it into the provider schema does not grant a booking action.
export const bookingSelectionSchema = Object.freeze({ type: "object", additionalProperties: false, properties: {
  action: { type: "string", enum: ["none", "update", "reset"] },
  services: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, properties: {
    serviceType: { type: "string", enum: types }, serviceOptionKey: { type: "string" },
  }, required: ["serviceType", "serviceOptionKey"] } },
  locationId: { type: "string" }, date: { type: "string" },
  hour24: { type: ["integer", "null"], minimum: 0, maximum: 23 }, sourceQuote: { type: "string" },
}, required: ["action", "services", "locationId", "date", "hour24", "sourceQuote"] });

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return parseCairoDateOrThrow(value).toISODate() === value; } catch { return false; }
}
function validServices(value) {
  if (!Array.isArray(value) || value.length > 12 || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!Object.hasOwn(value, index) || !exact(item, ["serviceType", "serviceOptionKey"]) || !types.includes(item.serviceType) || !option(item.serviceOptionKey)) return false;
  }
  return true;
}

export function bookingSelectionIntent(value, latestInput) {
  if (!exact(value, bookingSelectionSchema.required) || !["none", "update", "reset"].includes(value.action) || !validServices(value.services) ||
    value.locationId !== "" && !identifier(value.locationId) || value.date !== "" && !validDate(value.date) ||
    value.hour24 !== null && (!Number.isInteger(value.hour24) || value.hour24 < 0 || value.hour24 > 23)) fail();
  const changed = value.services.length > 0 || value.locationId !== "" || value.date !== "" || value.hour24 !== null;
  if (value.action === "none" ? changed || value.sourceQuote !== "" :
    typeof value.sourceQuote !== "string" || !value.sourceQuote.trim() || value.sourceQuote !== value.sourceQuote.trim() ||
    value.sourceQuote.length > 500 || value.sourceQuote.includes("\u0000") || typeof latestInput !== "string" || !latestInput.includes(value.sourceQuote) ||
    (value.action === "reset" ? changed : !changed)) fail();
  return { action: value.action, services: value.services.map(item => ({ ...item })), locationId: value.locationId.toLowerCase(),
    date: value.date, hour24: value.hour24, sourceQuote: value.sourceQuote };
}

function priorSelection(previous, binding) {
  const selection = previous?.selection;
  if (!exact(previous, ["version", "binding", "selection"]) || previous.version !== 1 || previous.binding !== binding ||
    !exact(selection, ["services", "locationId", "date", "hour24"]) || !validServices(selection.services) ||
    selection.locationId !== null && (!identifier(selection.locationId) || selection.locationId !== selection.locationId.toLowerCase()) ||
    selection.date !== null && !validDate(selection.date) ||
    selection.hour24 !== null && (!Number.isInteger(selection.hour24) || selection.hour24 < 0 || selection.hour24 > 23)) return null;
  return { services: selection.services.map(item => ({ ...item })), locationId: selection.locationId, date: selection.date, hour24: selection.hour24 };
}

// Pure draft reduction. The caller must authorize and bind owned context before using either input or result.
export function advanceBookingSelection({ intent: rawIntent, latestInput, catalog, binding, previous = null }) {
  if (typeof binding !== "string" || !/^[a-f\d]{64}$/.test(binding)) fail();
  const intent = bookingSelectionIntent(rawIntent, latestInput);
  let snapshot;
  try { snapshot = storedBookingDto(JSON.stringify(catalog)); } catch { fail(); }
  if (!snapshot) fail();
  const retained = priorSelection(previous, binding);
  let selection = intent.action === "reset" ? empty() : retained ?? empty();
  if (intent.action === "update") {
    // A nonempty services list replaces the whole ordered list; never append or silently drop a requested service.
    if (intent.services.length) selection.services = intent.services;
    if (intent.locationId) selection.locationId = intent.locationId;
    if (intent.date) selection.date = intent.date;
    if (intent.hour24 !== null) selection.hour24 = intent.hour24;
  }
  // Missing/foreign geography or a failed catalog read must not retain executable choices for a later retry.
  if (!["ready", "empty"].includes(snapshot.status)) selection = empty();
  const missing = [], unavailable = [];
  if (!selection.services.length) missing.push("services");
  for (const [index, item] of selection.services.entries()) {
    const definition = snapshot.services.find(service => service.type === item.serviceType);
    if (!definition) unavailable.push(`services[${index}].serviceType`);
    else if (!item.serviceOptionKey) missing.push(`services[${index}].serviceOptionKey`);
    else if (!definition.options.some(candidate => candidate.key === item.serviceOptionKey)) unavailable.push(`services[${index}].serviceOptionKey`);
  }
  if (!selection.locationId) missing.push("locationId");
  else if (!snapshot.locations.some(location => location.id.toLowerCase() === selection.locationId)) unavailable.push("locationId");
  if (!selection.date) missing.push("date");
  if (selection.hour24 === null) missing.push("hour24");
  const status = !["ready", "empty"].includes(snapshot.status) ? snapshot.status : unavailable.length ? "choice_unavailable" : missing.length ? "collecting" : "selection_complete";
  return { state: { version: 1, binding, selection }, status, missing, unavailable,
    discardedPrevious: previous !== null && retained === null, catalogGeneratedAt: snapshot.generatedAt,
    timezone: "Africa/Cairo", estimateOnly: true, slotReserved: false, requiresRefreshBeforeConfirmation: true,
    requiresExplicitConfirmation: true,
    // Completion means fields only: owned pet/contact details, date window, working hours and capacity still need the existing preview.
    previewSelection: status === "selection_complete" ? structuredClone(selection) : null };
}
