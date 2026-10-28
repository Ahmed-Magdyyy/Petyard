import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { AssistantBudget, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { messageDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { getHistory, getRun } from "../../../src/domains/assistant/customer/assistant.service.js";
import { prepareCheckoutSummary, finishRun, processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { buildCheckoutSnapshot, renderCheckoutResponse, storedCheckoutDto, CHECKOUT_MAX_BYTES } from "../../../src/domains/assistant/customer/assistant.checkout-cards.js";
import { validateResult } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { knownUsage, structuredReply, testPolicy } from "./fixtures/foundationPolicy.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

const W = "111111111111111111111111", C = "222222222222222222222222";
const response = (extra = {}) => ({ structured: structuredReply({ scope: "petyard", checkoutSummary: "read", reply: "INVENTED paid order", ...extra }),
  finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage });
const summary = (extra = {}) => ({ status: "summary", cartId: C, warehouseId: W, currency: "EGP", dataMode: "estimate",
  requiresCheckoutRefresh: true, couponState: "checkout_managed", cartChanged: false, addressComplete: true, isPrimeLocation: false,
  pricing: { subtotal: 100, shippingFee: 50, discountAmount: 0, shippingDiscount: 0, totalDiscount: 0,
    total: 150, walletBalance: 30, walletUsed: 30, finalTotal: 120, loyaltyPoints: 100 },
  action: { type: "open_checkout", cartId: C, warehouseId: W }, ...extra });
function fixture(t, input = "Show my checkout estimate", overrides = {}) {
  const s = customerChatFixture(t, input);
  s.config = loadAssistantConfig({ ASSISTANT_ENABLED: "true", ASSISTANT_CART_ENABLED: "true", OPENAI_API_KEY: "synthetic-not-real",
    ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy({ productSearchEnabled: true,
      cartPolicy: { version: "synthetic-v1", proposalSeconds: 120, rateMax: 5, rateWindowSeconds: 60 }, ...overrides })) });
  s.run.config = s.config; s.run.catalogContext = { warehouseId: W, language: "en" }; s.run.generation = 0;
  s.prepared.run = { ...s.run };
  s.prepare = (answer = response(), readCheckout = async () => summary()) => prepareCheckoutSummary(s.prepared, answer, s.config, { readCheckout });
  s.complete = (answer, checkoutBatch) => finishRun(s.prepared, answer, null, { currentConfig: s.config, checkoutBatch });
  return s;
}

test("English, Arabic and Arabizi checkout intents read only the authenticated owner and supplied effective warehouse", async (t) => {
  for (const [input, language] of [["Show my checkout total", "en"], ["وريني حساب السلة", "ar"], ["el cart bekam?", "ar"]]) {
    await t.test(input, async (t) => {
      const s = fixture(t, input); s.run.catalogContext.language = language;
      const answer = response({ replyLanguage: language }); let reads = 0;
      const batch = await s.prepare(answer, async (args) => { reads++; assert.deepEqual(args,
        { userId: String(s.run.owner), warehouseId: W, lang: language }); return summary({ internalSecret: "PRIVATE", deliveryAddress: { phone: "PRIVATE" } }); });
      assert.equal(s.messages.length, 0); assert.equal(s.budgetUpdates.length, 0); assert.equal(s.saves, 0);
      await s.complete(answer, batch);
      assert.equal(s.run.status, "completed"); assert.equal(reads, 1); assert.equal(s.messages.length, 1);
      const dto = messageDto(s.messages[0]); assert.equal(dto.checkout.pricing.finalTotal, 120); assert.equal(dto.checkout.action.type, "open_checkout");
      assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|INVENTED|internalSecret|deliveryAddress|checkoutJson|provider/);
      assert.match(dto.text, language === "ar" ? /تقدير/ : /estimate/);
      assert.equal(s.budgetUpdates.length, 2); assert.equal(s.unlocked, 1);
      assert.equal(await s.complete(answer, batch), null); assert.equal(s.messages.length, 1);
    });
  }
});

test("all checkout states retain safe navigation and unknown totals; no warehouse means no commerce read", async (t) => {
  const cases = [summary({ status: "missing_cart", cartId: null, pricing: null, action: null }),
    summary({ status: "empty_cart", pricing: null, action: null }),
    summary({ status: "needs_address", addressComplete: false, isPrimeLocation: null,
      pricing: { ...summary().pricing, shippingFee: null, total: null, finalTotal: null } }),
    summary({ status: "review_cart", cartChanged: true }),
    summary({ status: "review_cart", cartChanged: true, pricing: null, action: { type: "open_cart", cartId: C, warehouseId: W } })];
  for (const value of cases) await t.test(`${value.status}:${value.action?.type}`, async (t) => {
    const s = fixture(t), answer = response(); await s.complete(answer, await s.prepare(answer, async () => value));
    assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).checkout.status, value.status);
    assert.deepEqual(messageDto(s.messages[0]).checkout.pricing, value.pricing);
  });
  await t.test("needs_location", async (t) => {
    const s = fixture(t); s.run.catalogContext.warehouseId = null; const answer = response();
    await s.complete(answer, await s.prepare(answer, () => assert.fail("Must not guess a warehouse")));
    assert.equal(messageDto(s.messages[0]).checkout.status, "needs_location"); assert.equal(messageDto(s.messages[0]).checkout.action, null);
  });
});

