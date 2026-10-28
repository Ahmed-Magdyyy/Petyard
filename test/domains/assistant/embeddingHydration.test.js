import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantEmbeddingBatch } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";

function record(kind) {
  const base = { _id: new mongoose.Types.ObjectId(), key: "a".repeat(64), kind, owner: new mongoose.Types.ObjectId(),
    batchHash: "b".repeat(64), model: "text-embedding-3-small", dimensions: 1536, config: {}, reservation: {},
    status: "dispatching", accounting: "reserved", createdAt: new Date() };
  if (kind === "customer_query") Object.assign(base, { run: new mongoose.Types.ObjectId(), queryContextHash: "c".repeat(64), vectorsExpireAt: new Date() });
  else Object.assign(base, { reference: new mongoose.Types.ObjectId(), sourceHash: "c".repeat(64), manifestHash: "d".repeat(64), start: 0, passageIds: ["e".repeat(64)] });
  return base;
}

test("persisted reference and customer query receipts hydrate without an immutable-default error", () => {
  for (const kind of ["reference", "customer_query"]) {
    const loaded = AssistantEmbeddingBatch.hydrate(record(kind));
    assert.equal(loaded.kind, kind); assert.equal(loaded.validateSync(), undefined);
  }
});

test("actual Mongoose query hydration and later settlement save preserve receipt kind", async t => {
  let stored = record("customer_query"), writes = 0;
  t.mock.method(AssistantEmbeddingBatch.collection, "findOne", async () => stored);
  t.mock.method(AssistantEmbeddingBatch.collection, "updateOne", async (filter, update) => {
    assert.equal(String(filter._id), String(stored._id)); assert.equal(update.$set.kind, undefined);
    Object.assign(stored, update.$set); writes++; return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  const loaded = await AssistantEmbeddingBatch.findById(stored._id); assert.equal(loaded.validateSync(), undefined);
  loaded.accounting = "settled"; loaded.status = "completed"; await loaded.save(); assert.equal(writes, 1);
  assert.equal(stored.kind, "customer_query");
});

test("new receipts default to reference while legacy missing-kind records remain readable and kind stays immutable", () => {
  const initial = record("reference"); delete initial.kind;
  const fresh = new AssistantEmbeddingBatch(initial); assert.equal(fresh.kind, "reference"); assert.equal(fresh.validateSync(), undefined);
  const legacy = AssistantEmbeddingBatch.hydrate(initial); assert.equal(legacy.kind, undefined); assert.equal(legacy.validateSync(), undefined);
  const loaded = AssistantEmbeddingBatch.hydrate(record("customer_query")); loaded.kind = "reference";
  assert.equal(loaded.kind, "customer_query"); assert.ok(loaded.validateSync().errors.kind);
});
