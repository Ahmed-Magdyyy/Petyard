import assert from "node:assert/strict";
import test from "node:test";
import { bookingSelectionSchema, bookingSelectionIntent, advanceBookingSelection } from "../../../src/domains/assistant/customer/assistant.booking-selection.js";
import { buildBookingSnapshot } from "../../../src/domains/assistant/customer/assistant.booking-cards.js";
import { validateSchema, validateObject } from "../../../src/domains/assistant/providers/providerContract.js";

const branch = "abcdef123456789012345678", otherBranch = "111111111111111111111111";
const binding = "a".repeat(64), generatedAt = "2026-10-22T10:00:00.000Z";
const service = (serviceType = "GROOMING", serviceOptionKey = "haircut") => ({ serviceType, serviceOptionKey });
const intent = (changes = {}) => ({ action: "none", services: [], locationId: "", date: "", hour24: null, sourceQuote: "", ...changes });
const update = (changes = {}) => intent({ action: "update", services: [service()], sourceQuote: "grooming", ...changes });
const catalog = () => buildBookingSnapshot({ status: "ready", eligible: true, governorateCode: "alexandria", estimateOnly: true,
  services: ["GROOMING", "SHOWERING", "CLINIC"].map(type => ({ type, name: type, options: [
    { key: type === "GROOMING" ? "haircut" : "standard", name: "Example option", price: 75, currency: "EGP" },
  ] })), locations: [{ id: branch, name: "Example branch", city: "Alexandria", slug: "example", timezone: "Africa/Cairo" }] },
{ actionsAllowed: true, generatedAt });
const advance = (changes = {}) => advanceBookingSelection({ intent: intent(), latestInput: "grooming", catalog: catalog(), binding, ...changes });
const full = () => advance({ intent: update({ locationId: branch, date: "2026-10-25", hour24: 16 }) });
const invalid = (value, latestInput = "grooming") => assert.throws(() => bookingSelectionIntent(value, latestInput), { code: "invalid_booking_selection", status: 503 });

