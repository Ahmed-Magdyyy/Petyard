import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { prepareProductSearch } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { readAssistantCatalog } from "../../../src/domains/assistant/products/assistant.catalog-read.js";
import { productSearchBinding, productSearchIntent } from "../../../src/domains/assistant/products/assistant.product-search.js";
import { outputSchema, validateResult } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { validateObject } from "../../../src/domains/assistant/providers/providerContract.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { structuredReply, knownUsage } from "./fixtures/foundationPolicy.js";

const W = "111111111111111111111111";
const search = (changes = {}) => ({ action: "pet", query: "cat toy", minimumPackageWeightGrams: null,
  maximumPriceMinor: null, sourceQuote: "", options: [], ...changes });
const result = (changes = {}) => ({ structured: structuredReply({ reply: "", productSearch: search(), ...changes }),
  finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage });

test("scripted Egyptian/Arabizi/English shopping intents reach only an owned context and make no publication/financial writes", async (t) => {
  for (const input of ["عايز لعبة لقطتي", "3ayez le3ba lel 2ott", "I want a cat toy"]) {
    await t.test(input, async (t) => {
      const state = customerChatFixture(t, input); let received;
      const prepared = await prepareProductSearch(state.prepared, result(), state.config, {
        context: { warehouseId: W, language: "ar" }, readProducts: async (value) => { received = value; return { status: "results", products: [] }; },
      });
      assert.equal(received.subject.id, state.subject.id); assert.equal(received.subject.name, "Milo");
      assert.equal(received.warehouseId, W); assert.equal(received.query, "cat toy");
      assert.equal(prepared.binding, productSearchBinding(state.run, prepared.intent, prepared.context, null));
      assert.equal(state.messages.length, 0); assert.equal(state.events.length, 0); assert.equal(state.budgetUpdates.length, 0); assert.equal(state.saves, 0);
      assert.equal(state.run.status, "dispatching"); assert.equal(state.run.attempts.length, 1);
    });
  }
});

test("general intent cannot discard selected-pet warnings, including an explicit new warning from this same turn", async (t) => {
  const state = customerChatFixture(t, "Milo has a food allergy; show toys");
  state.warnings.push({ subjectId: state.subject.id, state: "active", text: "Previously reported risk", owner: state.run.owner });
  state.warnings.push({ subjectId: `pet:${W}`, state: "active", text: "Foreign pet risk", owner: state.run.owner });
  let received;
  const answer = result({ ...state.report(), scope: "petyard", reply: "", productSearch: search({ action: "general" }) });
  const batch = await prepareProductSearch(state.prepared, answer, state.config, { readProducts: async (value) => {
    received = value; return { status: "results", products: [] };
  } });
  assert.equal(received.subject.id, state.subject.id);
  assert.deepEqual(received.warnings.map((warning) => warning.text), ["Previously reported risk", state.run.input]);
  assert.equal(state.warnings.length, 2, "same-turn warning is only a conservative temporary observation at this stage");
  assert.ok(batch.binding); assert.equal(state.events.length, 0);
});

test("exact filters reach the read unchanged and an unverified result never triggers a loose retry; missing subject skips the read", async (t) => {
  const state = customerChatFixture(t, "عايز دراي فود للكلب 3 كيلو على الأقل وفي حدود 1000 جنيه Chicken");
  const constrained = result({ productSearch: search({ query: "dog dry food", minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000,
    sourceQuote: state.run.input, options: [{ name: "flavor", value: "Chicken", sourceQuote: "Chicken" }] }) });
  assert.doesNotThrow(() => validateObject(outputSchema, constrained.structured));
  let calls = 0;
  const batch = await prepareProductSearch(state.prepared, constrained, state.config, { readProducts: async (input) => {
    calls++; assert.equal(input.query, "dog dry food");
    assert.deepEqual(input.filters, { minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000,
      options: [{ name: "flavor", value: "Chicken", sourceQuote: "Chicken" }] });
    assert.equal(input.subject.id, state.subject.id);
    return { status: "needs_verified_filters", products: [] };
  } });
  assert.equal(calls, 1);
  assert.equal(batch.result.status, "needs_verified_filters"); assert.equal(batch.intent.filters.minimumPackageWeightGrams, 3000);
  assert.equal(batch.intent.filters.maximumPriceMinor, 100000); assert.deepEqual(batch.result.products, []);
  state.run.subjectId = null; state.run.subjectFingerprint = null; state.source.subjectId = null; state.prepared.run = { ...state.run };
  const unbound = await prepareProductSearch(state.prepared, result(), state.config, { readProducts: () => assert.fail("Pet must be resolved") });
  assert.equal(unbound.result.status, "needs_subject");
});

test("flavor/color/size/piece requests remain sourced variant constraints, not silently dropped keywords", () => {
  const input = "I need red in size XL";
  const data = result({ productSearch: search({ sourceQuote: input, options: [
    { name: "color", value: "red", sourceQuote: "red" }, { name: "size", value: "XL", sourceQuote: "size XL" },
  ] }) }).structured;
  validateObject(outputSchema, data);
  const intent = productSearchIntent(data, { input, subjectId: null }); assert.equal(intent.constrained, true);
  assert.deepEqual(intent.filters.options.map((option) => option.value), ["red", "XL"]);
  data.productSearch.options[0].value = "blue";
  assert.throws(() => productSearchIntent(data, { input, subjectId: null }), { code: "invalid_product_search" });
});

