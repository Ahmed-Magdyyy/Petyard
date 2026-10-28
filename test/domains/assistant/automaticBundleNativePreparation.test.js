import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { automaticBundleNativeCollections, automaticBundleNativeOptIn, validateAutomaticBundleNativePlan, automaticBundleNativeConnection,
  automaticBundleNativeMarker, claimAutomaticBundleNativeDatabase, inspectAutomaticBundleNativeDatabase, cleanupAutomaticBundleNativeDatabase,
  verifyAutomaticBundleNativeEmpty, installAutomaticBundleNativeGuard } from "./fixtures/automaticBundleNative.js";

const plan = () => ({ host: "magdy.pbupj.mongodb.net", database: "ai_test_autobundle_111111111111", run: "11111111-1111-1111-1111-111111111111",
  collections: [...automaticBundleNativeCollections], maxInsertAttempts: 128, caseCount: 8, optIn: automaticBundleNativeOptIn,
  indexes: Object.fromEntries(["manualbundles", "assistantchats", "assistantmessages", "assistantruns", "assistantaccounts", "assistantmemories",
    "assistantdietarywarnings", "assistantbudgets", "assistantevents", "notificationoutboxes"].map(name => [name,
      name === "manualbundles" ? [{ key: { origin: 1, status: 1, _id: -1 }, name: "manual_bundle_catalog_v1", unique: false, expireAfterSeconds: null }] : []])) });
function fixture() {
  const p = plan(), f = { plan: p, stores: {}, drops: [] };
  const db = { databaseName: p.database, listCollections() { return { async toArray() { return Object.keys(f.stores).map(name => ({ name })); } }; },
    async createCollection(name) { f.stores[name] = []; }, collection(name) { return {
      async insertOne(row) { f.stores[name].push(row); }, async findOne() { return f.stores[name]?.[0] ?? null; },
      async countDocuments(filter) { const rows = f.stores[name] ?? []; return filter.fixtureRun ? rows.filter(row => row.fixtureRun !== filter.fixtureRun.$ne).length : rows.length; },
    }; }, async dropCollection(name) { if (f.denied === name) throw Error("Synthetic cleanup failure"); f.drops.push(name); delete f.stores[name]; } };
  const client = { options: { srvHost: p.host, dbName: "petyard" } };
  f.connection = { readyState: 1, name: p.database, db, getClient: () => client }; return f;
}

test("native scope rejects app databases, other hosts, altered collections, attempt budgets and counts", () => {
  validateAutomaticBundleNativePlan(plan());
  for (const change of [{ database: "petyard" }, { host: "other.mongodb.net" }, { collections: [...automaticBundleNativeCollections, "carts"] },
    { maxInsertAttempts: 129 }, { caseCount: 9 }, { optIn: "other" }, { indexes: {} }, { run: "bad" }]) assert.throws(() => validateAutomaticBundleNativePlan({ ...plan(), ...change }));
});

test("connection fencing rechecks database identity, client, host, selected handle and state", () => {
  for (const mode of ["name", "database", "client", "host", "default", "handle", "state"]) {
    const f = fixture(), scope = automaticBundleNativeConnection(f.connection, f.plan);
    if (mode === "name") f.connection.name = "petyard";
    if (mode === "database") f.connection.db.databaseName = "petyard";
    if (mode === "client") f.connection.getClient = () => ({});
    if (mode === "host") f.connection.getClient().options.srvHost = "other.mongodb.net";
    if (mode === "default") f.connection.getClient().options.dbName = "other";
    if (mode === "handle") f.connection.db = { ...f.connection.db };
    if (mode === "state") f.connection.readyState = 0;
    assert.throws(scope.check);
  }
});

test("exclusive claim and exact ownership checks permit only owned collection cleanup, marker last", async () => {
  const f = fixture(); await claimAutomaticBundleNativeDatabase(f.connection, f.plan);
  assert.deepEqual(f.stores.assistanttestownership, [automaticBundleNativeMarker(f.plan)]);
  await assert.rejects(claimAutomaticBundleNativeDatabase(f.connection, f.plan));
  f.stores.products = [{ _id: 1, fixtureRun: f.plan.run }]; f.stores.orders = [];
  assert.equal((await inspectAutomaticBundleNativeDatabase(f.connection, f.plan)).documents, 2);
  assert.equal((await cleanupAutomaticBundleNativeDatabase(f.connection, f.plan)).droppedOwnedCollections, 3);
  assert.equal(f.drops.at(-1), "assistanttestownership");
  assert.equal((await verifyAutomaticBundleNativeEmpty(f.connection, f.plan)).collectionsRemaining, 0);
});

