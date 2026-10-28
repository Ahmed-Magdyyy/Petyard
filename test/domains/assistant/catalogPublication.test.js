import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import express from "express";
import { AssistantAccount, AssistantBudget, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { submission } from "../../../src/domains/assistant/shared/assistant.validation.js";
import { messageDto, metadataDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { submitMessage, getHistory, getRun } from "../../../src/domains/assistant/customer/assistant.service.js";
import { prepareProductSearch, finishRun, processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { buildCatalogSnapshot, storedCatalogDto, CATALOG_MAX_BYTES } from "../../../src/domains/assistant/products/assistant.product-cards.js";
import { productSearchContext, productSearchIntent } from "../../../src/domains/assistant/products/assistant.product-search.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { structuredReply, knownUsage, testConfig } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { readFile } from "node:fs/promises";
import { validateResult } from "../../../src/domains/assistant/customer/assistant.policy.js";

const W = "111111111111111111111111", P = "222222222222222222222222", V = "333333333333333333333333";
const context = { warehouseId: W, language: "en" };
const search = (changes = {}) => ({ action: "pet", query: "cat toy", minimumPackageWeightGrams: null, maximumPriceMinor: null, sourceQuote: "", options: [], ...changes });
const answer = (changes = {}) => ({ structured: structuredReply({ reply: "INVENTED product, price and provider claims", productSearch: search(), ...changes }),
  finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage });
const card = (changes = {}) => ({ id: P, slug: "cat-toy", name: "Cat toy", type: "SIMPLE", image: null, price: 100,
  discountedPrice: null, inStock: true, hasVariants: false, priceDisplay: "exact", ...changes });
const outcome = (changes = {}) => ({ status: "results", requestedWarehouseId: W, effectiveWarehouseId: W, rerouted: false,
  generatedAt: new Date().toISOString(), withheldCount: 0, products: [card()], ...changes });

function fixture(t, changes = {}) {
  const state = customerChatFixture(t, "I want a cat toy", { productSearchEnabled: true, ...changes });
  state.run.catalogContext = { ...context }; state.run.generation = 0;
  state.prepared.run = { ...state.run };
  t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: false, billingTimezone: state.config.timezone, openingExposure: state.config.openingExposure }));
  state.prepare = (result = answer(), read = async () => outcome()) => prepareProductSearch(state.prepared, result, state.config, { readProducts: read });
  state.complete = (result, batch) => finishRun(state.prepared, result, null, { currentConfig: state.config, productSearchBatch: batch });
  return state;
}

test("search needs both server opt-in and an explicit complete context; legacy submissions retain their shape", () => {
  const enabled = testConfig({ productSearchEnabled: true }); const disabled = testConfig();
  assert.equal(metadataDto(disabled, null, periods(disabled)).capabilities.liveCatalog, false);
  assert.equal(metadataDto(enabled, null, periods(enabled)).capabilities.liveCatalog, true);
  assert.equal(metadataDto(enabled, { blocked: true }, periods(enabled)).capabilities.liveCatalog, false);
  assert.notEqual(enabled.signature, disabled.signature);
  assert.throws(() => testConfig({ productSearchEnabled: "true" }), { code: "assistant_configuration_required" });
  assert.deepEqual(submission({ text: " hello " }, "message-key", enabled), { text: "hello", subjectId: undefined, key: "message-key" });
  assert.deepEqual(submission({ text: "hello", catalogContext: context }, "message-key", enabled).catalogContext, context);
  assert.throws(() => submission({ text: "hello", catalogContext: context }, "message-key", disabled), { code: "product_search_unavailable" });
  for (const catalogContext of [null, {}, { warehouseId: W }, { language: "en" }, { ...context, owner: P }, { ...context, language: "arabizi" }, { ...context, warehouseId: {} }]) {
    assert.throws(() => submission({ text: "hello", catalogContext }, "message-key", enabled));
  }
});

