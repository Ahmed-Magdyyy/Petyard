import test from "node:test";
import assert from "node:assert/strict";
import { createCustomerQueryEmbedder, scrubExpiredQueryVectors } from "../../../src/domains/assistant/customer/assistant.query-embedding.js";
import { externalWorkScope } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { AssistantEmbeddingBatch, assertQueryEmbeddingStore } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { AssistantProviderError } from "../../../src/domains/assistant/providers/providerContract.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { reservationMicroUsd, costMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";

const price = { version: "synthetic-query-price", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
  inputMicroUsdPerMillion: 20000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
const usage = { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const vector = () => Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);

async function fixture(t, input = "How do I care for Milo?") {
  const customer = customerChatFixture(t, input);
  Object.assign(customer.run, { status: "queued", generation: 0, accounting: "none", attempt: null, attempts: [], deadline: new Date(Date.now() + 60000) });
  const scope = await externalWorkScope(customer.run, customer.config, "queued");
  const state = { rows: [], calls: 0, reservations: 0, settlements: 0, held: 0, spent: 0, time: new Date() };
  const document = row => Object.assign(structuredClone(row), { async save() {
    if (state.failSave) throw new Error("fictional settlement persistence failure");
    const copy = { ...this }; delete copy.save; state.rows[state.rows.findIndex(value => value.key === copy.key)] = structuredClone(copy);
  } });
  const query = get => ({ session() { return this; }, then(resolve, reject) { return Promise.resolve().then(get).then(resolve, reject); } });
  const batches = {
    findOne: filter => query(() => { const row = state.rows.find(value => matchesQuery(value, filter)); return row ? document(row) : null; }),
    async create([data]) {
      const model = new AssistantEmbeddingBatch(data); await model.validate();
      const row = { ...model.toObject(), owner: String(data.owner), run: String(data.run), _id: String(model._id) };
      assert.equal(state.rows.some(value => value.key === row.key), false); state.rows.push(structuredClone(row)); return [document(row)];
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of state.rows.filter(row => matchesQuery(row, filter))) {
        for (const key of Object.keys(update.$unset)) delete row[key]; modifiedCount++;
      }
      return { modifiedCount };
    },
  };
  let tail = Promise.resolve();
  t.mock.method(AssistantRun, "updateOne", async (filter, update) => {
    if (state.rejectFence || !matchesQuery(customer.run, filter)) return { modifiedCount: 0 };
    customer.run.queryEmbeddingFence = (customer.run.queryEmbeddingFence ?? 0) + update.$inc.queryEmbeddingFence;
    return { modifiedCount: 1 };
  });
  const embed = createCustomerQueryEmbedder({ batches, ensureStore: async () => {}, now: () => new Date(state.time),
    atomic(callback) {
      const task = tail.then(async () => {
        const before = structuredClone({ rows: state.rows, held: state.held, spent: state.spent, reservations: state.reservations, settlements: state.settlements });
        const fence = customer.run.queryEmbeddingFence;
        try { const result = await callback({ fictional: true }); state.afterCommit?.(); return result; }
        catch (error) { Object.assign(state, before); customer.run.queryEmbeddingFence = fence; throw error; }
      }); tail = task.catch(() => {}); return task;
    }, async reserve(owner, config) {
      if (state.denyBudget) throw Object.assign(new Error("monthly_budget_limit"), { code: "monthly_budget_limit" });
      assert.equal(String(owner), scope.ownerId); const amount = reservationMicroUsd(config);
      state.reservations++; state.held += amount; state.onReserve?.();
      return { amount, budgetIds: ["fictional-month", "fictional-day"], priceVersion: config.price.version };
    }, async settle(row, known) {
      state.settlements++; const amount = costMicroUsd(known, row.config); state.held -= row.reservation.amount; state.spent += amount;
      row.accounting = "settled"; row.usage = known; row.chargedMicroUsd = amount; return true;
    } });
  const args = { run: customer.run, scope, shared: customer.config, retrieval: { enabled: true, price, timeoutMs: 1000 },
    adapter: { ...embeddingProfile, async embed({ input, signal }) {
      state.calls++; assert.equal(state.rows[0].status, "dispatching"); assert.equal(state.rows[0].accounting, "reserved");
      assert.equal(input[0], `Species: cat\nQuestion: ${customer.run.input}`);
      if (state.respond) return state.respond(input, signal);
      return { vectors: [vector()], usage };
    } } };
  return { customer, scope, state, batches, args, run: patch => embed({ ...args, ...patch }) };
}

test("customer query uses the shared executor, persists scope not raw text, and reuses a settled vector", async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.status, "completed"); assert.deepEqual(result.vector, vector()); assert.equal(f.state.reservations, 1);
  assert.equal(f.state.settlements, 1); assert.equal(f.state.held, 0); assert.equal(f.state.spent, 3);
  const receipt = f.state.rows[0]; assert.equal(receipt.kind, "customer_query"); assert.equal(receipt.owner, f.scope.ownerId);
  assert.equal(receipt.run, f.scope.runId); assert.equal(receipt.reference, undefined); assert.equal(receipt.manifestHash, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /How do I care for Milo|Species: cat/);
  assert.deepEqual((await f.run()).vector, result.vector); assert.equal(f.state.calls, 1);
});

