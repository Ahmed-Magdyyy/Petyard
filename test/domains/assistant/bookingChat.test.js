import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { structuredReply, knownUsage, testConfig } from "./fixtures/foundationPolicy.js";
import { prepareBookingOptions, finishRun, processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { buildBookingSnapshot, storedBookingDto, renderBookingResponse, BOOKING_CARD_MAX_BYTES } from "../../../src/domains/assistant/customer/assistant.booking-cards.js";
import { AssistantBudget, AssistantMessage, AssistantRun, AssistantAccount } from "../../../src/domains/assistant/shared/assistant.models.js";
import { messageDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { getHistory, getRun, submitMessage } from "../../../src/domains/assistant/customer/assistant.service.js";
import { validateResult } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { submission } from "../../../src/domains/assistant/shared/assistant.validation.js";
import { bookingContextInput } from "../../../src/domains/assistant/customer/assistant.booking-context.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { ServiceCatalogModel } from "../../../src/domains/serviceReservation/catalog/serviceCatalog.model.js";
import { ServiceLocationModel } from "../../../src/domains/serviceReservation/locations/serviceLocation.model.js";
import { readChatBookingOptions } from "../../../src/domains/assistant/customer/assistant.booking-discovery.js";

const B = "111111111111111111111111";
const body = { location: { governorateCode: "alexandria", areaCode: "smouha" } };
const options = () => ({ eligible: true, governorateCode: "alexandria", reason: null, estimateOnly: true,
  services: ["GROOMING", "SHOWERING", "CLINIC"].map(type => ({ type, name: type, options: [{ key: "option", name: "Example option", price: 75, currency: "EGP" }] })),
  locations: [{ id: B, name: "Example branch", city: "Alexandria", slug: "example", timezone: "Africa/Cairo" }] });
const response = (changes = {}) => ({ structured: structuredReply({ scope: "petyard", bookingOptions: "read", reply: "INVENTED booking confirmed", ...changes }),
  finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage });
function fixture(t, input = "Show grooming services") {
  const s = customerChatFixture(t, input);
  s.config = { ...s.config, bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true };
  s.run.config = s.config; s.run.bookingContext = structuredClone(body); s.run.generation = 0; s.prepared.run = { ...s.run };
  s.prepare = (answer = response(), readBookingOptions = async () => options()) => prepareBookingOptions(s.prepared, answer, s.config, { readBookingOptions });
  s.complete = (answer, bookingBatch, currentConfig = s.config) => finishRun(s.prepared, answer, null, { currentConfig, bookingBatch });
  return s;
}
test("English, Arabic and Arabizi scripted intent publishes backend-only catalog cards with no booking writes", async t => {
  for (const [input, language] of [["Show grooming services", "en"], ["عايز أحجز كشف", "ar"], ["3ayez a7gez grooming", "ar"]]) await t.test(input, async t => {
    const s = fixture(t, input), answer = response({ replyLanguage: language }); let reads = 0;
    const batch = await s.prepare(answer, async (owner, request, config) => {
      reads++; assert.equal(String(owner), String(s.run.owner)); assert.equal(config, s.config);
      assert.deepEqual(request, { location: body.location, language });
      return { ...options(), owner: "PRIVATE", address: "PRIVATE" };
    });
    assert.equal(s.messages.length, 0); assert.equal(s.budgetUpdates.length, 0);
    await s.complete(answer, batch); assert.equal(s.run.status, "completed"); assert.equal(reads, 1);
    const dto = messageDto(s.messages[0]); assert.equal(dto.booking.status, "ready"); assert.equal(dto.booking.action.type, "review_booking_options");
    assert.equal(dto.booking.slotReserved, false); assert.equal(dto.booking.requiresExplicitConfirmation, true);
    assert.equal(dto.booking.services.length, 3); assert.equal(dto.booking.locations[0].id, B);
    assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|INVENTED|bookingContext|bookingJson|sourceQuote/);
    assert.match(dto.text, language === "ar" ? /لسه مفيش حجز/ : /no booking has been made/);
    assert.equal(s.budgetUpdates.length, 2); assert.equal(s.unlocked, 1);
    assert.equal(await s.complete(answer, batch), null); assert.equal(s.messages.length, 1);
  });
});
test("missing context/location avoids resolver reads and outside Alexandria shows no offered choices", async t => {
  for (const mode of ["missing", "null", "outside", "unresolved", "empty"]) await t.test(mode, async t => {
    const s = fixture(t), answer = response();
    if (mode === "missing") delete s.run.bookingContext;
    if (mode === "null") s.run.bookingContext = { location: null };
    s.prepared.run = { ...s.run };
    const batch = await s.prepare(answer, async () => {
      if (["missing", "null"].includes(mode)) assert.fail("No location must not be guessed from a warehouse or message");
      return mode === "outside" || mode === "unresolved" ? { eligible: false, reason: mode === "outside" ? "booking_region_unavailable" : "booking_location_required", governorateCode: null, services: [], locations: [] }
        : { ...options(), locations: [] };
    });
    await s.complete(answer, batch); const card = messageDto(s.messages[0]).booking;
    assert.equal(card.status, mode === "outside" ? "ineligible" : mode === "empty" ? "empty" : "needs_location");
    assert.equal(card.action, null); if (mode !== "empty") assert.deepEqual(card.services, []);
  });
});
test("production booking reader resolves manual area, applies catalog/branch filters and its separate admission", async t => {
  const s = fixture(t), answer = response(), query = read => ({ select() { return this; }, sort() { return this; }, limit() { return this; },
    maxTimeMS() { return this; }, session() { return this; }, async lean() { return read(); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(AssistantAccount, "updateOne", async (_filter, update) => {
    if (update.$set) Object.assign(s.account, update.$set); return { matchedCount: 1, modifiedCount: 1 };
  });
  const warehouse = { _id: B, governorate: "alexandria", code: "ALEXO03", active: true, fulfillment: { status: "OPERATIONAL" } };
  t.mock.method(WarehouseModel, "findOne", () => query(() => warehouse));
  t.mock.method(WarehouseModel, "findById", () => query(() => warehouse));
  let reads = 0;
  mongoose.connection.db.collection = name => ({ find(filter, selection) {
    assert.equal(selection.maxTimeMS, 5000);
    if (name === ServiceCatalogModel.collection.name) {
      reads++; assert.equal(selection.limit, 4); assert.deepEqual(filter, { isActive: true, type: { $in: ["GROOMING", "SHOWERING", "CLINIC"] } });
      return { async toArray() { return [{ type: "CLINIC", name_en: "Clinic", name_ar: "عيادة", options: [{ key: "checkup", name_en: "Checkup", name_ar: "كشف", price: 75 }] }]; } };
    }
    assert.equal(name, ServiceLocationModel.collection.name); assert.equal(selection.limit, 51);
    assert.equal(filter.active, true); assert.ok(filter.city.test("Alexandria")); assert.equal(filter.city.test("Cairo"), false);
    return { async toArray() { return [{ _id: B, name_en: "Alex branch", name_ar: "فرع إسكندرية", city: "Alexandria", slug: "alex", timezone: "Africa/Cairo" }]; } };
  } });
  const batch = await prepareBookingOptions(s.prepared, answer, s.config);
  assert.equal(batch.snapshot.status, "ready"); assert.equal(reads, 1); assert.equal(s.account.bookingReadRateCount, 1);
  s.run.bookingContext = { location: { governorateCode: "cairo", areaCode: "maadi" } }; s.prepared.run = { ...s.run };
  const outside = await prepareBookingOptions(s.prepared, answer, s.config);
  assert.equal(outside.snapshot.status, "ineligible"); assert.equal(reads, 1); assert.equal(s.account.bookingReadRateCount, 2);
});
test("disabled and unsafe usage/scope/subject/warning decisions never read service data", async t => {
  for (const mode of ["disabled", "usage", "tier", "urgent", "health", "identity", "off_topic", "clarify", "switch", "warning"]) await t.test(mode, async t => {
    const s = fixture(t), answer = response();
    if (mode === "disabled") { s.config.bookingReadsEnabled = false; }
    if (mode === "usage") answer.usage = null; if (mode === "tier") answer.serviceTier = "unverified";
    if (["urgent", "health", "identity", "off_topic"].includes(mode)) answer.structured.scope = mode;
    if (mode === "clarify") answer.structured.subjectAction = "clarify";
    if (mode === "switch") answer.structured.subjectAction = "create_unsaved";
    if (mode === "warning") answer.structured.dietaryWarningAction = "clarify";
    const prepare = () => s.prepare(answer, () => assert.fail("Unsafe decision cannot read bookings"));
    if (mode === "disabled") await assert.rejects(prepare(), { code: "booking_options_unavailable" }); else assert.equal(await prepare(), null);
    if (["urgent", "health", "identity", "off_topic", "clarify", "warning"].includes(mode)) {
      await s.complete(answer, null); assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).booking, undefined);
    }
  });
});
test("mixed product/checkout/booking intent cannot authorize competing reads", () => {
  const answer = response({ checkoutSummary: "read" }), s = { config: {}, run: {} };
  assert.throws(() => validateResult(answer, s.run, { maxOutputChars: 4000 }, [], { allowCheckoutSummary: true, allowBookingOptions: true }), { code: "booking_options_unavailable" });
  answer.structured.checkoutSummary = "none";
  answer.structured.productSearch = { action: "general", query: "toys", minimumPackageWeightGrams: null, maximumPriceMinor: null, sourceQuote: "", options: [] };
  assert.throws(() => validateResult(answer, {}, { maxOutputChars: 4000 }, [], { allowProductSearch: true, allowBookingOptions: true }), { code: "booking_options_unavailable" });
});
test("current access, pet, source and location/batch binding are rechecked before publication", async t => {
  for (const mode of ["source", "blocked", "profile", "location", "batch", "source_after", "gate_off", "actions_off"]) await t.test(mode, async t => {
    const s = fixture(t), answer = response();
    if (mode === "source") s.source.text = "changed";
    const work = () => s.prepare(answer, async () => {
      if (mode === "blocked") s.account.blocked = true; if (mode === "profile") s.pet.name = "changed"; return options();
    });
    if (["source", "blocked", "profile"].includes(mode)) await assert.rejects(work(), { code: mode === "blocked" ? "ai_restricted" : "context_changed" });
    else {
      const batch = await work();
      if (mode === "location") s.run.bookingContext = { location: { governorateCode: "cairo" } };
      if (mode === "batch") batch.binding = "forged";
      if (mode === "source_after") s.source.text = "changed";
      await s.complete(answer, batch, { ...s.config, ...(mode === "gate_off" ? { bookingReadsEnabled: false } : {}),
        ...(mode === "actions_off" ? { bookingActionsEnabled: false } : {}) });
      if (mode === "actions_off") { assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).booking.action, null); }
      else { assert.equal(s.run.status, "failed"); assert.equal(s.messages.length, 0); }
    }
  });
});
test("read failures, malformed or foreign catalog and timeout become safe unavailable cards with no late result", async t => {
  for (const mode of ["failure", "boarding", "foreign_branch", "price", "timeout"]) await t.test(mode, async t => {
    const s = fixture(t), answer = response(); s.config = { ...s.config, timeoutMs: 20 }; s.run.config = s.config; s.prepared.run.config = s.config; let release;
    const batch = await s.prepare(answer, async () => {
      if (mode === "failure") throw new Error("PRIVATE database details");
      const value = options();
      if (mode === "boarding") value.services[0].type = "BOARDING";
      if (mode === "foreign_branch") value.locations[0].city = "Cairo";
      if (mode === "price") value.services[0].options[0].price = -1;
      if (mode === "timeout") return new Promise(resolve => { release = resolve; }); return value;
    });
    await s.complete(answer, batch); assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).booking.status, "unavailable");
    assert.equal(messageDto(s.messages[0]).booking.action, null); assert.doesNotMatch(JSON.stringify(messageDto(s.messages[0])), /PRIVATE|INVENTED/);
    if (release) { release(options()); await new Promise(resolve => setImmediate(resolve)); assert.equal(s.messages.length, 1); }
  });
});
test("cards strip private fields, reject corrupt historical snapshots, and never appear on user messages", () => {
  const snapshot = buildBookingSnapshot({ ...options(), status: "ready", phone: "PRIVATE" }, { actionsAllowed: true });
  assert.deepEqual(storedBookingDto(JSON.stringify(snapshot)), snapshot);
  for (const raw of ["{", "x".repeat(BOOKING_CARD_MAX_BYTES + 1), JSON.stringify({ ...snapshot, slotReserved: true }),
    JSON.stringify({ ...snapshot, locations: [{ ...snapshot.locations[0], city: "Cairo" }] }), JSON.stringify({ ...snapshot, generatedAt: null }),
    JSON.stringify({ ...snapshot, generatedAt: undefined }),
    JSON.stringify({ ...snapshot, action: { type: "confirm_booking" } })]) assert.equal(storedBookingDto(raw), null);
  assert.equal(messageDto({ _id: B, run: B, role: "user", bookingJson: JSON.stringify(snapshot) }).booking, undefined);
  assert.throws(() => buildBookingSnapshot({ ...options(), status: "ready", services: Array(4).fill(options().services[0]) }), { code: "invalid_booking_options" });
});
test("saved FE example uses the exact server card DTO and bilingual renderer", () => {
  const example = JSON.parse(readFileSync(new URL("./fixtures/contracts/assistant-booking-chat-example.json", import.meta.url), "utf8"));
  const message = example.historyMessage;
  assert.equal(message.text, renderBookingResponse(message.booking, "en"));
  assert.deepEqual(messageDto({ ...message, _id: message.id, run: message.runId, bookingJson: JSON.stringify(message.booking) }).booking, message.booking);
  assert.equal(example.arabiziMessageRequest.text, "3ayez a7gez grooming");
  const collection = JSON.parse(readFileSync(new URL("./fixtures/contracts/AssistantBookingChat.postman_collection.json", import.meta.url), "utf8"));
  assert.equal(collection.item.length, 2); assert.equal(collection.variable.find(value => value.key === "allowBookingChatRequests").value, "false");
});
test("context advertises discovery only with read gate and never sends raw app location to the provider", async t => {
  const s = fixture(t), request = await s.context(s.config);
  assert.match(request.instructions, /"bookingOptionsAvailable":true/); assert.doesNotMatch(JSON.stringify(request), /smouha|bookingContext|31\.234567/);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= s.config.maxContextBytes);
  assert.match((await s.context({ ...s.config, bookingReadsEnabled: false })).instructions, /"bookingOptionsAvailable":false/);
  const full = { ...testConfig({ productSearchEnabled: true, cartPolicy: { version: "synthetic", proposalSeconds: 60, rateMax: 5, rateWindowSeconds: 60 } }),
    cartEnabled: true, bookingReadsEnabled: true };
  s.run.catalogContext = { warehouseId: B, language: "en" };
  const size = Buffer.byteLength(JSON.stringify(await s.context({ ...full, maxContextBytes: 100000 })));
  assert.ok(size <= full.maxContextBytes, `All-feature context bytes: ${size}`);
  await s.context(full);
});
test("submission normalizes raw location without affecting legacy messages, and rejects forged evidence", () => {
  const config = { maxMessageChars: 1000 };
  assert.deepEqual(submission({ text: "hi" }, "message-key-1", config), { text: "hi", subjectId: undefined, key: "message-key-1" });
  assert.deepEqual(bookingContextInput({ location: { areaCode: "smouha", governorateCode: "alexandria" } }), body);
  assert.deepEqual(submission({ text: "hi", bookingContext: { location: null } }, "message-key-1", config).bookingContext, { location: null });
  for (const bookingContext of [null, {}, { location: [] }, { location: { lat: "31", lng: 29 } }, { location: { lat: 31 } },
    { location: { lat: 31, lng: 29, governorateCode: "alexandria" } }, { location: { governorateCode: "alexandria", prime: true } },
    { location: body.location, warehouseId: B }]) assert.throws(() => submission({ text: "hi", bookingContext }, "message-key-1", config));
});
test("the real worker uses one scripted provider result and one booking read, then replay skips both", async t => {
  const s = fixture(t);
  Object.assign(s.run, { status: "queued", attempts: [], accounting: "none", attempt: null, reservation: null, phase: "resolve", generation: 0,
    deadline: new Date(Date.now() + 60000), toObject() { return { ...this }; } });
  t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: false, billingTimezone: s.config.timezone, openingExposure: s.config.openingExposure }));
  let calls = 0, reads = 0;
  const opts = { getConfig: () => s.config, adapterFactory: () => ({ async generate() { calls++; return response(); } }),
    readBookingOptions: async () => { reads++; return options(); }, readProducts: () => assert.fail("No products"), readCheckout: () => assert.fail("No checkout") };
  assert.deepEqual(await processAssistantRun(s.run._id, opts), { status: "completed" });
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(s.run.accounting, "settled"); assert.equal(s.messages.length, 1);
  assert.deepEqual(await processAssistantRun(s.run._id, opts), { skipped: true }); assert.equal(calls, 1); assert.equal(reads, 1);
});
test("actual message admission retains normalized location and binds its retry identity", async t => {
  const s = fixture(t); s.account.activeRun = null; s.account.save = async () => {};
  const runs = [];
  t.mock.method(AssistantRun, "findOne", filter => ({ session() { return this; }, async then(resolve, reject) {
    try { return resolve(runs.find(run => matchesQuery(run, filter)) ?? null); } catch (error) { return reject(error); }
  } }));
  t.mock.method(AssistantRun, "create", async ([record]) => {
    const run = new AssistantRun(record); assert.equal(run.validateSync(), undefined); runs.push(run.toObject()); return [run];
  });
  const first = await submitMessage(s.run.owner, { text: "grooming", bookingContext: body }, "booking-message-1", s.config);
  assert.equal(first.duplicate, false); assert.deepEqual(runs[0].bookingContext, body);
  assert.equal((await submitMessage(s.run.owner, { text: "grooming", bookingContext: {
    location: { areaCode: "smouha", governorateCode: "alexandria" } } }, "booking-message-1", s.config)).duplicate, true);
  await assert.rejects(submitMessage(s.run.owner, { text: "grooming", bookingContext: { location: { governorateCode: "cairo" } } },
    "booking-message-1", s.config), { code: "idempotency_conflict" });
  assert.equal(runs.length, 1); assert.equal(s.account.dayMessages, 1);
});
test("owned polling/history return saved service card without re-reading and hide expired/foreign rows", async t => {
  const s = fixture(t), answer = response(); await s.complete(answer, await s.prepare(answer));
  t.mock.method(AssistantMessage, "findOne", filter => ({ session() { return this; }, async lean() {
    return s.messages.find(message => matchesQuery(message, filter)) ?? null;
  } }));
  const polled = await getRun(s.run.owner, String(s.run._id), s.config); assert.equal(polled.message.booking.status, "ready");
  t.mock.method(AssistantMessage, "find", filter => ({ sort() { return this; }, limit() { return this; }, session() { return this; },
    async lean() { return s.messages.filter(message => matchesQuery(message, filter)); } }));
  assert.equal((await getHistory(s.run.owner, {}, s.config)).messages[0].booking.status, "ready");
  s.messages[0].expiresAt = new Date(0); assert.equal((await getRun(s.run.owner, String(s.run._id), s.config)).message, null);
});