test("admission saves canonical context in the run/hash; changed warehouse/language/presence conflict and legacy hashes still replay", async (t) => {
  const state = fixture(t); state.run = null; state.account.activeRun = null;
  state.account.save = async () => {}; state.chat.nextSequence = 0;
  let stored;
  const query = (value) => ({ session() { return this; }, async then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(AssistantRun, "findOne", (filter) => query(stored && matchesQuery(stored, filter) ? stored : null));
  t.mock.method(AssistantRun, "create", async ([value]) => { stored = { ...value, _id: new mongoose.Types.ObjectId(), createdAt: new Date() }; return [stored]; });
  const owner = state.account.owner; const body = { text: "hello", catalogContext: context };
  const accepted = await submitMessage(owner, body, "context-key", state.config);
  assert.equal(accepted.duplicate, false); assert.deepEqual(stored.catalogContext, context);
  assert.equal(stored.hash, createHash("sha256").update(JSON.stringify({ text: "hello", subjectId: "auto", catalogContext: context })).digest("hex"));
  assert.equal((await submitMessage(owner, body, "context-key", state.config)).duplicate, true);
  for (const changed of [{ text: "hello" }, { ...body, catalogContext: { ...context, warehouseId: null } }, { ...body, catalogContext: { ...context, language: "ar" } }]) {
    await assert.rejects(submitMessage(owner, changed, "context-key", state.config), { code: "idempotency_conflict" });
  }
  stored = { ...stored, hash: createHash("sha256").update(JSON.stringify({ text: "hello", subjectId: "auto" })).digest("hex") };
  assert.equal((await submitMessage(owner, { text: "hello" }, "context-key", state.config)).duplicate, true);
  assert.equal(state.messages.length, 1); assert.equal(state.events.filter((event) => event.type === "message_accepted").length, 1);
});

test("publication saves one bounded allowlisted snapshot and backend text atomically with one settlement; replay cannot publish or charge", async (t) => {
  const state = fixture(t); const result = answer();
  const batch = await state.prepare(result, async (input) => { assert.deepEqual({ warehouseId: input.warehouseId, language: input.language }, context); return outcome({ internalBinding: "PRIVATE", products: [card({ providerRequestId: "PRIVATE" })] }); });
  await state.complete(result, batch);
  assert.equal(state.run.status, "completed"); assert.equal(state.run.accounting, "settled"); assert.equal(state.messages.length, 1);
  const dto = messageDto(state.messages[0]); assert.equal(dto.catalog.status, "results"); assert.equal(dto.catalog.products[0].id, P);
  assert.equal(dto.catalog.subjectId, state.subject.id); assert.equal(dto.catalog.subjectName, "Milo"); assert.equal(dto.catalog.suitability, "not_verified");
  assert.doesNotMatch(JSON.stringify(dto), /INVENTED|PRIVATE|catalogJson|classification|dietaryRisk|usage|model|sources/);
  assert.equal(state.budgetUpdates.length, 2); assert.equal(state.unlocked, 1);
  assert.equal(await state.complete(result, batch), null); assert.equal(state.messages.length, 1); assert.equal(state.budgetUpdates.length, 2);
});

test("exact public summary belongs to the qualifying variant and drops private source facts/extra combinations", () => {
  const data = answer({ productSearch: search({ minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, sourceQuote: "3kg under 1000 EGP",
    options: [{ name: "flavor", value: "Chicken", sourceQuote: "Chicken" }] }) }).structured;
  const intent = productSearchIntent(data, { input: "Chicken 3kg under 1000 EGP", subjectId: null });
  const matched = card({ type: "VARIANT", hasVariants: true, price: 1200, discountedPrice: 950, matchingOfferCount: 2,
    matchingOffers: [{ variantId: V, price: 1200, discountedPrice: 950, finalPriceMinor: 95000, inStock: true,
      attributes: [{ name: "weight", value: 3000, sources: [{ secret: "PRIVATE" }] }, { name: "flavor", value: "chicken", sources: [] }] }] });
  const snapshot = buildCatalogSnapshot(outcome({ products: [matched] }), intent, context, null, "en");
  assert.deepEqual(snapshot.products[0].matchingOffer, { variantId: V, packageWeightGrams: 3000, options: [{ name: "flavor", value: "chicken" }] });
  assert.equal(snapshot.products[0].matchingOfferCount, 2); assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|sources|matchingOffers|finalPriceMinor/);
  intent.filters.options[0].name = "الطعم";
  assert.deepEqual(buildCatalogSnapshot(outcome({ products: [matched] }), intent, context, null, "ar").products[0].matchingOffer,
    snapshot.products[0].matchingOffer);
  matched.matchingOffers[0].finalPriceMinor = 40000;
  assert.throws(() => buildCatalogSnapshot(outcome({ products: [matched] }), intent, context, null, "en"), { code: "invalid_catalog_snapshot" });
});

test("malformed, oversized and unsafe snapshots never reach history; old text-only messages remain unchanged", async (t) => {
  const state = fixture(t); const result = answer();
  for (const data of [outcome({ products: Array(4).fill(card()) }), outcome({ products: [card(), card()] }), outcome({ products: [card({ inStock: false }), card({ id: V })] }),
    outcome({ products: [card({ image: "javascript:alert(1)" })] }), outcome({ products: [card({ price: NaN })] }),
    outcome({ products: [card({ name: "أ".repeat(2000), slug: "أ".repeat(256), image: `https://example.test/${"x".repeat(2000)}` }),
      card({ id: V, name: "أ".repeat(2000), slug: "أ".repeat(256), image: `https://example.test/${"x".repeat(2000)}` }),
      card({ id: W, name: "أ".repeat(2000), slug: "أ".repeat(256), image: `https://example.test/${"x".repeat(2000)}` })] })]) {
    assert.equal((await state.prepare(result, async () => data)).result.status, "unavailable");
  }
  for (const json of [undefined, "{", JSON.stringify({ version: 2 }), "x".repeat(CATALOG_MAX_BYTES + 1)]) assert.equal(storedCatalogDto(json), null);
  const legacy = { _id: P, run: V, sequence: 2, role: "assistant", text: "old reply", subjectId: null };
  assert.deepEqual(messageDto(legacy), { id: P, runId: V, sequence: 2, role: "assistant", text: "old reply", subjectId: null, createdAt: null, expiresAt: null });
});

test("profile/access/context/source/binding changes before publication discard cards but settle known usage", async (t) => {
  for (const change of ["profile", "blocked", "warning_context", "source", "expired_source", "context", "binding"]) {
    await t.test(change, async (t) => {
      const state = fixture(t); const result = answer(); const batch = await state.prepare(result);
      if (change === "profile") state.pet.name = "Roy";
      if (change === "blocked") state.account.blocked = true;
      if (change === "warning_context") state.chat.contextVersion++;
      if (change === "source") state.source.text = "different input";
      if (change === "expired_source") state.source.expiresAt = new Date(0);
      if (change === "context") state.run.catalogContext = { ...context, language: "ar" };
      if (change === "binding") batch.binding = "forged";
      await state.complete(result, batch);
      assert.equal(state.run.status, "failed"); assert.equal(state.messages.length, 0); assert.equal(state.run.accounting, "settled");
      assert.equal(state.budgetUpdates.length, 2); assert.equal(state.unlocked, 1);
    });
  }
});

test("same-turn warning is used by the read and saved with the resulting catalog reply in the existing transaction", async (t) => {
  const state = fixture(t); const result = answer({ ...state.report(), scope: "petyard", reply: "INVENTED", productSearch: search() });
  const batch = await state.prepare(result, async (input) => {
    assert.equal(input.warnings[0].text, state.run.input); assert.equal(input.subject.id, state.subject.id);
    return outcome({ status: "food_review_required", withheldCount: 1, products: [] });
  });
  await state.complete(result, batch);
  assert.equal(state.warnings.length, 1); assert.equal(state.messages.length, 1); assert.equal(state.chat.contextVersion, 1);
  assert.equal(messageDto(state.messages[0]).catalog.status, "food_review_required"); assert.doesNotMatch(state.messages[0].text, /INVENTED/);
  assert.equal(state.run.contextVersion, state.chat.contextVersion);
});

test("the recorded health search cannot read a catalog or publish cards even without a model warning", async (t) => {
  const recorded = JSON.parse(await readFile(new URL("fixtures/healthShoppingV4.json", import.meta.url), "utf8"));
  const state = customerChatFixture(t, recorded.input, { productSearchEnabled: true, catalogSemanticEnabled: true,
    catalogSemanticMinimumScore: 0.2, maxOutputTokens: 1024 });
  state.run.catalogContext = { warehouseId: W, language: "ar" }; state.prepared.run = { ...state.run };
  // Rebind only the fictional pet ID and use synthetic accounting for publication.
  const data = structuredClone(recorded.structured); data.resolvedSubjectId = state.subject.id;
  assert.equal(data.dietaryWarningAction, "none"); assert.equal(data.productSearch.action, "general");
  const response = answer(data);
  const valid = validateResult(response, state.run, state.config, state.prepared.allowedSubjects, { allowProductSearch: true });
  assert.equal(valid.productSearch, null); assert.match(valid.reply, /طبيب بيطري/);
  const batch = await prepareProductSearch(state.prepared, response, state.config, {
    readProducts: () => assert.fail("Health advice cannot read catalog"),
    readSemantic: () => assert.fail("Health advice cannot embed or search") });
  assert.equal(batch, null);
  await finishRun(state.prepared, response, null, { currentConfig: state.config, productSearchBatch: batch });
  assert.equal(state.run.status, "completed"); assert.equal(state.run.accounting, "settled");
  assert.equal(state.messages.length, 1); assert.match(state.messages[0].text, /طبيب بيطري/);
  assert.equal(state.messages[0].catalogJson, undefined); assert.equal(messageDto(state.messages[0]).catalog, undefined);
  assert.equal(state.warnings.length, 0); assert.equal(state.unlocked, 1);
});

test("the health boundary still rejects malformed evidence and unavailable tools", () => {
  const config = testConfig({ productSearchEnabled: true });
  const run = { input: "at most EGP 900", subjectId: null };
  const valid = answer({ scope: "health", replyLanguage: "en", productSearch: search({ maximumPriceMinor: 90000,
    sourceQuote: run.input }) });
  assert.equal(validateResult(valid, run, config, [], { allowProductSearch: true }).productSearch, null);
  valid.structured.productSearch.sourceQuote = "invented";
  assert.throws(() => validateResult(valid, run, config, [], { allowProductSearch: true }), { code: "invalid_product_search" });
  valid.structured.productSearch.sourceQuote = run.input;
  assert.throws(() => validateResult(valid, run, config, []), { code: "product_search_unavailable" });
});

test("health advice still saves an explicit dietary warning while suppressing its requested shopping", async (t) => {
  const state = fixture(t), response = answer({ ...state.report(), productSearch: search() });
  const batch = await state.prepare(response, () => assert.fail("Health advice cannot search"));
  assert.equal(batch, null); await state.complete(response, batch);
  assert.equal(state.run.status, "completed"); assert.equal(state.warnings.length, 1);
  assert.equal(state.messages.length, 1); assert.match(state.messages[0].text, /veterinarian/);
  assert.equal(state.messages[0].catalogJson, undefined); assert.equal(state.budgetUpdates.length, 2);
});

test("stale attempts and missing bound batches cannot publish a catalog", async (t) => {
  const state = fixture(t); const result = answer(); const batch = await state.prepare(result);
  const attempt = state.run.attempt; state.run.attempt = "later-attempt";
  assert.equal(await state.complete(result, batch), null); assert.equal(state.budgetUpdates.length, 0);
  state.run.attempt = attempt;
  await state.complete(result, null);
  assert.equal(state.run.status, "failed"); assert.equal(state.messages.length, 0); assert.equal(state.run.accounting, "settled");
});

test("actual Mongoose schemas retain the optional context/snapshot, preserve legacy absence and need no new index", async (t) => {
  const state = fixture(t); const result = answer(); await state.complete(result, await state.prepare(result));
  const message = new AssistantMessage(state.messages[0]); assert.equal(message.validateSync(), undefined);
  assert.equal(typeof message.toObject().catalogJson, "string");
  const fields = { owner: state.run.owner, chat: state.run.chat, key: "schema-context-key", hash: "hash", status: "queued", purpose: "customer",
    contextVersion: 0, input: "hello", userSequence: 1, config: state.config };
  const legacy = new AssistantRun(fields); assert.equal(legacy.validateSync(), undefined); assert.equal(legacy.toObject().catalogContext, undefined);
  const run = new AssistantRun({ ...fields, catalogContext: context }); assert.equal(run.validateSync(), undefined);
  assert.deepEqual(run.toObject().catalogContext, context);
  assert.deepEqual(productSearchContext(run.catalogContext, "en"), context, "publication receives a hydrated Mongoose subdocument");
  const invalid = new AssistantRun({ ...fields, catalogContext: { ...context, userId: P } });
  assert.ok(invalid.validateSync()?.errors.catalogContext, "unknown nested fields must fail schema validation");
  assert.equal(AssistantRun.schema.indexes().some(([keys]) => Object.keys(keys).some((key) => /catalog/i.test(key))), false);
});

test("ordinary text-only completion remains compatible even when the new client context is supplied", async (t) => {
  const state = fixture(t); const result = { ...answer(), structured: structuredReply({ reply: "General care guidance" }) };
  assert.equal(await state.prepare(result, () => assert.fail("No search intent")), null);
  await state.complete(result, null);
  assert.equal(state.run.status, "completed"); assert.equal(state.messages[0].text, "General care guidance");
  assert.equal(messageDto(state.messages[0]).catalog, undefined);
});

test("missing subject and lookup failures retain deterministic Arabic/English states without leaking model prose", async (t) => {
  for (const language of ["ar", "en"]) {
    await t.test(language, async (t) => {
      const state = fixture(t); state.run.subjectId = null; state.run.subjectFingerprint = null; state.source.subjectId = null;
      state.prepared.run = { ...state.run };
      const result = answer({ replyLanguage: language });
      const batch = await state.prepare(result, () => assert.fail("Identity must be resolved first"));
      await state.complete(result, batch);
      assert.equal(messageDto(state.messages[0]).catalog.status, "needs_subject");
      assert.doesNotMatch(state.messages[0].text, /INVENTED/);
      assert.match(state.messages[0].text, language === "ar" ? /أنهي حيوان/ : /Which pet/);
    });
  }
});

test("lookup context changes are fenced before final publication, including safe failure replies", async (t) => {
  const state = fixture(t);
  await assert.rejects(state.prepare(answer(), async () => { state.chat.contextVersion++; throw new Error("database detail"); }), { code: "context_changed" });
  assert.equal(state.messages.length, 0); assert.equal(state.budgetUpdates.length, 0);
});

test("owned history and polling return the exact saved snapshot without rereads, hiding expired and foreign messages", async (t) => {
  const state = fixture(t); const result = answer(); await state.complete(result, await state.prepare(result));
  const stored = { ...state.messages[0], createdAt: new Date() };
  const query = (read) => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, async lean() { return read(); } });
  t.mock.method(AssistantMessage, "find", (filter) => query(() => matchesQuery(stored, filter) ? [stored] : []));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => matchesQuery(stored, filter) ? stored : null));
  const poll = await getRun(state.run.owner, String(state.run._id), state.config);
  const history = await getHistory(state.run.owner, {}, state.config);
  assert.deepEqual(poll.message.catalog, history.messages[0].catalog);
  await assert.rejects(getRun(new mongoose.Types.ObjectId(), String(state.run._id), state.config), { code: "run_not_found" });
  const originalRun = stored.run; stored.run = new mongoose.Types.ObjectId();
  assert.equal((await getRun(state.run.owner, String(state.run._id), state.config)).message, null);
  stored.run = originalRun;
  stored.expiresAt = new Date(0);
  assert.equal((await getRun(state.run.owner, String(state.run._id), state.config)).message, null);
  assert.equal((await getHistory(state.run.owner, {}, state.config)).messages.length, 0);
});