test("query reuse rechecks current identity, access and owned request before returning a vector", async t => {
  const f = await fixture(t); await f.run();
  f.customer.account.blocked = true; await assert.rejects(f.run(), { code: "ai_restricted" }); f.customer.account.blocked = false;
  f.customer.chat.contextVersion++; await assert.rejects(f.run(), { code: "context_changed" }); f.customer.chat.contextVersion--;
  f.customer.source.text = "Changed source"; await assert.rejects(f.run(), { code: "context_changed" });
  assert.equal(f.state.calls, 1); assert.equal(f.state.reservations, 1);
});

test("disabled, oversized, mismatched, unfunded and stale queued work cannot dispatch", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ retrieval: { enabled: false } }), { code: "query_embeddings_disabled" });
  await assert.rejects(f.run({ scope: { ...f.scope, query: "A".repeat(2100) } }));
  await assert.rejects(f.run({ scope: { ...f.scope, ownerId: "a".repeat(24) } }), { code: "context_changed" });
  f.state.denyBudget = true; await assert.rejects(f.run(), { code: "monthly_budget_limit" }); f.state.denyBudget = false;
  f.state.rejectFence = true; await assert.rejects(f.run(), { code: "context_changed" });
  assert.equal(f.state.calls, 0); assert.equal(f.state.rows.length, 0); assert.equal(f.state.held, 0);
});

test("fresh guest or revoked user state is rejected by the existing customer work scope", async t => {
  const f = await fixture(t);
  const user = { active: true, phoneVerified: true, role: "guest" };
  t.mock.method(UserModel, "findById", () => ({ select() { return this; }, session() { return this; }, async lean() { return user; } }));
  await assert.rejects(f.run(), { code: "access_denied" }); user.role = "user"; user.active = false;
  await assert.rejects(f.run(), { code: "access_denied" }); assert.equal(f.state.reservations, 0);
});

test("unknown query charges keep their reservation and never automatically replay", async t => {
  const f = await fixture(t); f.state.respond = () => { throw new AssistantProviderError("timeout", { chargeExposure: "unknown" }); };
  assert.equal((await f.run()).status, "uncertain"); assert.ok(f.state.held > 0); assert.equal(f.state.settlements, 0);
  assert.equal((await f.run()).vector, null); assert.equal(f.state.calls, 1); assert.equal(f.state.reservations, 1);
});

test("failed settlement persistence retains the admitted query and prevents a second HTTP attempt", async t => {
  const f = await fixture(t); f.state.failSave = true;
  await assert.rejects(f.run(), /fictional settlement persistence failure/);
  assert.equal(f.state.rows[0].status, "dispatching"); assert.ok(f.state.held > 0);
  assert.equal((await f.run()).status, "dispatching"); assert.equal(f.state.calls, 1);
});

test("concurrent query preparation has one paid execution in the serialized transaction fixture", async t => {
  const f = await fixture(t); let release; const pending = new Promise(resolve => { release = resolve; });
  f.state.respond = async () => { await pending; return { vectors: [vector()], usage }; };
  const first = f.run();
  for (let count = 0; count < 20 && !f.state.calls; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.calls, 1); assert.equal((await f.run()).status, "dispatching"); release();
  assert.equal((await first).status, "completed"); assert.equal(f.state.reservations, 1);
});

test("query-vector expiry scrubs only derived vectors and retains financial suppression records", async t => {
  const f = await fixture(t); await f.run(); const receipt = f.state.rows[0];
  f.state.time = new Date(receipt.vectorsExpireAt.getTime() + 1);
  await assert.rejects(f.run(), { code: "query_embedding_expired" });
  assert.equal(f.state.rows[0].vectors, undefined); assert.equal(f.state.rows[0].accounting, "settled"); assert.equal(f.state.calls, 1);
  const reference = { kind: "reference", vectors: [vector()], vectorsExpireAt: new Date(0) }; f.state.rows.push(reference);
  await scrubExpiredQueryVectors(f.state.time, f.batches); assert.ok(reference.vectors);
});

test("customer query setup requires the existing uniqueness plus the non-TTL expiry lookup index", async t => {
  let indexes = [{ key: { key: 1 }, unique: true }, { key: { kind: 1, vectorsExpireAt: 1 } }];
  t.mock.method(AssistantEmbeddingBatch.collection, "indexes", async () => indexes);
  await assertQueryEmbeddingStore(); indexes = [indexes[0]];
  await assert.rejects(assertQueryEmbeddingStore(), { code: "embedding_store_unavailable" });
});

test("cancellation while reserving rolls back the query receipt and cannot start provider work", async t => {
  const f = await fixture(t), controller = new AbortController(); f.state.onReserve = () => controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { code: "embedding_dispatch_cancelled" });
  assert.equal(f.state.calls, 0); assert.equal(f.state.rows.length, 0); assert.equal(f.state.held, 0); assert.equal(f.state.reservations, 0);
});

test("cancellation after the durable claim settles zero without calling the provider", async t => {
  const f = await fixture(t), controller = new AbortController(); f.state.afterCommit = () => controller.abort();
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.status, "failed"); assert.equal(result.accounting, "settled"); assert.equal(result.vector, null);
  assert.equal(f.state.calls, 0); assert.equal(f.state.settlements, 1); assert.equal(f.state.held, 0); assert.equal(f.state.spent, 0);
});
