import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import http from "node:http";
import { readFileSync } from "node:fs";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { knownUsage, structuredReply, testConfig } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { beginAttempt } from "../../../src/domains/assistant/shared/assistant.attempts.js";
import { AssistantMessage, AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { prepareBookingOptions, finishRun, processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { loadBookingSelection, selectionCard, renderBookingSelection } from "../../../src/domains/assistant/customer/assistant.booking-selection-chat.js";
import { validateResult, outputSchema } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { messageDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { buildContext } from "../../../src/domains/assistant/customer/assistant.context.js";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";

const B = "111111111111111111111111";
const rawLocation = { location: { governorateCode: "alexandria", areaCode: "smouha" } };
const selection = changes => ({ action: "none", services: [], locationId: "", date: "", hour24: null, sourceQuote: "", ...changes });
const options = () => ({ eligible: true, governorateCode: "alexandria", reason: null, estimateOnly: true,
  services: ["GROOMING", "SHOWERING", "CLINIC"].map(type => ({ type, name: type, options: [{ key: "standard", name: "Standard", price: 75, currency: "EGP" }] })),
  locations: [{ id: B, name: "Alex branch", city: "Alexandria", slug: "alex", timezone: "Africa/Cairo" }] });
const response = (bookingOptions = selection({ action: "read" }), extras = {}) => ({ structured: structuredReply({ scope: "petyard", reply: "INVENTED confirmed!", bookingOptions, ...extras }),
  finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage });

function fixture(t, input = "Show grooming") {
  const s = customerChatFixture(t, input);
  s.config = { ...s.config, bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true };
  s.run.config = s.config; s.run.bookingContext = structuredClone(rawLocation); s.prepared.run = { ...s.run };
  const query = read => ({ sort() { return this; }, session() { return this; }, maxTimeMS() { return this; }, async lean() { return read(); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(AssistantMessage, "findOne", filter => query(() => [s.source, ...s.messages].filter(row => row && matchesQuery(row, filter))
    .sort((a, b) => b.sequence - a.sequence)[0] ?? null));
  t.mock.method(AssistantMessage, "create", async ([record]) => {
    const message = { ...record, _id: new mongoose.Types.ObjectId(), createdAt: new Date() };
    const doc = new AssistantMessage(message); assert.equal(doc.validateSync(), undefined);
    s.messages.push(message); return [message];
  });
  s.next = input => {
    Object.assign(s.run, { _id: new mongoose.Types.ObjectId(), input, status: "dispatching", accounting: "none", attempts: [],
      userSequence: s.chat.nextSequence + 1, createdAt: new Date(), responseMessage: null, publicCode: null });
    s.chat.nextSequence = s.run.userSequence; s.account.activeRun = s.run._id;
    s.source = { ...s.source, _id: new mongoose.Types.ObjectId(), run: s.run._id, text: input, sequence: s.run.userSequence,
      subjectId: s.run.subjectId, expiresAt: new Date(Date.now() + 60000) };
    beginAttempt(s.run, { amount: 1000, budgetIds: ["test-month", "test-day"] });
    s.prepared = { ...s.prepared, run: { ...s.run } }; delete s.prepared.bookingPrevious;
  };
  s.complete = async (answer = response(), readBookingOptions = async () => options(), config = s.config) => {
    const bookingBatch = await prepareBookingOptions(s.prepared, answer, s.config, { readBookingOptions });
    await finishRun(s.prepared, answer, null, { bookingBatch, currentConfig: config });
    return messageDto(s.messages.at(-1));
  };
  return s;
}
const fullIntent = input => selection({ action: "update", services: [{ serviceType: "GROOMING", serviceOptionKey: "standard" }],
  locationId: B, date: "2026-10-25", hour24: 16, sourceQuote: input });

test("English, Arabic and Arabizi scripted choices publish only backend selection cards, never confirmations", async t => {
  for (const [input, language] of [["Grooming at Alex branch on 25 October 2026 at 4 pm", "en"],
    ["حلاقة في فرع إسكندرية يوم 25 أكتوبر 2026 الساعة 4 مساء", "ar"], ["grooming fi far3 alex 25 October 2026 el sa3a 4 pm", "ar"]]) await t.test(language, async t => {
    const s = fixture(t, input), dto = await s.complete(response(fullIntent(input), { replyLanguage: language }));
    assert.equal(s.run.status, "completed"); assert.equal(dto.bookingSelection.status, "selection_complete");
    assert.equal(dto.bookingSelection.selection.petId, String(s.pet._id));
    assert.equal(dto.bookingSelection.action.type, "review_booking_selection"); assert.equal(dto.bookingSelection.action.booking.hour24, 16);
    assert.equal(dto.bookingSelection.slotReserved, false); assert.equal(dto.bookingSelection.requiresPetAndContactReview, true);
    assert.match(dto.text, language === "ar" ? /لسه مفيش ميعاد اتحجز/ : /No appointment is reserved/);
    assert.doesNotMatch(JSON.stringify(dto), /INVENTED|binding|bookingSelectionJson|sourceQuote|ownerPhone|fingerprint/);
  });
});
test("discovery, service, branch and time choices survive multiple distinct runs in order", async t => {
  const s = fixture(t); assert.equal((await s.complete()).bookingSelection.status, "collecting");
  s.next("grooming standard");
  let dto = await s.complete(response(selection({ action: "update", services: [{ serviceType: "GROOMING", serviceOptionKey: "standard" }], sourceQuote: s.run.input })));
  assert.deepEqual(dto.bookingSelection.missing, ["locationId", "date", "hour24"]);
  s.next("Alex branch");
  dto = await s.complete(response(selection({ action: "update", locationId: B, sourceQuote: s.run.input })));
  assert.deepEqual(dto.bookingSelection.missing, ["date", "hour24"]);
  s.next("25 October 2026 at 4 pm");
  const previous = await loadBookingSelection(s.run, s.chat, s.config); assert.equal(previous.state.selection.locationId, B);
  const request = await s.context(s.config); assert.match(request.instructions, /"bookingDraft"/); assert.match(request.instructions, /Alex branch/);
  assert.doesNotMatch(request.instructions, /smouha|"binding"|"price":75|bookingSelectionJson/);
  dto = await s.complete(response(selection({ action: "update", date: "2026-10-25", hour24: 16, sourceQuote: s.run.input })));
  assert.equal(dto.bookingSelection.status, "selection_complete"); assert.equal(s.messages.length, 4);
  assert.equal(dto.bookingSelection.action.booking.services[0].serviceOptionKey, "standard");
});
test("explicit reset clears all fields, while an ambiguous no-action reply leaves the previous draft unchanged", async t => {
  const s = fixture(t, "full choices"); await s.complete(response(fullIntent(s.run.input)));
  s.next("4 or 5?"); const before = await loadBookingSelection(s.run, s.chat, s.config);
  const clarify = response(selection(), { reply: "Do you mean 4 pm or 5 pm?" });
  await finishRun(s.prepared, clarify, null, { currentConfig: s.config });
  assert.equal(s.messages.at(-1).text, clarify.structured.reply); assert.equal(s.messages.at(-1).bookingSelectionJson, undefined);
  s.next("start again"); assert.deepEqual((await loadBookingSelection(s.run, s.chat, s.config)).state, before.state);
  const dto = await s.complete(response(selection({ action: "reset", sourceQuote: s.run.input })));
  assert.equal(dto.bookingSelection.status, "collecting"); assert.equal(dto.bookingSelection.action, null);
  assert.deepEqual(dto.bookingSelection.selection.services, []);
});
test("pet/profile, context version, location, configuration and history boundaries prevent draft reuse", async t => {
  for (const mode of ["profile", "subject", "context", "location", "configuration", "history_cutoff", "expiry", "foreign_owner", "corrupt", "disabled"]) await t.test(mode, async t => {
    const s = fixture(t, "full choices"); await s.complete(response(fullIntent(s.run.input))); s.next("at 6 pm");
    if (mode === "profile") s.run.subjectFingerprint = "b".repeat(64);
    if (mode === "subject") s.run.subjectId = "pet:" + B;
    if (mode === "context") s.run.contextVersion++;
    if (mode === "location") s.run.bookingContext = { location: { governorateCode: "cairo" } };
    if (mode === "configuration") s.run.config = { ...s.config, signature: "changed" };
    if (mode === "history_cutoff") s.chat.contextAfterSequence = s.messages[0].sequence;
    if (mode === "expiry") s.messages[0].expiresAt = new Date(0);
    if (mode === "foreign_owner") s.messages[0].owner = new mongoose.Types.ObjectId();
    if (mode === "corrupt") s.messages[0].bookingSelectionJson = "{";
    assert.equal(await loadBookingSelection(s.run, s.chat, mode === "disabled" ? { ...s.config, bookingReadsEnabled: false } : s.config), null);
  });
});
test("catalog removal and area failure never publish a review action or revive old choices", async t => {
  for (const mode of ["option", "branch", "outside", "failure"]) await t.test(mode, async t => {
    const s = fixture(t, "full choices"); await s.complete(response(fullIntent(s.run.input))); s.next("show my choices");
    const dto = await s.complete(response(), async () => {
      if (mode === "failure") throw new Error("PRIVATE");
      if (mode === "outside") return { eligible: false, reason: "booking_region_unavailable" };
      const value = options(); if (mode === "option") value.services[0].options[0].key = "replacement";
      if (mode === "branch") value.locations[0].id = "222222222222222222222222"; return value;
    });
    assert.equal(dto.bookingSelection.action, null); assert.equal(dto.bookingSelection.status, ["branch", "option"].includes(mode) ? "choice_unavailable" : mode === "outside" ? "ineligible" : "unavailable");
    if (["outside", "failure"].includes(mode)) assert.deepEqual(dto.bookingSelection.selection.services, []);
  });
});
test("publication binds exact interpretation and previous snapshot and removes actions when actions are disabled", async t => {
  for (const mode of ["interpretation", "previous", "actions_off", "source", "blocked"]) await t.test(mode, async t => {
    const s = fixture(t, "full choices"), answer = response(fullIntent(s.run.input));
    const bookingBatch = await prepareBookingOptions(s.prepared, answer, s.config, { readBookingOptions: async () => options() });
    if (mode === "interpretation") answer.structured.bookingOptions.hour24 = 18;
    if (mode === "previous") s.prepared.bookingPrevious = { changed: true };
    if (mode === "source") s.source.text = "changed";
    if (mode === "blocked") s.account.blocked = true;
    await finishRun(s.prepared, answer, null, { bookingBatch, currentConfig: mode === "actions_off" ? { ...s.config, bookingActionsEnabled: false } : s.config });
    if (mode === "actions_off") { assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).bookingSelection.action, null); }
    else { assert.equal(s.run.status, "failed"); assert.equal(s.messages.length, 0); }
  });
});
test("model cannot mix shopping and choices, smuggle fields into read/none or confirm through a selection action", () => {
  const config = { maxOutputChars: 4000 }, run = { input: "choices" }, allow = { allowBookingOptions: true, allowCheckoutSummary: true };
  assert.equal(outputSchema.required.length, 21);
  for (const booking of [selection({ action: "confirm" }), selection({ action: "read", hour24: 16 }),
    selection({ action: "none", locationId: B }), { ...selection(), owner: B }]) assert.throws(() => validateResult(response(booking), run, config, [], allow));
  assert.throws(() => validateResult(response(fullIntent("choices"), { checkoutSummary: "read" }), run, config, [], allow), { code: "booking_options_unavailable" });
  assert.equal(validateResult(response(fullIntent("choices"), { scope: "urgent" }), run, config, [], allow).bookingOptions, false);
});
test("historical selection DTO is safe for missing/unsaved pets and corrupt state never becomes an action", async t => {
  const s = fixture(t, "full choices"); await s.complete(response(fullIntent(s.run.input)));
  const record = s.messages[0];
  const unsaved = messageDto({ ...record, subjectId: "chat:anonymous" }).bookingSelection;
  assert.equal(unsaved.selection.petId, null); assert.equal(unsaved.action.booking.petId, undefined); assert.equal(unsaved.requiresPetAndContactReview, true);
  for (const raw of ["{", "x".repeat(4097), JSON.stringify({ ...JSON.parse(record.bookingSelectionJson), version: 2 })]) assert.equal(messageDto({ ...record, bookingSelectionJson: raw }).bookingSelection, undefined);
  assert.equal(messageDto({ ...record, role: "user" }).bookingSelection, undefined);
  assert.equal(selectionCard(record.bookingSelectionJson, null, null), null);
});
test("all-feature context and a modest saved catalog fit the unchanged budget; larger contexts fail before dispatch", async t => {
  const s = fixture(t, "full choices");
  s.config = { ...testConfig({ productSearchEnabled: true, cartPolicy: { version: "synthetic", proposalSeconds: 60, rateMax: 5, rateWindowSeconds: 60 } }),
    cartEnabled: true, bookingReadsEnabled: true, bookingActionsEnabled: true, bookingRetentionEnabled: true };
  s.run.config = s.config; s.run.catalogContext = { warehouseId: B, language: "en" }; s.prepared.run = { ...s.run };
  await s.complete(response(fullIntent(s.run.input))); s.next("at 6 pm");
  const request = await s.context(s.config);
  const bytes = Buffer.byteLength(JSON.stringify(request)); assert.ok(bytes <= s.config.maxContextBytes, `All-feature draft context bytes: ${bytes}`);
  assert.match(request.instructions, /"bookingDraft"/);
  await assert.rejects(s.context({ ...s.config, maxContextBytes: 1000 }), { code: "context_too_large" });
});
test("real worker reloads saved choices into its one scripted answer call and exact replay does not repeat work", async t => {
  const s = fixture(t, "full choices"); await s.complete(response(fullIntent(s.run.input))); s.next("at 6 pm");
  Object.assign(s.run, { status: "queued", attempts: [], accounting: "none", attempt: null, reservation: null, generation: 0,
    deadline: new Date(Date.now() + 60000), toObject() { return { ...this }; } });
  t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: false, billingTimezone: s.config.timezone, openingExposure: s.config.openingExposure }));
  let calls = 0, reads = 0;
  const worker = { getConfig: () => s.config, adapterFactory: () => ({ async generate(request) {
    calls++; assert.match(request.instructions, /"bookingDraft"/); assert.match(request.instructions, /"hour24":16/);
    return response(selection({ action: "update", hour24: 18, sourceQuote: s.run.input }));
  } }), readBookingOptions: async () => { reads++; return options(); } };
  assert.deepEqual(await processAssistantRun(s.run._id, worker), { status: "completed" });
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(messageDto(s.messages.at(-1)).bookingSelection.selection.hour24, 18);
  assert.deepEqual(await processAssistantRun(s.run._id, worker), { skipped: true }); assert.equal(calls, 1);
});

test("relative dates receive the backend Cairo calendar day without exposing raw app coordinates", async t => {
  const s = fixture(t, "tomorrow at 4 pm");
  const request = await buildContext(s.run, s.chat, [s.subject], s.config, null, new Date("2026-10-22T22:30:00.000Z"));
  assert.match(request.instructions, /"bookingToday":"2026-10-23"/);
  assert.doesNotMatch(request.instructions, /smouha|governorateCode/);
});
test("nested choice output crosses the real local provider HTTP adapter in three input languages", async t => {
  const s = fixture(t, "grooming at 4 pm"); const seen = [];
  let language = "en";
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk; seen.push(JSON.parse(body));
    res.end(JSON.stringify({ model: "gpt-6-luna", status: "completed", service_tier: "default",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(response(fullIntent(s.run.input), { replyLanguage: language }).structured) }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const adapter = createOpenAIResponsesAdapter({ endpoint: `http://127.0.0.1:${server.address().port}/v1/responses` });
  for (const [input, lang] of [["grooming at 4 pm", "en"], ["حلاقة الساعة 4 مساء", "ar"], ["grooming el sa3a 4 pm", "ar"]]) {
    s.run.input = input; s.source.text = input; s.prepared.run = { ...s.run }; language = lang;
    const result = await adapter.generate(await s.context(s.config));
    assert.equal(result.structured.replyLanguage, lang); assert.equal(result.structured.bookingOptions.hour24, 16);
    assert.equal(validateResult(result, s.run, s.config, s.prepared.allowedSubjects, { allowBookingOptions: true }).bookingOptions, true);
  }
  assert.equal(seen.length, 3); assert.equal(seen[0].store, false); assert.deepEqual(seen[0].text.format.schema, outputSchema);
});
test("saved frontend example uses real DTO projection and fixed bilingual selection rendering", () => {
  const example = JSON.parse(readFileSync(new URL("./fixtures/contracts/assistant-booking-selection-chat-example.json", import.meta.url), "utf8"));
  for (const [field, language] of [["selectionHistoryMessage", "en"], ["egyptianArabicSelectionHistoryMessage", "ar"]]) {
    const message = example[field]; assert.equal(message.text, renderBookingSelection(message.bookingSelection, language));
    assert.equal(message.bookingSelection.action.type, "review_booking_selection");
    assert.equal(message.bookingSelection.action.booking.petId, message.subjectId.slice(4));
    assert.doesNotMatch(JSON.stringify(message), /binding|sourceQuote|bookingSelectionJson/);
  }
  assert.deepEqual(example.afterReviewButtonOnly.body.booking, example.selectionHistoryMessage.bookingSelection.action.booking);
});
