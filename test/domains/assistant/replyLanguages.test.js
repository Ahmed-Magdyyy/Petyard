import test from "node:test";
import assert from "node:assert/strict";
import { instructions, outputSchema, validateResult, dietaryWarningClarification } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { subjectClarification } from "../../../src/domains/assistant/customer/assistant.subjects.js";
import { renderCatalogResponse } from "../../../src/domains/assistant/products/assistant.product-cards.js";
import { catalogIntentCases } from "./fixtures/catalogIntentCases.js";
import { buildCatalogIntentRequest } from "./fixtures/catalogIntentRequest.js";
import { testConfig, structuredReply } from "./fixtures/foundationPolicy.js";

test("English and Arabic are the only output languages while Arabizi inputs retain their meaning requirements", async () => {
  assert.deepEqual(outputSchema.properties.replyLanguage.enum, ["ar", "en"]);
  assert.match(instructions, /Reply in English to English input/);
  assert.match(instructions, /Egyptian Arabic written in Arabic script to Arabic or Arabizi input/);
  assert.match(instructions, /Understanding Arabizi remains required: preserve meaning, negation and pet references/);
  assert.match(instructions, /Keep verbatim evidence and quote fields in the user's original wording and script/);
  for (const fixture of catalogIntentCases) {
    assert.equal(fixture.replyLanguage, fixture.language === "en" ? "en" : "ar");
    const { request } = await buildCatalogIntentRequest(fixture);
    assert.ok(request.instructions.startsWith(instructions));
    assert.deepEqual(request.outputSchema.properties.replyLanguage.enum, ["ar", "en"]);
    assert.equal(request.messages.at(-1).content, fixture.input);
  }
});

test("fixed safety and scope replies use the validated output language even when Arabizi input has no Arabic characters", () => {
  const run = { input: "Milo mesh 2ader yetnaffas", subjectId: "pet:111111111111111111111111" };
  const config = testConfig();
  for (const scope of ["identity", "health", "urgent", "off_topic"]) {
    for (const replyLanguage of ["ar", "en"]) {
      const result = { structured: structuredReply({ scope, replyLanguage }), finishReason: "completed", toolCalls: [] };
      const reply = validateResult(result, run, config, []).reply;
      assert.equal(/\p{Script=Arabic}/u.test(reply), replyLanguage === "ar", scope);
      if (scope === "urgent") assert.match(reply, replyLanguage === "ar" ? /فورًا/ : /immediate/);
    }
  }
  assert.throws(() => validateResult({ structured: structuredReply({ replyLanguage: "arabizi" }),
    finishReason: "completed", toolCalls: [] }, run, config, []), { code: "invalid_structured_output" });
});

test("clarification and catalog helpers render Arabic for legacy Arabizi language arguments", () => {
  for (const render of [subjectClarification, dietaryWarningClarification,
    (language) => renderCatalogResponse({ status: "needs_subject" }, language)]) {
    assert.equal(render("arabizi"), render("ar"));
    assert.match(render("ar"), /\p{Script=Arabic}/u);
    assert.doesNotMatch(render("en"), /\p{Script=Arabic}/u);
  }
});

test("an Arabic reply preserves the user's exact Arabizi evidence for memory", () => {
  const input = "3ayez afkar le3b baseeta ma3 Milo fel beit";
  const run = { input, subjectId: "pet:111111111111111111111111" };
  const result = { structured: structuredReply({ reply: "ممكن تلعب معاه بكرة مناسبة وتراقبه.", replyLanguage: "ar",
    memoryKey: "discussion_summary", memorySubjectId: run.subjectId, memoryValue: input, sourceQuote: input }),
  finishReason: "completed", toolCalls: [] };
  const valid = validateResult(result, run, testConfig(), [run.subjectId]);
  assert.equal(valid.reply, result.structured.reply);
  assert.equal(valid.memory.value, input);
  assert.equal(valid.memory.sourceQuote, input);
});
