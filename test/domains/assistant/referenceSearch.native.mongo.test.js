import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { nativeIndexDefinition } from "./fixtures/automaticBundleNative.js";
import { searchPilotOptIn, validateSearchPilotPlan, searchPilotConnection, verifySearchPilotEmpty,
  searchPilotMarker, assertSearchPilotOwned, buildSearchPilotFixtures, countTestClusterSearchIndexes, assertOwnedSearchPilotIndex } from "./fixtures/referenceSearchPilot.js";

test("isolated actual reference Vector Search coverage and filtering", {
  skip: process.env.ASSISTANT_SEARCH_NATIVE_TEST !== searchPilotOptIn && "Prepared only; exact index/setup/run/cleanup requires approval",
  timeout: 600000,
}, async t => {
  const plan = validateSearchPilotPlan(JSON.parse(await readFile(process.env.ASSISTANT_SEARCH_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SEARCH_NATIVE_URI, sharedMongoConfirmation);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  const refuse = () => { throw Error("Provider/storage/push HTTP is outside the Search pilot"); };
  t.mock.method(globalThis, "fetch", refuse);
  for (const module of [http, https]) for (const method of ["request", "get"]) t.mock.method(module, method, refuse);
  let claimed = false, inserts = 0;
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
      retryWrites: false, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000, socketTimeoutMS: 10000 });
    const { db, check } = searchPilotConnection(mongoose.connection, plan);
    await verifySearchPilotEmpty(mongoose.connection, plan);
    const capacity = await countTestClusterSearchIndexes(mongoose.connection, plan);
    assert.ok(capacity.indexes < 3, "No free Search slot; existing indexes must never be changed");
    assert.ok(capacity.collections + 3 <= 500); t.diagnostic(`search_native_capacity=${JSON.stringify(capacity)}`);
    await db.createCollection("assistanttestownership", { maxTimeMS: 5000 });
    await db.collection("assistanttestownership").insertOne(searchPilotMarker(plan)); inserts++; claimed = true;
    const owned = () => assertSearchPilotOwned(mongoose.connection, plan);
    const { AssistantReference } = await import("../../../src/domains/assistant/references/assistant.reference.model.js");
    const { AssistantReferencePassage, assertReferenceVectorIndex, referenceVectorIndex } = await import("../../../src/domains/assistant/references/assistant.reference-passage.model.js");
    const { createReferenceCoverageVerifier } = await import("../../../src/domains/assistant/references/assistant.reference-coverage.js");
    const { createApprovedReferenceSearch } = await import("../../../src/domains/assistant/references/assistant.reference-search.js");
    assert.deepEqual(plan.index, referenceVectorIndex);
    assert.deepEqual(plan.normalIndexes, Object.fromEntries([AssistantReference, AssistantReferencePassage].map(model =>
      [model.collection.name, model.schema.indexes().map(([key, options]) => nativeIndexDefinition(key, options))])));
    for (const model of [AssistantReference, AssistantReferencePassage]) {
      await owned(); await db.createCollection(model.collection.name, { maxTimeMS: 5000 });
      for (const [key, options] of model.schema.indexes()) { await owned(); await db.collection(model.collection.name).createIndex(key, { ...options, maxTimeMS: 5000 }); }
    }
    const f = await buildSearchPilotFixtures(plan.run), collection = db.collection("assistantreferencepassages");
    for (const [model, rows] of [[AssistantReference, f.references.map(row => row.source)], [AssistantReferencePassage, f.passages]]) {
      for (const row of rows) {
        assert.equal(new model(row).validateSync(), undefined); await owned();
        assert.ok(++inserts <= plan.maxInsertAttempts); await db.collection(model.collection.name).insertOne({ ...row, fixtureRun: plan.run }); check();
      }
    }
    await owned(); assert.deepEqual(await collection.listSearchIndexes().toArray(), []);
    await collection.createSearchIndex(plan.index); check();
    const pause = () => new Promise(resolve => setTimeout(resolve, 5000));
    const passed = name => t.diagnostic(`search_native_case=${name}:passed`);
    await t.test("the actual index reaches ready and passes the unchanged all-host production check", async () => {
      let ready = false;
      for (let attempt = 0; attempt < 72; attempt++) {
        const rows = await collection.listSearchIndexes().toArray(); check();
        assert.ok(rows.length <= 1); if (rows[0]?.status === "FAILED") throw Error("Owned Vector Search index build failed");
        if (rows[0]?.status === "READY") {
          t.diagnostic(`search_native_ready_metadata=${JSON.stringify(rows)}`);
          await assertReferenceVectorIndex(collection); ready = true; break;
        }
        await pause();
      }
      assert.equal(ready, true, "Owned Search index did not become ready within six minutes"); passed("ready");
    });
    await t.test("actual exact vector queries cover every canonical passage of both fixture species", async () => {
      const verify = createReferenceCoverageVerifier({ collection });
      for (const { source, manifest } of f.references.slice(0, 2)) {
        let proof;
        for (let attempt = 0; attempt < 12; attempt++) {
          try { proof = await verify(source, manifest); break; }
          catch (error) { if (error.code !== "reference_search_incomplete" || attempt === 11) throw error; await pause(); }
        }
        assert.equal(proof.passageCount, 2); await owned();
        const updated = await db.collection("assistantreferences").updateOne({ _id: source._id, fixtureRun: plan.run, version: 1 }, {
          $set: { status: "ready", stage: "ready", version: 2, searchVerification: proof,
            activation: { sourceHash: source.sha256, manifestHash: source.passageHash, actor: source.creator, at: new Date(), reviewedVersion: 1 } },
        }); assert.equal(updated.modifiedCount, 1);
      }
      passed("coverage");
    });
    const search = createApprovedReferenceSearch({ collection });
    await t.test("actual ANN retrieval keeps exact source generation and species filters and cosine order", async () => {
      assert.equal(await search.hasEligibleSources(f.scope), true);
      const result = await search.search({ scope: f.scope, query: f.query }); assert.equal(result.length, 2);
      assert.deepEqual(result.map(row => row.sourceId), Array(2).fill(String(f.references[0].source._id)));
      assert.deepEqual(result.map(row => row.excerpt), f.passages.slice(0, 2).map(row => row.text));
      assert.ok(result.every(row => row.version === f.references[0].source.passageHash)); passed("filtered_ann");
    });
    await t.test("disabling metadata blocks evidence although its vectors still exist in the actual index", async () => {
      await owned(); assert.equal((await db.collection("assistantreferences").updateOne({ _id: f.references[0].source._id, fixtureRun: plan.run },
        { $set: { status: "disabled", stage: "disabled" }, $inc: { version: 1 } })).modifiedCount, 1);
      assert.equal(await collection.countDocuments({ reference: f.references[0].source._id, manifestHash: f.references[0].source.passageHash }), 2);
      assert.equal(await search.hasEligibleSources(f.scope), false);
      assert.deepEqual(await search.search({ scope: f.scope, query: f.query }), []); passed("disabled");
    });
  } finally {
    try {
      if (claimed) {
        const { db, check } = searchPilotConnection(mongoose.connection, plan);
        const snapshot = await assertSearchPilotOwned(mongoose.connection, plan);
        const passagesExist = snapshot.collections.some(row => row.name === "assistantreferencepassages");
        let removedIndexes = 0;
        if (passagesExist) {
          const collection = db.collection("assistantreferencepassages"), indexes = await collection.listSearchIndexes().toArray();
          assert.ok(indexes.length <= 1);
          for (const index of indexes) {
            assertOwnedSearchPilotIndex(index, plan);
            await assertSearchPilotOwned(mongoose.connection, plan); await collection.dropSearchIndex(plan.index.name); removedIndexes++;
          }
          let absent = false;
          for (let attempt = 0; attempt < 24; attempt++) {
            if (!(await collection.listSearchIndexes().toArray()).length) { absent = true; break; }
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          assert.equal(absent, true, "Owned Search index removal is not verified");
        }
        for (const name of [...snapshot.collections.map(row => row.name).filter(name => name !== "assistanttestownership"), "assistanttestownership"]) {
          await assertSearchPilotOwned(mongoose.connection, plan); await db.dropCollection(name, { maxTimeMS: 10000 }); check();
        }
        t.diagnostic(`search_native_insert_attempts=${inserts}`); t.diagnostic("search_native_fake_calls=0");
        t.diagnostic(`search_native_cleanup=${JSON.stringify({ droppedOwnedCollections: snapshot.collections.length, documentsBeforeCleanup: snapshot.documents, droppedSearchIndexes: removedIndexes, searchIndexAbsenceVerified: true })}`);
      }
    } finally { await mongoose.disconnect(); }
  }
});