test("foreign records, unexpected collections/markers and excessive fixture counts stop all cleanup drops", async () => {
  for (const mode of ["foreign", "unknown", "marker", "extra-marker", "over-budget"]) {
    const f = fixture(); await claimAutomaticBundleNativeDatabase(f.connection, f.plan);
    if (mode === "foreign") f.stores.products = [{ _id: 1 }];
    if (mode === "unknown") f.stores.carts = [];
    if (mode === "marker") f.stores.assistanttestownership[0].run = "different";
    if (mode === "extra-marker") f.stores.assistanttestownership.push({ _id: "other" });
    if (mode === "over-budget") f.stores.products = Array(128).fill({ fixtureRun: f.plan.run });
    await assert.rejects(cleanupAutomaticBundleNativeDatabase(f.connection, f.plan)); assert.deepEqual(f.drops, []);
  }
  const f = fixture(); await claimAutomaticBundleNativeDatabase(f.connection, f.plan); f.stores.products = []; f.denied = "products";
  await assert.rejects(cleanupAutomaticBundleNativeDatabase(f.connection, f.plan)); assert.ok(f.stores.assistanttestownership);
});

test("driver guards bind writes/upserts to ownership and count every possible insertion", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  for (const method of ["insertOne", "updateOne", "findOneAndUpdate", "createIndex", "createIndexes", "findOne"]) t.mock.method(p, method, (...args) => { calls.push({ method, args }); return "native"; });
  const guard = installAutomaticBundleNativeGuard(t, f.connection, f.plan), owned = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "assistantbudgets" };
  assert.equal(p.insertOne.call(owned, { _id: "control" }), "native"); assert.equal(calls.at(-1).args[0].fixtureRun, f.plan.run);
  assert.equal(p.updateOne.call(owned, { _id: "global:test" }, { $setOnInsert: { spent: 0 } }, { upsert: true }), "native");
  assert.equal(calls.at(-1).args[0].fixtureRun, f.plan.run); assert.equal(calls.at(-1).args[1].$setOnInsert.fixtureRun, f.plan.run);
  assert.equal(guard.insertAttempts(), 3);
  for (const foreign of [{ ...owned, dbName: "petyard" }, { ...owned, client: {} }, { ...owned, collectionName: "carts" }]) {
    assert.throws(() => p.insertOne.call(foreign, { _id: 1 })); assert.throws(() => p.findOne.call(foreign, {}));
  }
  for (const [filter, update, options] of [[{}, { $set: { spent: 1 } }, {}], [{ _id: { $gt: 1 } }, { $set: { spent: 1 } }, {}],
    [{ _id: "control" }, { $unset: { fixtureRun: 1 } }, {}], [{ _id: "control" }, { $set: { fixtureRun: "other" } }, {}],
    [{ _id: "control" }, [{ $set: { spent: 1 } }], {}]]) assert.throws(() => p.updateOne.call(owned, filter, update, options));
  assert.throws(() => p.updateOne.call({ ...owned, collectionName: "orders" }, { _id: new mongoose.Types.ObjectId() }, { $set: { status: "pending" } }, { upsert: true }));
  for (const method of ["bulkWrite", "insertMany", "updateMany", "deleteMany", "findOneAndDelete", "rename", "dropIndexes"]) assert.throws(() => p[method].call(owned));
  while (guard.insertAttempts() < 128) p.insertOne.call(owned, { _id: new mongoose.Types.ObjectId() });
  assert.throws(() => p.insertOne.call(owned, { _id: 1 }), /budget exceeded/);
});