test("internal schema uses the existing supported subset and does not add a confirmation action", () => {
  validateSchema(bookingSelectionSchema); validateObject(bookingSelectionSchema, intent());
  const composed = { type: "object", additionalProperties: false, properties: { booking: bookingSelectionSchema }, required: ["booking"] };
  validateSchema(composed); validateObject(composed, { booking: update() });
  for (const action of ["confirm", "book", "cancel", "read", "add_to_cart"]) invalid(intent({ action }));
});
test("neutral intent leaves an empty draft and identifies each required choice", () => {
  const result = advance();
  assert.equal(result.status, "collecting"); assert.deepEqual(result.missing, ["services", "locationId", "date", "hour24"]);
  assert.deepEqual(result.unavailable, []); assert.equal(result.previewSelection, null); assert.equal(result.discardedPrevious, false);
  assert.equal(result.catalogGeneratedAt, generatedAt); assert.equal(result.timezone, "Africa/Cairo");
  assert.equal(result.estimateOnly, true); assert.equal(result.slotReserved, false);
  assert.equal(result.requiresRefreshBeforeConfirmation, true); assert.equal(result.requiresExplicitConfirmation, true);
});
test("successive partial choices carry only fields bound to the same caller context", () => {
  const first = advance({ intent: update() });
  assert.deepEqual(first.state.selection.services, [service()]); assert.equal(first.previewSelection, null);
  const second = advance({ previous: first.state, intent: update({ services: [], locationId: branch.toUpperCase(), sourceQuote: "this branch" }), latestInput: "Use this branch" });
  assert.equal(second.state.selection.locationId, branch);
  const third = advance({ previous: second.state, intent: update({ services: [], date: "2026-10-25", hour24: 16, sourceQuote: "25 October at 4 pm" }), latestInput: "25 October at 4 pm please" });
  assert.equal(third.status, "selection_complete"); assert.deepEqual(third.missing, []); assert.deepEqual(third.unavailable, []);
  assert.deepEqual(third.previewSelection, { services: [service()], locationId: branch, date: "2026-10-25", hour24: 16 });
  assert.deepEqual(advance({ previous: third.state }).state, third.state);
});
test("service updates replace the complete ordered list without silently appending or deduplicating", () => {
  const services = [service("CLINIC", "standard"), service("SHOWERING", "standard"), service("CLINIC", "standard")];
  const result = advance({ previous: full().state, intent: update({ services, sourceQuote: "clinic and shower then clinic" }), latestInput: "clinic and shower then clinic" });
  assert.equal(result.status, "selection_complete"); assert.deepEqual(result.previewSelection.services, services);
  assert.deepEqual(advance({ previous: result.state, intent: update() }).previewSelection.services, [service()]);
});
test("reset clears every choice and never supplies a preview or cancellation action", () => {
  const result = advance({ previous: full().state, intent: intent({ action: "reset", sourceQuote: "start again" }), latestInput: "Please start again" });
  assert.equal(result.status, "collecting"); assert.equal(result.previewSelection, null);
  assert.deepEqual(result.state.selection, { services: [], locationId: null, date: null, hour24: null });
  assert.equal(Object.hasOwn(result, "action"), false);
});
test("missing option keys remain missing even when the catalog has only one option", () => {
  const result = advance({ intent: update({ services: [service("GROOMING", "")], locationId: branch, date: "2026-10-25", hour24: 16 }) });
  assert.equal(result.status, "collecting"); assert.deepEqual(result.missing, ["services[0].serviceOptionKey"]);
  assert.equal(result.state.selection.services[0].serviceOptionKey, ""); assert.equal(result.previewSelection, null);
});
test("removed branch, service or option blocks old and newly proposed choices", () => {
  for (const mode of ["branch", "service", "option", "foreign_option"]) {
    const current = catalog(); let proposed = intent();
    if (mode === "branch") current.locations[0].id = otherBranch;
    if (mode === "service") current.services.shift();
    if (mode === "option") current.services[0].options[0].key = "new-key";
    if (mode === "foreign_option") proposed = update({ services: [service("GROOMING", "standard")] });
    const result = advance({ catalog: current, previous: full().state, intent: proposed });
    assert.equal(result.status, "choice_unavailable", mode); assert.equal(result.previewSelection, null);
    assert.deepEqual(result.unavailable, [mode === "branch" ? "locationId" : mode === "service" ? "services[0].serviceType" : "services[0].serviceOptionKey"]);
    assert.equal(result.state.selection.services.length, 1);
  }
});
test("unresolved or ineligible area and catalog failure clear prior choices instead of reviving them", () => {
  for (const status of ["needs_location", "ineligible", "unavailable"]) {
    const current = buildBookingSnapshot({ status, ...(status === "ineligible" ? { eligible: false, reason: "booking_region_unavailable" } : {}) }, { generatedAt });
    const result = advance({ previous: full().state, catalog: current, intent: update() });
    assert.equal(result.status, status); assert.equal(result.previewSelection, null); assert.equal(result.state.selection.locationId, null);
    assert.deepEqual(result.state.selection.services, []);
    assert.equal(advance({ previous: result.state }).status, "collecting");
  }
});
test("an empty catalog blocks selected choices and never labels them complete", () => {
  const current = buildBookingSnapshot({ status: "empty", eligible: true, governorateCode: "alexandria", estimateOnly: true, services: [], locations: [] }, { generatedAt });
  const result = advance({ previous: full().state, catalog: current });
  assert.equal(result.status, "choice_unavailable"); assert.equal(result.previewSelection, null);
  assert.deepEqual(result.unavailable, ["services[0].serviceType", "locationId"]);
});
test("changed binding discards a previous draft while retaining only explicitly supplied new fields", () => {
  const result = advance({ previous: full().state, binding: "b".repeat(64), intent: update({ services: [], hour24: 18, sourceQuote: "6 pm" }), latestInput: "6 pm" });
  assert.equal(result.discardedPrevious, true); assert.equal(result.status, "collecting");
  assert.deepEqual(result.state.selection, { services: [], locationId: null, date: null, hour24: 18 });
  for (const binding of [null, "", "a".repeat(63), "g".repeat(64), "A".repeat(64), {}]) assert.throws(() => advance({ binding }), { code: "invalid_booking_selection" });
});
test("corrupt previous state fails closed without resurrecting partially valid fields", () => {
  const changes = [row => { row.version = 2; }, row => { row.extra = true; }, row => { row.selection.extra = true; },
    row => { row.selection.date = "2026-02-30"; }, row => { row.selection.hour24 = "16"; },
    row => { row.selection.services = Array(1); }, row => { row.selection.services[0].serviceType = "BOARDING"; },
    row => { row.selection.locationId = branch.toUpperCase(); }, row => { row.selection = null; }];
  for (const mutate of changes) {
    const previous = structuredClone(full().state); mutate(previous);
    const result = advance({ previous }); assert.equal(result.discardedPrevious, true);
    assert.deepEqual(result.state.selection, { services: [], locationId: null, date: null, hour24: null });
  }
});
test("intent boundary rejects unknown, missing, malformed and oversized fields", () => {
  for (const value of [null, [], {}, { ...intent(), extra: true }, Object.fromEntries(Object.entries(intent()).filter(([key]) => key !== "date")),
    update({ services: Array(13).fill(service()) }), update({ services: Array(1) }), update({ services: [null] }),
    update({ services: [service("BOARDING")] }), update({ services: [{ ...service(), price: 1 }] }),
    update({ services: [service("GROOMING", " key")] }), update({ services: [service("GROOMING", "x".repeat(129))] }),
    update({ services: [service("GROOMING", "bad\u0000key")] }), update({ locationId: { $ne: null } }),
    update({ locationId: "unknown" }), update({ date: "2026-02-30" }), update({ date: "2025-02-29" }), update({ date: "25/10/2026" }),
    update({ date: "2026-10-25T10:00:00Z" }), update({ date: null }), update({ hour24: "16" }), update({ hour24: 16.5 }),
    update({ hour24: true }), update({ hour24: -1 }), update({ hour24: 24 }), update({ hour24: NaN }), update({ hour24: Infinity })]) invalid(value);
  const extraOnArray = [service()]; extraOnArray.extra = true; invalid(update({ services: extraOnArray }));
  const holeWithExtra = Array(1); holeWithExtra.extra = service(); invalid(update({ services: holeWithExtra }));
});
test("neutral/reset/update combinations cannot hide unwanted mutations or empty updates", () => {
  for (const fields of [{ services: [service()] }, { locationId: branch }, { date: "2026-10-25" }, { hour24: 0 }, { sourceQuote: "grooming" }]) invalid(intent(fields));
  for (const fields of [{ services: [service()] }, { locationId: branch }, { date: "2026-10-25" }, { hour24: 0 }]) invalid(intent({ action: "reset", sourceQuote: "grooming", ...fields }));
  invalid(intent({ action: "update", sourceQuote: "grooming" }));
});
test("only bounded exact latest-message evidence is accepted in its original script", () => {
  for (const input of ["grooming", "عايز أحجز حلاقة", "3ayez a7gez grooming"]) {
    const result = bookingSelectionIntent(update({ sourceQuote: input }), `Please ${input} now`); assert.equal(result.sourceQuote, input);
  }
  for (const sourceQuote of ["", " grooming", "grooming ", "GROOMING", "grooming\u0000", 5, null, "g".repeat(501)]) invalid(update({ sourceQuote }));
  invalid(update({ sourceQuote: "old message" }), "new message"); invalid(update(), null);
  const text = "x".repeat(500); assert.equal(bookingSelectionIntent(update({ sourceQuote: text }), text).sourceQuote, text);
});
test("valid leap dates, hours 0 and 23 and twelve ordered services are syntactically complete but not availability proof", () => {
  for (const hour24 of [0, 23]) {
    const services = Array.from({ length: 12 }, () => service());
    const result = advance({ intent: update({ services, date: "2024-02-29", hour24, locationId: branch }) });
    assert.equal(result.status, "selection_complete"); assert.equal(result.previewSelection.hour24, hour24);
    assert.equal(result.previewSelection.services.length, 12); assert.equal(result.slotReserved, false);
    assert.equal(Object.hasOwn(result.previewSelection, "petId"), false); assert.equal(Object.hasOwn(result.previewSelection, "price"), false);
  }
});
test("catalog snapshots must retain valid provenance flags, timestamps, size and safe geographic data", () => {
  const changed = [null, undefined, {}, [], { ...catalog(), generatedAt: undefined }, { ...catalog(), generatedAt: "bad" },
    { ...catalog(), dataMode: "live" }, { ...catalog(), slotReserved: true }, { ...catalog(), requiresExplicitConfirmation: false },
    { ...catalog(), action: { type: "confirm_booking" } }, { ...catalog(), extra: "x".repeat(65536) }];
  const outside = catalog(); outside.locations[0].city = "Cairo"; changed.push(outside);
  const boarding = catalog(); boarding.services[0].type = "BOARDING"; changed.push(boarding);
  const circular = catalog(); circular.self = circular; changed.push(circular);
  for (const value of changed) assert.throws(() => advance({ catalog: value }), { code: "invalid_booking_selection" });
});
test("reduction copies caller inputs and isolates its preview from private draft state", () => {
  const previous = full().state, request = update(), snapshot = catalog();
  const before = structuredClone({ previous, request, snapshot });
  const result = advance({ previous, intent: request, catalog: snapshot });
  assert.deepEqual({ previous, request, snapshot }, before);
  result.previewSelection.services[0].serviceOptionKey = "changed";
  assert.equal(result.state.selection.services[0].serviceOptionKey, "haircut");
  result.state.selection.services[0].serviceOptionKey = "changed-again";
  assert.deepEqual({ previous, request, snapshot }, before);
  assert.doesNotMatch(JSON.stringify(result), /sourceQuote|ownerName|ownerPhone|fingerprint|reservationId|confirmed|price/);
});
