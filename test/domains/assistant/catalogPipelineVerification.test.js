import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { assertCatalogPipelineCardinality } from "./fixtures/catalogPipelineVerification.js";

function fixture(t) {
  const manifest = createSharedMongoManifest("catalogPipeline"), calls = [], changed = { value: false };
  t.mock.method(mongoose, "connect", () => assert.fail("Offline cardinality regression must not connect"));
  t.mock.method(mongoose.mongo.Collection.prototype, "aggregate", () => assert.fail("Aggregation must remain forbidden"));
  t.mock.method(mongoose.mongo.Collection.prototype, "countDocuments", () => assert.fail("Cardinality must not call countDocuments"));
  const rows = Object.fromEntries(Object.entries(manifest.records).map(([name, ids]) => [name, ids.map((id) => ({
    _id: new mongoose.Types.ObjectId(id), assistantTestRun: manifest.marker,
  }))]));
  const target = { check() { assert.equal(changed.value, false, "target changed"); }, db: { collection(name) {
    return { find(filter, options) {
      calls.push({ name, filter, options });
      return { async toArray() { return rows[name].filter((row) => row.assistantTestRun === filter.assistantTestRun &&
        filter._id.$in.some((id) => String(id) === String(row._id))).slice(0, options.limit).map(({ _id }) => ({ _id })); } };
    } };
  } } };
  return { manifest, calls, rows, target, changed };
}

test("native final cardinality uses bounded exact-ID/marker projected reads for all 15 stores including empty sets", async (t) => {
  const f = fixture(t);
  // Neither an unrelated row sharing the marker nor a wrong-marker row may satisfy the count.
  f.rows.users.push({ _id: new mongoose.Types.ObjectId(), assistantTestRun: f.manifest.marker });
  f.rows.users.push({ _id: f.rows.users[0]._id, assistantTestRun: "other-marker" });
  await assertCatalogPipelineCardinality(f.target, f.manifest);
  assert.equal(f.calls.length, 15);
  for (const call of f.calls) {
    assert.deepEqual(call.filter._id.$in.map(String), f.manifest.records[call.name]);
    assert.equal(call.filter.assistantTestRun, f.manifest.marker);
    assert.deepEqual(call.options, { projection: { _id: 1 }, limit: f.manifest.records[call.name].length + 1, maxTimeMS: 5000 });
    assert.ok(call.filter._id.$in.every((id) => id instanceof mongoose.Types.ObjectId));
  }
  assert.equal(f.calls.filter((call) => call.filter._id.$in.length === 0).length, 5);
});

test("native cardinality still rejects a missing or wrong-marker fixture and refuses a changed target before I/O", async (t) => {
  const f = fixture(t); f.rows.users[0].assistantTestRun = "wrong-marker";
  await assert.rejects(assertCatalogPipelineCardinality(f.target, f.manifest), /cardinality differs in users/);
  f.rows.users.shift();
  await assert.rejects(assertCatalogPipelineCardinality(f.target, f.manifest), /cardinality differs in users/);
  f.calls.length = 0; f.changed.value = true;
  await assert.rejects(assertCatalogPipelineCardinality(f.target, f.manifest), /target changed/); assert.equal(f.calls.length, 0);
});
