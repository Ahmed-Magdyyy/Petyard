import assert from "node:assert/strict";
import mongoose from "mongoose";

// Preserve real filters, casting, cursors and population, while containing every native read to the fixture manifest.
export function mockSharedCatalogReadBoundaries(t, manifest, checkTarget) {
  assert.equal(manifest.suite, "catalogRead");
  const records = structuredClone(manifest.records), marker = manifest.marker, reads = [];
  const methods = ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "insertOne", "insertMany",
    "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "bulkWrite", "aggregate", "distinct", "countDocuments",
    "estimatedDocumentCount", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "drop", "findAndModify", "mapReduce"];
  for (const Model of Object.values(mongoose.models)) {
    const name = Model.collection.name, ids = records[name];
    for (const method of ["createCollection", "createIndexes", "syncIndexes", "ensureIndexes"]) {
      if (typeof Model[method] === "function") t.mock.method(Model, method, () => { throw new Error("Native catalog read forbids DDL"); });
    }
    for (const method of methods) {
      if (typeof Model.collection[method] !== "function") continue;
      const original = Model.collection[method];
      t.mock.method(Model.collection, method, function (filter, options = {}) {
        checkTarget();
        if (!ids || !["find", "findOne"].includes(method)) throw new Error("Native catalog read forbids writes and unrelated model access");
        assert.ok(filter && typeof filter === "object");
        if (filter._id != null) {
          const selected = filter._id.$in ?? [filter._id];
          assert.ok(Array.isArray(selected) && selected.every((id) => ids.includes(String(id))), "Foreign direct/populated ID refused");
        }
        if (name === "products") {
          assert.equal(method, "find"); assert.ok(options.limit > 0 && options.limit <= 20);
          assert.deepEqual(options.sort, { _id: 1 }); assert.equal(options.maxTimeMS, 5000);
          assert.equal(options.projection?.desc_en, undefined); assert.equal(options.projection?.desc_ar, undefined);
        }
        const scoped = { $and: [filter, { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, assistantTestRun: marker }] };
        reads.push({ name, method, filter, options });
        return original.call(this, scoped, { ...options, maxTimeMS: options.maxTimeMS ?? 5000 });
      });
    }
  }
  return reads;
}