test("database and index operations are limited to the exact isolated plan", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, d = mongoose.mongo.Db.prototype;
  for (const method of ["createIndex", "createIndexes"]) t.mock.method(p, method, () => "native");
  for (const method of ["createCollection", "dropCollection", "listCollections"]) t.mock.method(d, method, () => "native");
  installAutomaticBundleNativeGuard(t, f.connection, f.plan);
  const collection = { client: f.connection.getClient(), dbName: f.plan.database, collectionName: "manualbundles" };
  assert.equal(p.createIndex.call(collection, { origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1" }), "native");
  assert.throws(() => p.createIndex.call(collection, { price: 1 }, { name: "other" }));
  assert.throws(() => p.createIndex.call(collection, { origin: 1, status: 1, _id: -1 }, { name: "manual_bundle_catalog_v1", sparse: true }));
  const database = { client: f.connection.getClient(), databaseName: f.plan.database };
  assert.equal(d.createCollection.call(database, "products"), "native");
  assert.throws(() => d.createCollection.call(database, "carts")); assert.throws(() => d.dropDatabase.call(database));
  assert.throws(() => d.command.call(database, { dropDatabase: 1 }));
  assert.throws(() => d.dropCollection.call({ ...database, databaseName: "petyard" }, "products"));
});

test("real Mongoose timestamped upsert/create shapes pass the guarded driver boundary without network", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, seen = [];
  for (const method of ["insertOne", "findOneAndUpdate", "updateOne"]) t.mock.method(p, method, async (...args) => {
    seen.push({ method, args }); return method === "findOneAndUpdate" ? { _id: new mongoose.Types.ObjectId(), owner: args[0].owner } : { acknowledged: true, insertedId: args[0]._id };
  });
  installAutomaticBundleNativeGuard(t, f.connection, f.plan);
  const client = f.connection.getClient(), account = { client, dbName: f.plan.database, collectionName: "assistantaccounts" };
  const owner = new mongoose.Types.ObjectId();
  const { AssistantAccount } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { ManualBundle } = await import("../../../src/domains/bundle/bundle.model.js");
  t.mock.method(AssistantAccount.collection, "findOneAndUpdate", (...args) => p.findOneAndUpdate.call(account, ...args));
  await AssistantAccount.findOneAndUpdate({ owner: String(owner) }, { $setOnInsert: { owner: String(owner) } }, { upsert: true, new: true }).lean();
  assert.equal(seen.at(-1).args[0].fixtureRun, f.plan.run); assert.equal(seen.at(-1).args[1].$setOnInsert.fixtureRun, f.plan.run);
  assert.equal(String(seen.at(-1).args[0].owner), String(owner));
  assert.equal(seen.at(-1).args[2].upsert, true);
  assert.ok(seen.at(-1).args[1].$set.updatedAt instanceof Date);
  const bundle = { client, dbName: f.plan.database, collectionName: "manualbundles" };
  t.mock.method(ManualBundle.collection, "insertOne", (...args) => p.insertOne.call(bundle, ...args));
  await ManualBundle.create({ name_en: "Fictional native shape", pricePiastres: 100, createdBy: owner, updatedBy: owner,
    components: [{ productId: new mongoose.Types.ObjectId(), productType: "SIMPLE", quantity: 1 }] });
  assert.equal(seen.at(-1).method, "insertOne"); assert.equal(seen.at(-1).args[0].fixtureRun, f.plan.run);
});

test("only one reserved plan attempt can be appended to an exact owned run", t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  t.mock.method(p, "updateOne", (...args) => { calls.push(args); return "native"; });
  const guard = installAutomaticBundleNativeGuard(t, f.connection, f.plan);
  const owned = { client:f.connection.getClient(), dbName:f.plan.database, collectionName:"assistantruns" };
  const id = new mongoose.Types.ObjectId(), attempt = { id:"11111111-1111-1111-1111-111111111111", number:1, phase:"plan", accounting:"reserved" };
  const update = { $push:{attempts:{$each:[attempt]}} };
  assert.equal(p.updateOne.call(owned, {_id:id}, update), "native");
  assert.equal(calls[0][0].fixtureRun, f.plan.run); assert.equal(guard.insertAttempts(), 1);
  for (const mutation of [{ $push:{items:{$each:[attempt]}} }, { $push:{attempts:attempt} },
    { $push:{attempts:{$each:[attempt,attempt]}} }, { $push:{attempts:{$each:[attempt],$slice:1}} },
    { $push:{attempts:{$each:[{...attempt,id:"bad"}]}} }, { $push:{attempts:{$each:[{...attempt,number:2}]}} },
    { $push:{attempts:{$each:[{...attempt,accounting:"settled"}]}} }]) assert.throws(() => p.updateOne.call(owned,{_id:id},mutation));
  assert.throws(() => p.updateOne.call({...owned,collectionName:"assistantbudgets"},{_id:id},update));
  assert.throws(() => p.updateOne.call(owned,{_id:String(id)},update));
  assert.throws(() => p.updateOne.call(owned,{_id:id},update,{upsert:true}));
  assert.throws(() => p.findOneAndUpdate.call(owned,{_id:id},update));
  assert.equal(calls.length,1);
});