test("unconstrained pet/general shopping rejects case5's quote without silently clearing it in any language", () => {
  for (const input of ["warreeni le3ab lel 2otat le Milo, ma3andish budget mo3ayan.",
    "وريني ألعاب للقطط من غير سعر معين.", "Show cat toys; I have no specified budget."]) {
    for (const action of ["pet", "general"]) {
      const data = result({ productSearch: search({ action, sourceQuote: input }) }).structured;
      assert.throws(() => productSearchIntent(data, { input, subjectId: null }), { code: "invalid_product_search" });
      assert.equal(data.productSearch.sourceQuote, input);
      const corrected = result({ productSearch: search({ action }) }).structured;
      assert.equal(productSearchIntent(corrected, { input, subjectId: null }).constrained, false);
    }
  }
});

test("numeric and option constraints still require exact source evidence", () => {
  const input = "pink toys, at least 3 kg, up to EGP 300";
  for (const filter of [{ minimumPackageWeightGrams: 3000 }, { maximumPriceMinor: 30000 },
    { options: [{ name: "color", value: "pink", sourceQuote: "pink" }] }]) {
    const data = result({ productSearch: search(filter) }).structured;
    assert.throws(() => productSearchIntent(data, { input, subjectId: null }), { code: "invalid_product_search" });
    data.productSearch.sourceQuote = "Not in the user message";
    assert.throws(() => productSearchIntent(data, { input, subjectId: null }), { code: "invalid_product_search" });
    data.productSearch.sourceQuote = input;
    assert.equal(productSearchIntent(data, { input, subjectId: null }).constrained, true);
  }
});

test("unknown usage, unsupported tier, urgent scope, switching and uncertain warnings never reach lookup", async (t) => {
  const state = customerChatFixture(t);
  for (const response of [{ ...result(), usage: null }, { ...result(), serviceTier: "unverified" },
    result({ scope: "urgent" }), result({ subjectAction: "create_unsaved" }), result({ subjectAction: "clarify" }),
    result({ dietaryWarningAction: "clarify" })]) {
    assert.equal(await prepareProductSearch(state.prepared, response, state.config, { readProducts: () => assert.fail("Must not search") }), null);
  }
  await assert.rejects(prepareProductSearch({ ...state.prepared, run: { ...state.run, purpose: "admin_business" } }, result(), state.config), { code: "run_not_found" });
});

test("original source, current ownership, access, attempt and profile fences are required", async (t) => {
  const state = customerChatFixture(t); const options = { readProducts: () => assert.fail("Invalid scope cannot search") };
  state.source.text = "Different input";
  await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, options), { code: "context_changed" });
  state.source.text = state.run.input; state.account.blocked = true;
  await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, options), { code: "ai_restricted" });
  state.account.blocked = false; state.prepared.run.attempt = "wrong-attempt";
  await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, options), { code: "context_changed" });
  state.prepared.run.attempt = state.run.attempt; state.pet.petOwner = new mongoose.Types.ObjectId();
  await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, options), { code: "subject_not_found" });
});

test("access revocation or profile edits during lookup discard its outcome", async (t) => {
  for (const change of ["blocked", "profile"]) {
    await t.test(change, async (t) => {
      const state = customerChatFixture(t);
      await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, { readProducts: async () => {
        if (change === "blocked") state.account.blocked = true; else state.pet.name = "Changed name";
        return { status: "results", products: [] };
      } }), { code: change === "blocked" ? "ai_restricted" : "context_changed" });
      assert.equal(state.messages.length, 0); assert.equal(state.budgetUpdates.length, 0);
    });
  }
});

test("the real helper reports missing location without warehouse/product queries", async (t) => {
  const state = customerChatFixture(t);
  const batch = await prepareProductSearch(state.prepared, result(), state.config, { readProducts: readAssistantCatalog });
  assert.equal(batch.result.status, "needs_location"); assert.equal(batch.context.warehouseId, null);
});

test("bounded wait rejects a slow lookup without publication, paid retry or accepting its late outcome", async (t) => {
  const state = customerChatFixture(t, "cat toy", { timeoutMs: 20 }); let release;
  const lookup = new Promise((resolve) => { release = resolve; });
  await assert.rejects(prepareProductSearch(state.prepared, result(), state.config, { readProducts: () => lookup }), { code: "product_search_timeout" });
  release({ status: "results", products: [] }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.messages.length, 0); assert.equal(state.budgetUpdates.length, 0); assert.equal(state.run.attempts.length, 1);
});

test("current chat cannot publish invented search prose; malformed constraints fail before lookup", async (t) => {
  const state = customerChatFixture(t);
  const invented = result({ reply: "I found and bought this invented product" });
  assert.throws(() => validateResult(invented, state.run, state.config, state.prepared.allowedSubjects), { code: "product_search_unavailable" });
  const finished = await state.finish(invented.structured);
  assert.equal(finished.status, "failed"); assert.equal(state.messages.length, 0); assert.equal(finished.accounting, "settled");
  for (const extra of [{ maximumPriceMinor: -1 }, { minimumPackageWeightGrams: "3000" }, { variantId: "invented" },
    { maximumPriceMinor: 100000, sourceQuote: "invented limit" }, { action: "none", query: "not empty" }]) {
    await assert.rejects(prepareProductSearch(state.prepared, result({ productSearch: search(extra) }), state.config));
  }
});