test("disabled, missing-context, unknown usage, unsupported tier, urgent/health/identity and ambiguous requests never read checkout", async (t) => {
  for (const mode of ["disabled", "missing_context", "unknown_usage", "wrong_tier", "urgent", "health", "identity", "off_topic", "clarify", "switch", "warning"]) {
    await t.test(mode, async (t) => {
      const s = fixture(t); let answer = response();
      if (mode === "disabled") { s.config = { ...s.config, cartEnabled: false }; s.run.config = s.config; s.prepared.run.config = s.config; }
      if (mode === "missing_context") { delete s.run.catalogContext; s.prepared.run = { ...s.run }; }
      if (mode === "unknown_usage") answer.usage = null;
      if (mode === "wrong_tier") answer.serviceTier = "unverified";
      if (["urgent", "health", "identity", "off_topic"].includes(mode)) answer.structured.scope = mode;
      if (mode === "clarify") answer.structured.subjectAction = "clarify";
      if (mode === "switch") answer.structured.subjectAction = "create_unsaved";
      if (mode === "warning") answer.structured.dietaryWarningAction = "clarify";
      const prepare = () => s.prepare(answer, () => assert.fail("Unsafe request cannot read checkout"));
      if (["disabled", "missing_context"].includes(mode)) await assert.rejects(prepare(), { code: "checkout_summary_unavailable" });
      else assert.equal(await prepare(), null);
      assert.equal(s.messages.length, 0); assert.equal(s.budgetUpdates.length, 0);
    });
  }
  const s = fixture(t);
  assert.throws(() => validateResult(response({ productSearch: { action: "general", query: "toys", minimumPackageWeightGrams: null,
    maximumPriceMinor: null, sourceQuote: "", options: [] } }), s.run, s.config, s.prepared.allowedSubjects,
  { allowProductSearch: true, allowCheckoutSummary: true }), { code: "checkout_summary_unavailable" });
  await assert.rejects(prepareCheckoutSummary({ ...s.prepared, run: { ...s.run, purpose: "admin_business" } }, response(), s.config), { code: "run_not_found" });
});

test("access, source, ownership/profile and publication bindings reject changes around the read", async (t) => {
  for (const mode of ["source", "blocked_before", "blocked_during", "profile", "warehouse", "batch", "source_after"]) await t.test(mode, async (t) => {
    const s = fixture(t), answer = response();
    if (mode === "source") s.source.text = "changed";
    if (mode === "blocked_before") s.account.blocked = true;
    const work = () => s.prepare(answer, async () => { if (mode === "blocked_during") s.account.blocked = true;
      if (mode === "profile") s.pet.name = "changed"; return summary(); });
    if (["source", "blocked_before", "blocked_during", "profile"].includes(mode)) {
      await assert.rejects(work(), { code: mode.startsWith("blocked") ? "ai_restricted" : "context_changed" });
    } else {
      const batch = await work();
      if (mode === "warehouse") s.run.catalogContext.warehouseId = C;
      if (mode === "batch") batch.binding = "invented";
      if (mode === "source_after") s.source.text = "changed";
      await s.complete(answer, batch); assert.equal(s.run.status, "failed"); assert.equal(s.run.publicCode, "context_changed");
    }
    assert.equal(s.messages.length, 0);
  });
});

test("read errors, malformed amounts, foreign warehouses and timeout publish unavailable without leaking details or late data", async (t) => {
  for (const mode of ["failure", "malformed", "foreign", "timeout"]) await t.test(mode, async (t) => {
    const s = fixture(t, undefined, { timeoutMs: 20 }), answer = response(); let release;
    const batch = await s.prepare(answer, async () => {
      if (mode === "failure") throw new Error("PRIVATE database details");
      if (mode === "malformed") return summary({ pricing: { ...summary().pricing, finalTotal: -1 } });
      if (mode === "foreign") return summary({ warehouseId: C });
      return new Promise((resolve) => { release = resolve; });
    });
    await s.complete(answer, batch); assert.equal(s.run.status, "completed");
    assert.equal(messageDto(s.messages[0]).checkout.status, "unavailable"); assert.equal(messageDto(s.messages[0]).checkout.action, null);
    assert.doesNotMatch(JSON.stringify(messageDto(s.messages[0])), /PRIVATE|INVENTED/);
    if (release) { release(summary()); await new Promise((resolve) => setImmediate(resolve)); assert.equal(s.messages.length, 1); }
  });
});

