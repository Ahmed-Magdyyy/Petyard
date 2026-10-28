import test from "node:test";
import assert from "node:assert/strict";
import { embeddingBillingSnapshot } from "../../../src/domains/assistant/references/assistant.embedding-billing.js";
import { reserveCost, settleCost } from "../../../src/domains/assistant/shared/assistant.store.js";
import { costMicroUsd, reservationMicroUsd, periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";

const now = new Date("2026-10-25T12:00:00Z");
const price = { version: "synthetic-embedding-rate-v1", model: "text-embedding-3-large", dimensions: 1536,
  inputMicroUsdPerMillion: 20000, validFrom: "2026-10-24T00:00:00Z", validUntil: "2026-11-01T00:00:00Z" };
const shared = () => testPolicy({ costMultiplierBasisPoints: 10000 });

// Emulates just the existing ledger predicates/transaction rollback, not native Mongo concurrency.
function ledger(t) {
  const state = { rows: new Map() }, session = { fictional: true };
  const row = id => state.rows.get(id);
  const insert = (id, update) => {
    if (!row(id)) state.rows.set(id, { _id: id, spent: 0, reserved: 0, frozen: false, ...update.$setOnInsert });
    return row(id);
  };
  t.mock.method(AssistantBudget, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(options.session, session); return insert(filter._id, update);
  });
  t.mock.method(AssistantBudget, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, session);
    const record = options.upsert ? insert(filter._id, update) : row(filter._id);
    if (!record || (filter.frozen !== undefined && record.frozen !== filter.frozen) ||
        (filter.reserved?.$gte !== undefined && record.reserved < filter.reserved.$gte) ||
        (filter.$expr && record.spent + record.reserved + filter.$expr.$lte[0].$add[2] > filter.$expr.$lte[1])) return { modifiedCount: 0 };
    for (const [key, amount] of Object.entries(update.$inc ?? {})) record[key] += amount;
    Object.assign(record, update.$set); return { modifiedCount: 1 };
  });
  return { state, session, async atomic(callback) {
    const before = structuredClone(state.rows);
    try { return await callback(session); } catch (error) { state.rows = before; throw error; }
  } };
}

test("embedding snapshot maps input-only billing into the existing ledger without changing chat policy", () => {
  const config = shared(), before = structuredClone(config);
  const result = embeddingBillingSnapshot(config, price, ["Fictional text"], now);
  assert.equal(result.maximumTokens, 8192); assert.equal(result.reservationMicroUsd, 164);
  assert.equal(result.config.maxOutputTokens, 0); assert.equal(result.config.price.outputMicroUsdPerMillion, 0);
  assert.deepEqual(config, before);
  assert.equal(costMicroUsd({ inputTokens: 100, outputTokens: 0 }, result.config), 2);
  assert.equal(result.batchHash.length, 64);
  assert.notEqual(result.batchHash, embeddingBillingSnapshot(config, price, ["Changed text"], now).batchHash);
});

test("expired/mismatched pricing, malformed policy and allowance increases fail closed", () => {
  for (const invalid of [{ ...price, validUntil: "2026-10-25T11:59:59Z" }, { ...price, validFrom: "2026-10-26T00:00:00Z" },
    { ...price, model: "text-embedding-3-small" }, { ...price, dimensions: 3 }, { ...price, inputMicroUsdPerMillion: 0 }]) {
    assert.throws(() => embeddingBillingSnapshot(shared(), invalid, ["Text"], now), { code: "embedding_billing_configuration_required" });
  }
  for (const invalid of [sharedWith({ monthlyBudgetMicroUsd: 50_000_001 }), sharedWith({ openingExposure: {} }),
    sharedWith({ costMultiplierBasisPoints: 9999 }), sharedWith({ dailyBudgetMicroUsd: 1 })]) {
    assert.throws(() => embeddingBillingSnapshot(invalid, price, ["Text"], now), { code: "embedding_billing_configuration_required" });
  }
  assert.throws(() => embeddingBillingSnapshot(shared(), price, ["Text"], new Date("invalid")), { code: "embedding_billing_configuration_required" });
});
const sharedWith = patch => ({ ...shared(), ...patch });

test("actual reserveCost/settleCost share monthly and owner-day entries and settle only once", async t => {
  const memory = ledger(t), config = embeddingBillingSnapshot(shared(), price, ["Text"], now).config;
  const reservation = await memory.atomic(session => reserveCost("fictional-admin", config, session, now));
  const monthId = `global:${periods(config, now).month}`;
  assert.equal(memory.state.rows.get(monthId).reserved, 164);
  const run = { accounting: "reserved", reservation, config };
  const usage = { inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 100 };
  assert.equal(await memory.atomic(session => settleCost(run, usage, session)), true);
  assert.equal(memory.state.rows.get(monthId).spent, 2); assert.equal(memory.state.rows.get(monthId).reserved, 0);
  assert.equal(await memory.atomic(session => settleCost(run, usage, session)), false);
  assert.equal(memory.state.rows.get(monthId).spent, 2);
});

test("unknown embedding usage remains reserved and blocks ordinary chat from exceeding the same ceiling", async t => {
  const memory = ledger(t), policy = shared(), config = embeddingBillingSnapshot(policy, price, ["Text"], now).config;
  const reservation = await memory.atomic(session => reserveCost("fictional-admin", config, session, now));
  const run = { accounting: "reserved", reservation, config };
  assert.equal(await memory.atomic(session => settleCost(run, null, session)), false);
  assert.equal(run.accounting, "reserved");
  const monthId = `global:${periods(config, now).month}`;
  memory.state.rows.get(monthId).spent = policy.monthlyBudgetMicroUsd - reservation.amount;
  await assert.rejects(memory.atomic(session => reserveCost("another-user", policy, session, now)), { code: "monthly_budget_limit" });
  assert.equal(memory.state.rows.get(monthId).reserved, reservation.amount);
  assert.equal(reservationMicroUsd(policy), reservationMicroUsd(shared()));
});

test("unknown charges are not released by rollover or a new pricing snapshot", async t => {
  const memory = ledger(t), config = embeddingBillingSnapshot(shared(), price, ["Text"], now).config;
  const reserved = await memory.atomic(session => reserveCost("fictional-admin", config, session, now));
  const next = new Date("2026-11-01T12:00:00Z");
  const later = embeddingBillingSnapshot(shared(), { ...price, version: "next-synthetic-rate", validUntil: "2026-12-01T00:00:00Z" }, ["Text"], next);
  await memory.atomic(session => reserveCost("fictional-admin", later.config, session, next));
  assert.equal(memory.state.rows.get(reserved.budgetIds[0]).reserved, reserved.amount);
});
