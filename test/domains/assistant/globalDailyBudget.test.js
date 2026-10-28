import test from "node:test";
import assert from "node:assert/strict";
import { AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { reserveCost, settleCost } from "../../../src/domains/assistant/shared/assistant.store.js";
import { periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { testConfig, knownUsage } from "./fixtures/foundationPolicy.js";
import { embeddingBillingSnapshot } from "../../../src/domains/assistant/references/assistant.embedding-billing.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";

test("optional global daily cap is validated and omitted policies preserve existing configuration", () => {
  assert.equal(testConfig().globalDailyBudgetMicroUsd, undefined);
  assert.equal(testConfig({ globalDailyBudgetMicroUsd: 5_000_000 }).globalDailyBudgetMicroUsd, 5_000_000);
  for (const value of [0, -1, 1, 50_000_001, "5000000", 5.5]) {
    assert.throws(() => testConfig({ globalDailyBudgetMicroUsd: value }), { code: "assistant_configuration_required" });
  }
});

test("embedding reservations retain the same optional global daily cap and reject invalid limits", () => {
  const config = testConfig({ globalDailyBudgetMicroUsd: 5_000_000 });
  const price = { version: "synthetic-daily-budget-test", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
    inputMicroUsdPerMillion: 130000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
  const snapshot = embeddingBillingSnapshot(config, price, ["Fictional question"]);
  assert.equal(snapshot.config.globalDailyBudgetMicroUsd, config.globalDailyBudgetMicroUsd);
  assert.equal(embeddingBillingSnapshot(testConfig(), price, ["Fictional question"]).config.globalDailyBudgetMicroUsd, undefined);
  for (const limit of [0, 1, -1, 50_000_001, "5000000"]) {
    assert.throws(() => embeddingBillingSnapshot({ ...config, globalDailyBudgetMicroUsd: limit }, price, ["Fictional question"]),
      { code: "embedding_billing_configuration_required" });
  }
});

test("different owners share the daily reservation cap and settlement releases its held amount", async t => {
  const config = testConfig({ globalDailyBudgetMicroUsd: 5_000_000 });
  const now = new Date("2026-10-28T10:00:00Z"), session = {}, rows = new Map();
  t.mock.method(AssistantBudget, "findOneAndUpdate", async (_filter, _update, options) => {
    assert.equal(options.session, session);
    return { frozen: false, billingTimezone: config.timezone, openingExposure: config.openingExposure };
  });
  t.mock.method(AssistantBudget, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, session);
    if (update.$setOnInsert) {
      if (!rows.has(filter._id)) rows.set(filter._id, { spent: update.$setOnInsert.spent, reserved: 0 });
      return { modifiedCount: 1 };
    }
    const row = rows.get(filter._id);
    if (filter.$expr) {
      const [expression, limit] = filter.$expr.$lte;
      if (row.spent + row.reserved + expression.$add[2] > limit) return { modifiedCount: 0 };
    } else if (row.reserved < filter.reserved.$gte) return { modifiedCount: 0 };
    for (const [key, value] of Object.entries(update.$inc)) row[key] += value;
    return { modifiedCount: 1 };
  });
  const first = await reserveCost("first-owner", config, session, now);
  const second = await reserveCost("second-owner", config, session, now);
  const dailyId = `global-day:${periods(config, now).day}`;
  assert.equal(first.budgetIds[1], dailyId);
  assert.equal(second.budgetIds[1], dailyId);
  assert.equal(rows.get(dailyId).reserved, first.amount + second.amount);
  await assert.rejects(reserveCost("third-owner", config, session, now), { code: "daily_spending_limit" });
  const run = { accounting: "reserved", reservation: first, config };
  assert.equal(await settleCost(run, knownUsage, session), true);
  assert.equal(rows.get(dailyId).reserved, second.amount);
  assert.ok(rows.get(dailyId).spent > 0);
  assert.equal(await settleCost(run, knownUsage, session), false);
  assert.notEqual(`global-day:${periods(config, new Date("2026-10-29T10:00:00Z")).day}`, dailyId);
});
