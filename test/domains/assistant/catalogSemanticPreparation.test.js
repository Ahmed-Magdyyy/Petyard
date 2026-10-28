import test from "node:test";
import assert from "node:assert/strict";
import { prepareProductSearch } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { readAssistantCatalog } from "../../../src/domains/assistant/products/assistant.catalog-read.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { structuredReply, knownUsage, testConfig } from "./fixtures/foundationPolicy.js";

const warehouse = "1".repeat(24), query = "a scratching surface";
const result = () => ({ usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], structured: structuredReply({ reply: "",
  productSearch: { action: "pet", query, minimumPackageWeightGrams: null, maximumPriceMinor: null, options: [], sourceQuote: "" } }) });
const policy = { productSearchEnabled: true, catalogSemanticEnabled: true, catalogSemanticMinimumScore: 0.8 };
test("current owned shopping preparation binds semantic work to the same request and warehouse", async t => {
  const f = customerChatFixture(t, "Show me a scratching surface", policy); let received;
  const batch = await prepareProductSearch(f.prepared, result(), f.config, { context: { warehouseId: warehouse, language: "en" },
    readProducts: async (input, config, options) => {
      assert.equal(config, f.config); assert.equal(input.warehouseId, warehouse);
      await options.semanticCandidates({ warehouseId: warehouse, query }); return { status: "empty", products: [] };
    }, readSemantic: async value => { received = value; return []; } });
  assert.equal(received.request.binding, batch.binding); assert.equal(received.run._id, f.prepared.run._id);
  assert.equal(received.request.warehouseId, warehouse); assert.equal(received.request.species, "cat");
  assert.equal(received.signal.aborted, true, "Completed preparation closes any unused external work");
});
test("a lookup cannot substitute another warehouse for its paid semantic callback", async t => {
  const f = customerChatFixture(t, "Show toys", policy);
  const batch = await prepareProductSearch(f.prepared, result(), f.config, { context: { warehouseId: warehouse, language: "en" },
    readProducts: async (_input, _config, options) => options.semanticCandidates({ warehouseId: "2".repeat(24), query }),
    readSemantic: () => assert.fail("Must not dispatch") });
  assert.equal(batch.result.status, "unavailable");
});
test("missing location leaves the existing location flow without semantic work", async t => {
  const f = customerChatFixture(t, "Show toys", policy);
  const batch = await prepareProductSearch(f.prepared, result(), f.config, { context: { warehouseId: null, language: "en" }, readProducts: readAssistantCatalog,
    readSemantic: () => assert.fail("Missing warehouse must not pay") });
  assert.equal(batch.result.status, "needs_location");
});
test("the existing tool timeout aborts semantic work rather than leaving another dispatch", async t => {
  const f = customerChatFixture(t, "Show toys", { ...policy, timeoutMs: 20 }); let signal;
  await assert.rejects(prepareProductSearch(f.prepared, result(), f.config, { context: { warehouseId: warehouse, language: "en" },
    readProducts: async (_input, _config, options) => {
      signal = options.signal; await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      return { status: "empty", products: [] };
    } }), { code: "product_search_timeout" });
  assert.equal(signal.aborted, true);
});
test("semantic policy is explicit, bounded and included in the existing configuration signature", () => {
  for (const overrides of [{ catalogSemanticEnabled: "true" }, { catalogSemanticEnabled: true, productSearchEnabled: true },
    { ...policy, catalogSemanticMinimumScore: -0.1 }, { ...policy, catalogSemanticMinimumScore: 1.1 }, { ...policy, productSearchEnabled: false }])
    assert.throws(() => testConfig(overrides));
  assert.notEqual(testConfig(policy).signature, testConfig({ ...policy, catalogSemanticMinimumScore: 0.9 }).signature);
  assert.equal(testConfig().catalogSemanticEnabled, undefined);
});