test("loopback customer routes keep existing envelopes and return the retained catalog under the authenticated owner", async (t) => {
  const state = fixture(t); const result = answer(); await state.complete(result, await state.prepare(result));
  const stored = { ...state.messages[0], createdAt: new Date() };
  const body = { text: state.run.input, catalogContext: context };
  state.run.key = "http-catalog-key";
  state.run.hash = createHash("sha256").update(JSON.stringify({ text: state.run.input, subjectId: "auto", catalogContext: context })).digest("hex");
  const query = (read) => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, async lean() { return read(); } });
  t.mock.method(AssistantMessage, "find", (filter) => query(() => matchesQuery(stored, filter) ? [stored] : []));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => matchesQuery(stored, filter) ? stored : null));
  const app = express(); app.use(express.json());
  // Existing foundation HTTP tests cover real bearer/phone middleware; this fixture supplies its authenticated principal.
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config,
    authenticate(req, _res, next) { req.user = { _id: state.run.owner }; next(); } }));
  const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant`;
  const headers = { "Content-Type": "application/json", "Idempotency-Key": state.run.key };
  const duplicate = await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).data.duplicate, true);
  const conflict = await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify({ ...body, catalogContext: { ...context, language: "ar" } }) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  const injected = await fetch(`${url}/messages`, { method: "POST", headers, body: JSON.stringify({ ...body, owner: P }) });
  assert.equal(injected.status, 400);
  const poll = await (await fetch(`${url}/runs/${state.run._id}`)).json();
  const history = await (await fetch(`${url}/messages`)).json();
  assert.deepEqual(poll.data.message.catalog, history.data.messages[0].catalog);
  assert.equal(poll.data.message.catalog.products[0].id, P);
  assert.doesNotMatch(JSON.stringify(poll), /INVENTED|catalogJson|usage|config|classification|binding/);
});

test("fresh catalog HTTP admission completes through the scripted worker and retains snapshots across original-key recovery", async (t) => {
  const state = fixture(t); const owner = state.account.owner;
  state.run = null; state.source = null; state.account.activeRun = null;
  state.account.save = async () => {}; state.chat.nextSequence = 0;
  const query = (read) => ({ select() { return this; }, sort() { return this; }, limit() { return this; },
    maxTimeMS() { return this; }, session() { return this; }, async lean() { return read(); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(mongoose, "connect", () => assert.fail("This regression must not connect to MongoDB"));
  t.mock.method(mongoose, "createConnection", () => assert.fail("This regression must not connect to MongoDB"));
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => state.run && matchesQuery(state.run, filter) ? state.run : null));
  t.mock.method(AssistantRun, "create", async ([record]) => {
    state.run = { ...record, _id: new mongoose.Types.ObjectId(), createdAt: new Date(), generation: 0, attempts: [],
      accounting: "none", responseMessage: null, async save() {}, toObject() { return { ...this }; } };
    return [state.run];
  });
  t.mock.method(AssistantMessage, "create", async ([record]) => {
    const message = { ...record, _id: new mongoose.Types.ObjectId(), createdAt: new Date() };
    state.messages.push(message); if (message.role === "user") state.source = message;
    return [message];
  });
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => state.messages.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantMessage, "find", (filter) => query(() => state.messages.filter((row) => matchesQuery(row, filter)).sort((a, b) => b.sequence - a.sequence)));
  t.mock.method(AssistantAccount, "updateOne", async (filter, update) => {
    assert.ok(matchesQuery(state.account, filter));
    if (update.$set?.activeRun === null) { state.unlocked++; state.account.activeRun = null; }
    return { modifiedCount: 1 };
  });
  const app = express(); app.use(express.json());
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config,
    authenticate(req, _res, next) { req.user = { _id: owner }; next(); } }));
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server)); server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/v1/assistant`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (target, options) => {
    assert.equal(new URL(target).origin, origin, "Only this test's HTTP server may be contacted");
    return realFetch(target, options);
  });
  const body = JSON.stringify({ text: "I want a cat toy", catalogContext: context });
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "fresh-catalog-http-key" };
  const acceptedResponse = await fetch(`${url}/messages`, { method: "POST", headers, body });
  const accepted = (await acceptedResponse.json()).data;
  assert.equal(acceptedResponse.status, 202); assert.equal(accepted.duplicate, false); assert.equal(accepted.run.status, "queued");
  assert.deepEqual(state.run.catalogContext, context);
  assert.equal(state.run.hash, createHash("sha256").update(JSON.stringify({ text: "I want a cat toy", subjectId: "auto", catalogContext: context })).digest("hex"));
  const runId = accepted.run.id, sourceId = String(state.source._id);
  const pendingResponse = await fetch(`${url}/runs/${runId}`); assert.equal(pendingResponse.status, 200);
  const pending = (await pendingResponse.json()).data;
  assert.equal(pending.run.status, "queued"); assert.equal(pending.message, null);
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].catalogJson, undefined);
  let adapterCalls = 0, catalogReads = 0;
  const result = await processAssistantRun(runId, { getConfig: () => state.config,
    adapterFactory: () => ({ async generate(request) { adapterCalls++; assert.match(request.instructions, /"productSearchAvailable":true/); return answer(); } }),
    readProducts: async (input) => {
      catalogReads++; assert.equal(input.subject.id, state.subject.id);
      assert.equal(input.warehouseId, W); assert.equal(input.language, "en"); return outcome();
    } });
  assert.equal(result.status, "completed"); assert.equal(adapterCalls, 1); assert.equal(catalogReads, 1);
  assert.equal(state.run.attempts.length, 1); assert.equal(state.run.accounting, "settled"); assert.equal(state.run.chargedMicroUsd, 198);
  const charges = state.budgetUpdates.filter(({ update }) => update.$inc?.spent !== undefined);
  assert.equal(charges.length, 2); assert.ok(charges.every(({ update }) => update.$inc.spent === 198));
  assert.equal(state.unlocked, 1); assert.equal(state.account.activeRun, null); assert.equal(state.account.dayMessages, 1);
  const pollResponse = await fetch(`${url}/runs/${runId}`), historyResponse = await fetch(`${url}/messages`);
  assert.equal(pollResponse.status, 200); assert.equal(historyResponse.status, 200);
  const poll = (await pollResponse.json()).data, history = (await historyResponse.json()).data;
  const reply = history.messages.find((message) => message.role === "assistant");
  assert.equal(poll.run.status, "completed"); assert.equal(poll.message.id, reply.id);
  assert.equal(poll.run.responseMessageId, reply.id); assert.equal(reply.runId, runId);
  assert.deepEqual(poll.message.catalog, reply.catalog); assert.equal(reply.catalog.products[0].id, P);
  assert.equal(reply.catalog.subjectId, state.subject.id); assert.equal(reply.catalog.requestedWarehouseId, W);
  assert.equal(String(state.source._id), sourceId); assert.equal(history.messages.length, 2);
  assert.doesNotMatch(JSON.stringify({ poll, history }), /INVENTED|catalogJson|providerRequestId|chargedMicroUsd|classification|binding/);
  const counts = { messages: state.messages.length, events: state.events.length, budgetUpdates: state.budgetUpdates.length };
  const duplicateResponse = await fetch(`${url}/messages`, { method: "POST", headers, body });
  const duplicate = (await duplicateResponse.json()).data;
  assert.equal(duplicateResponse.status, 200); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.id, runId);
  const conflictResponse = await fetch(`${url}/messages`, { method: "POST", headers,
    body: JSON.stringify({ ...JSON.parse(body), catalogContext: { ...context, language: "ar" } }) });
  assert.equal(conflictResponse.status, 409); assert.equal((await conflictResponse.json()).error.code, "idempotency_conflict");
  assert.deepEqual(await processAssistantRun(runId, { getConfig: () => state.config }), { skipped: true });
  assert.deepEqual({ messages: state.messages.length, events: state.events.length, budgetUpdates: state.budgetUpdates.length }, counts);
  assert.equal(adapterCalls, 1); assert.equal(catalogReads, 1); assert.equal(state.unlocked, 1); assert.equal(state.account.dayMessages, 1);
  assert.equal(state.events.filter((event) => event.type === "message_accepted").length, 1);
  assert.equal(state.events.filter((event) => event.type === "run_completed").length, 1);
});

