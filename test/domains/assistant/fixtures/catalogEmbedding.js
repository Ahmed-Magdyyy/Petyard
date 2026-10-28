import assert from "node:assert/strict";
import { AssistantEmbeddingBatch } from "../../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { costMicroUsd, reservationMicroUsd } from "../../../../src/domains/assistant/shared/assistant.config.js";
import { matchesQuery } from "./matchesQuery.js";

export const catalogPrice = { version: "fictional-catalog-price", model: "text-embedding-3-large", dimensions: 1536,
  inputMicroUsdPerMillion: 130000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
export const catalogUsage = { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
export const catalogVector = () => Array.from({ length: 1536 }, (_, i) => i === 0 ? 0.5 : 0);

// Serialized rollback fixture exercises the production executor/schema; it is not native transaction proof.
export function catalogEmbeddingLedger() {
  const state = { rows: [], held: 0, spent: 0, reserved: 0, settled: 0 }; let tail = Promise.resolve();
  function document(row) {
    return Object.assign(structuredClone(row), { async save() {
      if (state.failSave) throw Error("Fictional persistence failure");
      const { save, ...value } = this;
      state.rows[state.rows.findIndex(item => item.key === value.key)] = structuredClone(value);
    } });
  }
  const query = read => ({ session() { return this; }, then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  const batches = {
    findOne: filter => query(() => { const row = state.rows.find(item => matchesQuery(item, filter)); return row ? document(row) : null; }),
    async create([data]) {
      const model = new AssistantEmbeddingBatch(data); await model.validate();
      const row = { ...model.toObject(), _id: String(model._id), owner: String(data.owner),
        ...(data.run ? { run: String(data.run) } : {}), ...(data.sourceId ? { sourceId: String(data.sourceId) } : {}) };
      assert.equal(state.rows.some(item => item.key === row.key), false); state.rows.push(structuredClone(row)); return [document(row)];
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of state.rows.filter(item => matchesQuery(item, filter))) {
        for (const key of Object.keys(update.$unset)) delete row[key]; modifiedCount++;
      }
      return { modifiedCount };
    },
  };
  const execution = {
    batches,
    atomic(callback) {
      const next = tail.then(async () => {
        const before = structuredClone({ rows: state.rows, held: state.held, spent: state.spent, reserved: state.reserved, settled: state.settled });
        try { const result = await callback({ fictional: true }); state.afterCommit?.(); return result; }
        catch (error) { Object.assign(state, before); throw error; }
      }); tail = next.catch(() => {}); return next;
    },
    async reserve(_owner, config) {
      if (state.denyBudget) throw Object.assign(Error("monthly_budget_limit"), { code: "monthly_budget_limit" });
      const amount = reservationMicroUsd(config); state.reserved++; state.held += amount; state.onReserve?.();
      return { amount, budgetIds: ["fictional-shared-month", "fictional-owner-day"], priceVersion: config.price.version };
    },
    async settle(row, usage) {
      const amount = costMicroUsd(usage, row.config); assert.notEqual(amount, null);
      state.settled++; state.held -= row.reservation.amount; state.spent += amount;
      row.accounting = "settled"; row.chargedMicroUsd = amount; row.usage = usage; return true;
    },
  };
  return { state, batches, execution };
}