test("actual Mongoose run.save appends and settles its attempt through the guarded driver boundary", async t => {
  const f = fixture(), p = mongoose.mongo.Collection.prototype, calls = [];
  t.mock.method(p,"updateOne",async (...args) => {calls.push(args);return {acknowledged:true,matchedCount:1,modifiedCount:1};});
  installAutomaticBundleNativeGuard(t,f.connection,f.plan);
  const {AssistantRun} = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const {testConfig} = await import("./fixtures/foundationPolicy.js");
  const {recordAttempt} = await import("../../../src/domains/assistant/shared/assistant.attempts.js");
  const collection = {client:f.connection.getClient(),dbName:f.plan.database,collectionName:"assistantruns"};
  t.mock.method(AssistantRun.collection,"updateOne",(...args) => p.updateOne.call(collection,...args));
  const owner=new mongoose.Types.ObjectId(), id="11111111-1111-1111-1111-111111111111";
  const run=AssistantRun.hydrate({_id:new mongoose.Types.ObjectId(),__v:0,owner,chat:owner,purpose:"automatic_bundles",key:"offline-shape",hash:"offline",
    input:"Fictional save shape",userSequence:0,contextVersion:0,phase:"plan",status:"queued",attempts:[],config:testConfig(),createdAt:new Date()});
  run.reservation={amount:10,budgetIds:["global:fictional"]};run.accounting="reserved";run.attempt=id;run.status="dispatching";
  run.attempts.push({id,number:1,phase:"plan",contextVersion:0,reservation:run.reservation,accounting:"reserved",dispatchedAt:new Date()});
  await run.save();
  assert.equal(calls.length,1);assert.equal(calls[0][0].fixtureRun,f.plan.run);
  assert.equal(calls[0][1].$push.attempts.$each[0].id,id);
  run.accounting="settled";run.chargedMicroUsd=3;recordAttempt(run);await run.save();
  assert.equal(calls.length,2);assert.equal(calls[1][0].fixtureRun,f.plan.run);
  assert.equal(calls[1][1].$set["attempts.0.accounting"],"settled");
});

test("prepared --check is offline, rejects stale pins and leaves no claim or native result", async t => {
  const directory = ".scratch/assistant-bundle/automatic-native/";
  let before;
  try { before = await fs.readdir(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; t.skip("Local approval artifacts are not part of a clean repository checkout"); return; }
  try { await fs.access(directory + "preparation.json"); }
  catch (error) { if (error.code !== "ENOENT") throw error; t.skip("The local approval proof has not been prepared"); return; }
  const proof=JSON.parse(await fs.readFile(directory+"preparation.json","utf8"));let stale=false;
  for(const [file,hash] of Object.entries(proof.pins)) if(createHash("sha256").update(await fs.readFile(file)).digest("hex")!==hash) {stale=true;break;}
  const check=() => promisify(execFile)(process.execPath,[directory+"run.mjs","--check"],{cwd:process.cwd(),windowsHide:true});
  if(stale) await assert.rejects(check(), error => error.code===1 && /Prepared file changed:/.test(error.stderr));
  else {const {stdout}=await check();assert.match(stdout,/PASS: automatic bundle plan/);assert.match(stdout,/no connection, credentials, claim or writes/);}
  assert.deepEqual(await fs.readdir(directory), before);
});