function queue(state) {
  Object.assign(state.run, { status: "queued", attempts: [], accounting: "none", attempt: null, reservation: null, phase: "resolve", generation: 0,
    deadline: new Date(Date.now() + 60000), toObject() { return { ...this }; } });
  state.prepared.run = { ...state.run };
}

test("runtime executes one lookup and one paid-adapter fixture call; lookup failure/timeout completes safely without retry", async (t) => {
  for (const mode of ["results", "failure", "timeout", "missing_location"]) {
    await t.test(mode, async (t) => {
      const state = fixture(t, mode === "timeout" ? { timeoutMs: 20 } : {}); queue(state);
      if (mode === "missing_location") state.run.catalogContext.warehouseId = null;
      let providerCalls = 0, reads = 0;
      const result = await processAssistantRun(state.run._id, { getConfig: () => state.config,
        adapterFactory: () => ({ async generate(request) { providerCalls++; assert.match(request.instructions, /"productSearchAvailable":true/); return answer(); } }),
        readProducts: async (input) => {
          reads++;
          if (mode === "failure") throw new Error("PRIVATE provider/database details");
          if (mode === "timeout") return new Promise(() => {});
          return mode === "missing_location" ? { status: "needs_location", products: [] } : outcome();
        } });
      assert.equal(result.status, "completed", JSON.stringify({ result, code: state.run.internalCode })); assert.equal(providerCalls, 1); assert.equal(reads, 1);
      assert.equal(messageDto(state.messages[0]).catalog.status, mode === "results" ? "results" : mode === "missing_location" ? "needs_location" : "unavailable");
      assert.doesNotMatch(state.messages[0].text, /PRIVATE|INVENTED/); assert.equal(state.run.attempts.length, 1); assert.equal(state.run.accounting, "settled");
      assert.deepEqual(await processAssistantRun(state.run._id, { getConfig: () => state.config }), { skipped: true });
      assert.equal(providerCalls, 1);
    });
  }
});

