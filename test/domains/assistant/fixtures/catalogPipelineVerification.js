import assert from "node:assert/strict";
import mongoose from "mongoose";

// countDocuments internally aggregates, which the native pipeline boundary deliberately forbids.
export async function assertCatalogPipelineCardinality(target, manifest) {
  assert.equal(manifest.suite, "catalogPipeline");
  for (const [name, registered] of Object.entries(manifest.records)) {
    target.check();
    const rows = await target.db.collection(name).find({
      _id: { $in: registered.map((id) => new mongoose.Types.ObjectId(id)) }, assistantTestRun: manifest.marker,
    }, { projection: { _id: 1 }, limit: registered.length + 1, maxTimeMS: 5000 }).toArray();
    assert.equal(rows.length, registered.length, `Registered fixture cardinality differs in ${name}`);
  }
}
