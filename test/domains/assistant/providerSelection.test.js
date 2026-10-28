import test from "node:test";
import assert from "node:assert/strict";
import { getAssistantModelProfile, hasAssistantCredentials, createAssistantAdapter } from "../../../src/domains/assistant/providers/assistantProvider.js";
import { openaiLunaProfile } from "../../../src/domains/assistant/providers/openaiProfile.js";
import { costMicroUsd, reservationMicroUsd, loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { testConfig, testPolicy, knownUsage } from "./fixtures/foundationPolicy.js";

const forbiddenSecrets = new Proxy({}, { get() { throw new Error("Unexpected credential read"); } });

test("provider/model selection admits only explicit immutable profiles", () => {
  assert.equal(getAssistantModelProfile("openai", "gpt-6-luna"), openaiLunaProfile);
  assert.ok(Object.isFrozen(openaiLunaProfile)); assert.ok(Object.isFrozen(openaiLunaProfile.reasoningEfforts));
  assert.throws(() => { openaiLunaProfile.contextWindowTokens = 1; }, TypeError);
  for (const value of ["constructor", "__proto__", "toString", "unapproved", null, { toString: 1 }]) {
    assert.equal(getAssistantModelProfile(value, "gpt-6-luna"), null);
    assert.equal(getAssistantModelProfile("openai", value), null);
  }
});

test("shared factory selects the approved adapter without exposing its server credential", () => {
  const config = testConfig(); const secret = "synthetic-provider-factory-key";
  const env = new Proxy({}, { get(_target, key) { assert.equal(key, "OPENAI_API_KEY"); return secret; } });
  assert.equal(hasAssistantCredentials(config, env), true);
  const adapter = createAssistantAdapter(config, env);
  assert.equal(adapter.provider, config.provider); assert.equal(adapter.model, config.model);
  assert.equal(typeof adapter.generate, "function");
  assert.equal(JSON.stringify(adapter).includes(secret), false); assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal(hasAssistantCredentials(config, { OPENAI_API_KEY: "   " }), false);
  assert.throws(() => createAssistantAdapter(config, {}), { code: "missing_credentials" });
});

test("disabled or unsupported selections cannot read credentials or construct an adapter", () => {
  const disabled = new Proxy({ enabled: false }, { get(target, key) { assert.equal(key, "enabled"); return target[key]; } });
  assert.throws(() => createAssistantAdapter(disabled, forbiddenSecrets), { code: "assistant_disabled" });
  for (const config of [{ enabled: true, provider: "unknown", model: "gpt-6-luna" },
    { enabled: true, provider: "openai", model: "unapproved" }]) {
    assert.equal(hasAssistantCredentials(config, forbiddenSecrets), false);
    assert.throws(() => createAssistantAdapter(config, forbiddenSecrets), { code: "unsupported_model" });
  }
});

test("configuration still refuses unsupported models, forged billing bounds and unsupported reasoning before credentials", () => {
  for (const patch of [{ provider: "unknown" }, { model: "unapproved" }, { model: { toString: 1 } }, { reasoningEffort: "high" },
    { price: { ...testPolicy().price, contextWindowTokens: 1000 } }]) {
    const env = new Proxy({ ASSISTANT_ENABLED: "true", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy(patch)) }, {
      get(target, key) { assert.notEqual(key, "OPENAI_API_KEY"); return target[key]; },
    });
    assert.throws(() => loadAssistantConfig(env), { code: "assistant_configuration_required" });
  }
});

test("historical billing uses the run snapshot even when its provider/model is no longer selectable", () => {
  const config = testConfig();
  const historical = JSON.parse(JSON.stringify({ ...config, provider: "retired-provider", model: "retired-model",
    price: { ...config.price, contextWindowTokens: 1000 } }));
  assert.equal(getAssistantModelProfile(historical.provider, historical.model), null);
  assert.equal(reservationMicroUsd(historical), 4453);
  assert.equal(costMicroUsd(knownUsage, historical), 198);
  assert.equal(costMicroUsd({ ...knownUsage, inputTokens: 1001 }, historical), null);
  const future = { ...config, price: { ...config.price, inputMicroUsdPerMillion: 9_000_000 } };
  assert.notEqual(costMicroUsd(knownUsage, future), costMicroUsd(knownUsage, historical));
  assert.equal(reservationMicroUsd(historical), 4453); assert.equal(costMicroUsd(knownUsage, historical), 198);
  assert.equal(reservationMicroUsd(config), 2312253, "existing Luna reservation remains unchanged");
});

test("invalid historical billing bounds leave usage unknown and prevent a new reservation", () => {
  const config = testConfig();
  for (const contextWindowTokens of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const historical = { ...config, price: { ...config.price, contextWindowTokens } };
    assert.equal(costMicroUsd(knownUsage, historical), null);
    assert.throws(() => reservationMicroUsd(historical), { code: "assistant_accounting_unavailable" });
  }
});