test("runtime skips lookup for old clients, disabled search, unknown usage, urgent scope and identity/warning clarification", async (t) => {
  for (const mode of ["legacy", "disabled", "unknown_usage", "urgent", "clarify", "warning_clarify"]) {
    await t.test(mode, async (t) => {
      const state = fixture(t, mode === "disabled" ? { productSearchEnabled: false } : {}); queue(state);
      if (mode === "legacy") delete state.run.catalogContext;
      const extra = mode === "urgent" ? { scope: "urgent" } : mode === "clarify" ? { subjectAction: "clarify" } : mode === "warning_clarify" ? { dietaryWarningAction: "clarify" } : {};
      await processAssistantRun(state.run._id, { getConfig: () => state.config,
        adapterFactory: () => ({ async generate() { return { ...answer(extra), ...(mode === "unknown_usage" ? { usage: null } : {}) }; } }),
        readProducts: () => assert.fail("Unsafe or unsupported intent must not search") });
      assert.equal(state.messages.some((message) => message.catalogJson !== undefined), false);
      assert.equal(state.run.status, mode === "unknown_usage" ? "uncertain" : ["legacy", "disabled"].includes(mode) ? "failed" : "completed");
    });
  }
});

test("message persistence failure propagates from the shared settlement/publication transaction, with no follow-up paid dispatch", async (t) => {
  const state = fixture(t); const result = answer(); const batch = await state.prepare(result);
  let transactionCalls = 0;
  t.mock.method(mongoose, "startSession", async () => ({ async withTransaction(callback) {
    transactionCalls++;
    const before = { accounting: state.run.accounting, attempts: state.run.attempts.map((entry) => ({ ...entry })), nextSequence: state.chat.nextSequence };
    try { return await callback(); } catch (error) {
      state.run.accounting = before.accounting; state.run.attempts = before.attempts; state.chat.nextSequence = before.nextSequence;
      state.budgetUpdates.length = 0; throw error;
    }
  }, async endSession() {} }));
  t.mock.method(AssistantMessage, "create", async () => { throw new Error("synthetic message persistence failure"); });
  await assert.rejects(state.complete(result, batch), /synthetic message persistence failure/);
  assert.equal(transactionCalls, 1); assert.equal(state.run.accounting, "reserved"); assert.equal(state.run.status, "dispatching");
  assert.equal(state.budgetUpdates.length, 0); assert.equal(state.messages.length, 0); assert.equal(state.unlocked, 0);
});