test("retained checkout DTO is bounded, assistant-only and strips private/line data; malformed historical values disappear", () => {
  const snapshot = buildCheckoutSnapshot(summary({ items: [{ address: "PRIVATE" }], owner: "PRIVATE" }), W);
  assert.deepEqual(storedCheckoutDto(JSON.stringify(snapshot)), snapshot);
  assert.equal(snapshot.items, undefined); assert.equal(snapshot.owner, undefined);
  for (const raw of ["{", "x".repeat(CHECKOUT_MAX_BYTES + 1), JSON.stringify({ ...snapshot, generatedAt: undefined }),
    JSON.stringify({ ...snapshot, action: { ...snapshot.action, warehouseId: C } }),
    JSON.stringify({ ...snapshot, pricing: { ...snapshot.pricing, finalTotal: null } })]) assert.equal(storedCheckoutDto(raw), null);
  assert.equal(messageDto({ _id: C, run: C, role: "user", checkoutJson: JSON.stringify(snapshot) }).checkout, undefined);
});

test("authorized context advertises checkout only with the existing cart gate and explicit client context", async (t) => {
  const s = fixture(t);
  assert.match((await s.context(s.config)).instructions, /"checkoutSummaryAvailable":true/);
  assert.match((await s.context({ ...s.config, cartEnabled: false })).instructions, /"checkoutSummaryAvailable":false/);
  delete s.run.catalogContext;
  assert.match((await s.context(s.config)).instructions, /"checkoutSummaryAvailable":false/);
});

test("the documented complete wire example matches the DTO and server text, with no required pet selection", async (t) => {
  const example = JSON.parse(await readFile(new URL("./fixtures/contracts/assistant-checkout-chat-example.json", import.meta.url), "utf8"));
  const message = example.completedRunResponse.data.message;
  assert.equal(renderCheckoutResponse(message.checkout, "en"), message.text);
  assert.deepEqual(messageDto({ ...message, _id: message.id, run: message.runId, checkoutJson: JSON.stringify(message.checkout) }), message);
  const s = fixture(t); s.run.subjectId = null; s.run.subjectFingerprint = null; s.source.subjectId = null; s.prepared.run = { ...s.run };
  const answer = response(); await s.complete(answer, await s.prepare(answer));
  assert.equal(s.run.status, "completed"); assert.equal(messageDto(s.messages[0]).checkout.status, "summary");
});

test("owned polling and history return the saved estimate without rereading; foreign and expired responses stay hidden", async (t) => {
  const s = fixture(t), answer = response(); await s.complete(answer, await s.prepare(answer));
  const stored = { ...s.messages[0], createdAt: new Date() };
  const query = (read) => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, async lean() { return read(); } });
  t.mock.method(AssistantMessage, "find", (filter) => query(() => matchesQuery(stored, filter) ? [stored] : []));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => matchesQuery(stored, filter) ? stored : null));
  assert.deepEqual((await getRun(s.run.owner, String(s.run._id), s.config)).message.checkout,
    (await getHistory(s.run.owner, {}, s.config)).messages[0].checkout);
  await assert.rejects(getRun(new mongoose.Types.ObjectId(), String(s.run._id), s.config), { code: "run_not_found" });
  stored.expiresAt = new Date(0);
  assert.equal((await getRun(s.run.owner, String(s.run._id), s.config)).message, null);
  assert.equal((await getHistory(s.run.owner, {}, s.config)).messages.length, 0);
});

test("the real worker uses one scripted model result, one read and one settlement; replay skips both", async (t) => {
  const s = fixture(t);
  Object.assign(s.run, { status: "queued", attempts: [], accounting: "none", attempt: null, reservation: null, phase: "resolve", generation: 0,
    deadline: new Date(Date.now() + 60000), toObject() { return { ...this }; } });
  t.mock.method(AssistantBudget, "findOneAndUpdate", async () => ({ frozen: false, billingTimezone: s.config.timezone, openingExposure: s.config.openingExposure }));
  let calls = 0, reads = 0;
  const options = { getConfig: () => s.config, adapterFactory: () => ({ async generate(request) {
    calls++; assert.match(request.instructions, /"checkoutSummaryAvailable":true/); return response(); } }),
    readCheckout: async () => { reads++; return summary(); }, readProducts: () => assert.fail("Checkout must not search products") };
  assert.deepEqual(await processAssistantRun(s.run._id, options), { status: "completed" });
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(s.run.attempts.length, 1); assert.equal(s.run.accounting, "settled");
  assert.deepEqual(await processAssistantRun(s.run._id, options), { skipped: true }); assert.equal(calls, 1); assert.equal(reads, 1);
});