const bundleCardFixture = () => card({ slug: null, name: "Care kit", type: "BUNDLE", price: 20, discountedPrice: 15, warehouseId: W, revision: 2,
  components: [{ productId: V, productType: "SIMPLE", variantId: null, quantity: 2, name: "Brush", image: null, variantOptions: [] }] });

test("the existing worker publishes and rereads a bundle suggestion without inventing a model summary or cart action", async t => {
  const state = fixture(t); state.config = { ...state.config, bundleCartEnabled: true }; const result = answer();
  const batch = await state.prepare(result, async () => outcome({ products: [bundleCardFixture()] })); await state.complete(result, batch);
  assert.equal(state.run.status, "completed"); assert.equal(state.messages.length, 1);
  const dto = messageDto(state.messages[0]); assert.equal(dto.catalog.products[0].type, "BUNDLE"); assert.equal(dto.catalog.products[0].components[0].quantity, 2);
  assert.deepEqual(storedCatalogDto(state.messages[0].catalogJson), dto.catalog); assert.doesNotMatch(dto.text, /INVENTED/);
  assert.equal(state.budgetUpdates.length, 2);
});

test("disabling bundles after lookup prevents publication of a new bundle suggestion", async t => {
  const state = fixture(t); state.config = { ...state.config, bundleCartEnabled: true }; const result = answer();
  const batch = await state.prepare(result, async () => outcome({ products: [bundleCardFixture()] })); state.config = { ...state.config, bundleCartEnabled: false };
  await state.complete(result, batch); assert.equal(state.run.status, "failed"); assert.equal(state.messages.length, 0); assert.equal(state.run.accounting, "settled");
});
