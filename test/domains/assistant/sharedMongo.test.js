import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { validateSharedMongoTarget, sharedMongoConfirmation, createSharedMongoManifest, sharedMongoRecords } from "./fixtures/sharedMongo.js";

const uri = "mongodb+srv://synthetic:never-a-real-key@magdy.pbupj.mongodb.net/petyard?retryWrites=true&w=majority";
function fakeDatabase(manifest = createSharedMongoManifest()) {
  const calls = []; const data = Object.fromEntries(Object.keys(manifest.records).map((name) => [name, []])); const fail = {};
  const indexes = Object.fromEntries(Object.keys(data).map((name) => [name, name.endsWith("messages")
    ? [{ key: { chat: 1, sequence: 1 }, unique: true }, { key: { run: 1, role: 1 }, unique: true }]
    : [{ key: name === "assistantruns" ? { owner: 1, key: 1 } : { owner: 1 }, unique: true }]]));
  if (["catalogPublication", "catalogPipeline"].includes(manifest.suite)) indexes.assistantdietarywarnings = [
    { key: { _id: 1 } },
    { key: { owner: 1, subjectId: 1, sourceMessage: 1 }, unique: true }, { key: { owner: 1, subjectId: 1, state: 1, _id: -1 } },
  ];
  if (manifest.suite === "catalogRead") for (const name of Object.keys(data)) indexes[name] = [{ unique: true,
    key: name === "warehouses" ? { code: 1 } : name === "subcategories" ? { category: 1, slug: 1 } : { slug: 1 } }];
  if (manifest.suite === "catalogPipeline") {
    for (const name of ["categories", "subcategories", "brands", "warehouses", "products", "collections"]) indexes[name] = [{ unique: true,
      key: name === "warehouses" ? { code: 1 } : name === "subcategories" ? { category: 1, slug: 1 } : { slug: 1 } }];
    indexes.users = [
      ...["email", "phone"].map((field) => ({ key: { [field]: 1 }, unique: true, partialFilterExpression: { [field]: { $type: "string" } } })),
      { key: { "authProviders.provider": 1, "authProviders.providerUserId": 1 }, unique: true, sparse: true },
    ];
  }
  const matches = (row, filter) => filter._id.$in.some((id) => String(id) === String(row._id)) &&
    (!filter.assistantTestRun || filter.assistantTestRun === row.assistantTestRun);
  const client = { options: { srvHost: manifest.host, dbName: "petyard" } };
  const connection = { name: "petyard", readyState: 1, getClient: () => client, db: { databaseName: "petyard",
    listCollections(filter, options) {
      assert.equal(typeof filter.name, "string", "Atlas collection preflight requires an exact name");
      assert.deepEqual(options, { nameOnly: true }); calls.push(["list", filter.name]);
      return { async toArray() { return Object.hasOwn(data, filter.name) ? [{ name: filter.name }] : []; } };
    },
    collection(name) { assert.ok(Object.hasOwn(data, name)); return {
      listIndexes() { calls.push(["indexes", name]); return { async toArray() { return indexes[name]; } }; },
      async countDocuments(filter) { calls.push(["count", name, filter]); return data[name].filter((row) => matches(row, filter)).length; },
      async findOne(filter, options) { calls.push(["findOne", name, filter, options]); return data[name].find((row) => matches(row, filter)) ?? null; },
      async insertOne(row) { calls.push(["insert", name]); if (fail.insert === name) throw new Error("insert failed"); data[name].push(row); },
      async deleteMany(filter) { calls.push(["delete", name, filter]); if (fail.delete === name) throw new Error("delete failed");
        data[name] = data[name].filter((row) => !matches(row, filter)); },
    }; },
  } };
  return { connection, calls, data, fail, manifest, client, indexes };
}

test("shared target accepts only the exact opted-in test-cluster petyard URI", () => {
  assert.equal(validateSharedMongoTarget(uri, sharedMongoConfirmation).pathname, "/petyard");
  for (const invalid of [undefined, "broken", uri.replace("magdy.pbupj", "production.pbupj"), uri.replace("/petyard", "/ai_test_abc"),
    uri.replace("/petyard", "/"), uri.replace("mongodb+srv", "mongodb"), `${uri}#extra`, `${uri}&tls=false`,
    `${uri}&w=1`, `${uri}&authSource=another`, uri.replace("synthetic:never-a-real-key@", ""), `${uri}&readPreference=secondary`]) {
    assert.throws(() => validateSharedMongoTarget(invalid, sharedMongoConfirmation), (error) => {
      assert.doesNotMatch(error.message, /never-a-real-key|production\.pbupj/); return true;
    });
  }
  assert.throws(() => validateSharedMongoTarget(uri, undefined), /not authorized/);
});

test("wrong connection or handle is rejected before any database operation", async () => {
  for (const change of [(f) => { f.connection.name = "production"; }, (f) => { f.connection.db.databaseName = "other"; },
    (f) => { f.client.options.srvHost = "production.invalid"; }, (f) => { f.client.options.dbName = "other"; },
    (f) => { f.connection.readyState = 0; }]) {
    const f = fakeDatabase(); change(f);
    assert.throws(() => sharedMongoRecords(f.connection, f.manifest), /not authorized/); assert.deepEqual(f.calls, []);
  }
  const f = fakeDatabase(); const records = sharedMongoRecords(f.connection, f.manifest); await records.prepare();
  f.calls.length = 0; f.connection.db = { ...f.connection.db };
  await assert.rejects(records.cleanup(), /connection changed/); assert.deepEqual(f.calls, []);
});

test("manifest rejects extra collections, budget IDs and duplicate identifiers before access", () => {
  for (const change of [(m) => { m.records.assistantbudgets = ["control"]; }, (m) => { m.records.users = ["control"]; },
    (m) => { m.records.orders[0] = m.records.products[0]; }, (m) => { m.marker = {}; },
    (m) => { m.database = "other"; }, (m) => { m.warehouse = m.records.products[0]; }]) {
    const f = fakeDatabase(); change(f.manifest);
    assert.throws(() => sharedMongoRecords(f.connection, f.manifest)); assert.deepEqual(f.calls, []);
  }
});

test("missing collections and existing IDs fail before writes and never arm cleanup", async () => {
  for (const missing of [true, false]) {
    const f = fakeDatabase();
    if (missing) delete f.data.orders;
    else f.data.users.push({ _id: f.manifest.records.users[0], assistantTestRun: f.manifest.marker });
    const records = sharedMongoRecords(f.connection, f.manifest);
    await assert.rejects(records.prepare(), missing ? /must already exist/ : /identifier already exists/);
    await records.cleanup(); assert.equal(f.calls.some((call) => ["insert", "delete"].includes(call[0])), false);
  }
});

test("only registered writes are accepted and cleanup preserves unrelated records", async () => {
  const f = fakeDatabase(); const records = sharedMongoRecords(f.connection, f.manifest);
  await assert.rejects(records.insert("users", { _id: f.manifest.records.users[0] }), /unregistered/);
  await records.prepare(); await assert.rejects(records.prepare(), /already prepared/);
  await assert.rejects(records.insert("assistantbudgets", { _id: "control" }), /unregistered/);
  await assert.rejects(records.insert("users", { _id: new mongoose.Types.ObjectId() }), /unregistered/);
  const unrelated = { _id: new mongoose.Types.ObjectId(), assistantTestRun: f.manifest.marker };
  f.data.users.push(unrelated);
  await records.insert("users", { _id: new mongoose.Types.ObjectId(f.manifest.records.users[0]), assistantTestRun: "override" });
  assert.equal(f.data.users[1].assistantTestRun, f.manifest.marker);
  f.manifest.records.users[0] = String(unrelated._id); // Caller mutation must not broaden the captured scope.
  await records.cleanup(); await records.cleanup(); assert.deepEqual(f.data.users, [unrelated]);
  assert.deepEqual(f.calls.filter((call) => call[0] === "delete").map((call) => call[1]), ["orders", "products", "users", "orders", "products", "users"]);
});

test("partial insert failure still cleans previously inserted records", async () => {
  const f = fakeDatabase(); const records = sharedMongoRecords(f.connection, f.manifest); await records.prepare();
  await records.insert("users", { _id: new mongoose.Types.ObjectId(f.manifest.records.users[0]) }); f.fail.insert = "products";
  await assert.rejects(records.insert("products", { _id: new mongoose.Types.ObjectId(f.manifest.records.products[0]) }), /insert failed/);
  await records.cleanup(); assert.equal(f.data.users.length, 0);
});

test("cleanup retains failures, continues other collections and detects changed ownership markers", async () => {
  const f = fakeDatabase(); const records = sharedMongoRecords(f.connection, f.manifest); await records.prepare();
  await records.insert("users", { _id: new mongoose.Types.ObjectId(f.manifest.records.users[0]) });
  f.data.users[0].assistantTestRun = "foreign"; f.fail.delete = "orders";
  await assert.rejects(records.cleanup(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); return true;
  });
  assert.deepEqual(f.calls.filter((call) => call[0] === "delete").map((call) => call[1]), ["orders", "products", "users"]);
  assert.equal(f.data.users.length, 1, "Unexpected ownership must remain untouched and reported");
});

test("persistence suite has a fixed record scope and excludes every budget and outbox collection", async () => {
  const f = fakeDatabase(createSharedMongoManifest("persistence")); const records = sharedMongoRecords(f.connection, f.manifest);
  await records.prepare();
  assert.deepEqual(Object.keys(f.manifest.records), ["users", "assistantaccounts", "assistantchats", "assistantadminchats",
    "assistantruns", "assistantmessages", "assistantadminmessages"]);
  await assert.rejects(records.insert("assistantbudgets", { _id: "control" }), /unregistered/);
  await records.insert("assistantruns", { _id: new mongoose.Types.ObjectId(f.manifest.records.assistantruns[0]) });
  await records.cleanup(); assert.equal(f.data.assistantruns.length, 0);
  const wrong = createSharedMongoManifest("persistence"); wrong.records.assistantruns.push(String(new mongoose.Types.ObjectId()));
  assert.throws(() => sharedMongoRecords(f.connection, wrong), /manifest/);
  assert.throws(() => createSharedMongoManifest("anything"), /Unknown/);
});

test("persistence preflight refuses missing, nonunique, partial or sparse uniqueness before arming writes", async () => {
  for (const replacement of [[], [{ key: { owner: 1, key: 1 } }],
    [{ key: { owner: 1, key: 1 }, unique: true, partialFilterExpression: { active: true } }],
    [{ key: { owner: 1, key: 1 }, unique: true, sparse: true }]]) {
    const f = fakeDatabase(createSharedMongoManifest("persistence")); f.indexes.assistantruns = replacement;
    const records = sharedMongoRecords(f.connection, f.manifest);
    await assert.rejects(records.prepare(), /Required unique indexes missing/);
    await records.cleanup(); assert.equal(f.calls.some((call) => ["insert", "delete"].includes(call[0])), false);
  }
});

test("older analytics manifests without a suite remain bounded and need no assistant indexes", async () => {
  const manifest = createSharedMongoManifest(); delete manifest.suite;
  const f = fakeDatabase(manifest); const records = sharedMongoRecords(f.connection, manifest); await records.prepare();
  assert.equal(f.calls.some((call) => call[0] === "indexes"), false);
  manifest.suite = "unknown"; assert.throws(() => sharedMongoRecords(f.connection, manifest), /suite/);
});

test("catalog publication profile has exact native warning/message scope and requires both warning indexes without TTL", async () => {
  const manifest = createSharedMongoManifest("catalogPublication"); const f = fakeDatabase(manifest);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.records).map(([key, ids]) => [key, ids.length])), {
    users: 2, assistantaccounts: 1, assistantchats: 1, assistantruns: 1, assistantmessages: 2, assistantdietarywarnings: 1,
  });
  const records = sharedMongoRecords(f.connection, manifest); await records.prepare();
  await records.insert("assistantdietarywarnings", { _id: new mongoose.Types.ObjectId(manifest.records.assistantdietarywarnings[0]) });
  const unrelated = { _id: new mongoose.Types.ObjectId(), assistantTestRun: manifest.marker }; f.data.assistantdietarywarnings.push(unrelated);
  await assert.rejects(records.insert("assistantbudgets", { _id: "control" }), /unregistered/);
  await records.cleanup(); assert.deepEqual(f.data.assistantdietarywarnings, [unrelated]);
  for (const mode of ["unique", "list", "ttl", "extra"]) {
    const target = fakeDatabase(createSharedMongoManifest("catalogPublication"));
    if (mode === "unique") target.indexes.assistantdietarywarnings.splice(1, 1);
    if (mode === "list") target.indexes.assistantdietarywarnings.pop();
    if (mode === "ttl") target.indexes.assistantdietarywarnings.push({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    if (mode === "extra") target.indexes.assistantdietarywarnings.push({ key: { text: 1 } });
    const guarded = sharedMongoRecords(target.connection, target.manifest);
    await assert.rejects(guarded.prepare(), /index/i); await guarded.cleanup();
    assert.equal(target.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false);
  }
});

test("catalog read profile permits exactly 23 fixtures in six existing stores and preserves unrelated records", async () => {
  const f = fakeDatabase(createSharedMongoManifest("catalogRead")), records = sharedMongoRecords(f.connection, f.manifest);
  assert.deepEqual(Object.fromEntries(Object.entries(f.manifest.records).map(([name, ids]) => [name, ids.length])),
    { categories: 3, subcategories: 2, brands: 1, warehouses: 4, products: 10, collections: 3 });
  await records.prepare();
  const unrelated = { _id: new mongoose.Types.ObjectId(), assistantTestRun: f.manifest.marker }; f.data.products.push(unrelated);
  for (const [name, ids] of Object.entries(f.manifest.records)) for (const id of ids) await records.insert(name, { _id: new mongoose.Types.ObjectId(id) });
  assert.equal(f.calls.filter(([kind]) => kind === "insert").length, 23);
  await assert.rejects(records.insert("users", { _id: new mongoose.Types.ObjectId() }), /unregistered/);
  await records.cleanup(); assert.deepEqual(f.data.products, [unrelated]);
});

test("catalog read missing stores or unsafe unique prerequisites refuse every write and cleanup", async () => {
  for (const mode of ["collection", "missing", "nonunique", "partial", "sparse"]) {
    const f = fakeDatabase(createSharedMongoManifest("catalogRead"));
    if (mode === "collection") delete f.data.warehouses;
    else if (mode === "missing") f.indexes.products = [];
    else if (mode === "nonunique") f.indexes.products[0].unique = false;
    else f.indexes.products[0][mode === "partial" ? "partialFilterExpression" : "sparse"] = mode === "partial" ? { isActive: true } : true;
    const records = sharedMongoRecords(f.connection, f.manifest); await assert.rejects(records.prepare()); await records.cleanup();
    assert.equal(f.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false);
  }
});

test("pipeline profile registers exactly 15 ObjectIds in 15 stores and never deletes empty sets or unrelated records", async () => {
  const f = fakeDatabase(createSharedMongoManifest("catalogPipeline"));
  assert.deepEqual(Object.fromEntries(Object.entries(f.manifest.records).map(([name, ids]) => [name, ids.length])), {
    users: 2, assistantaccounts: 1, assistantchats: 1, assistantruns: 1, assistantmessages: 2, assistantdietarywarnings: 1,
    assistantevents: 4, categories: 1, warehouses: 1, products: 1, subcategories: 0, brands: 0, collections: 0, pets: 0, assistantmemories: 0,
  });
  const records = sharedMongoRecords(f.connection, f.manifest); await records.prepare();
  const unrelated = { _id: new mongoose.Types.ObjectId(), assistantTestRun: f.manifest.marker }; f.data.products.push(unrelated);
  for (const [name, ids] of Object.entries(f.manifest.records)) for (const id of ids) await records.insert(name, { _id: new mongoose.Types.ObjectId(id) });
  await records.cleanup(); assert.deepEqual(f.data.products, [unrelated]);
  assert.equal(f.calls.filter(([kind]) => kind === "insert").length, 15);
  assert.equal(f.calls.filter(([kind]) => kind === "delete").length, 10);
  await assert.rejects(records.insert("assistanttestbudgets", { _id: "control" }), /unregistered/);
});

test("pipeline preflight refuses absent zero-count stores, incompatible user constraints and missing application/catalog unique indexes before writes", async () => {
  for (const change of [
    (f) => { delete f.data.pets; }, (f) => { delete f.data.assistantmemories; },
    (f) => { f.indexes.users[0].partialFilterExpression = { email: { $exists: true } }; },
    (f) => { f.indexes.users[1].sparse = true; }, (f) => { f.indexes.users[2].sparse = false; },
    (f) => { f.indexes.users.push({ key: { username: 1 }, unique: true }); },
    (f) => { f.indexes.assistantruns = []; }, (f) => { f.indexes.assistantmessages = []; },
    (f) => { f.indexes.products = []; }, (f) => { f.indexes.assistantdietarywarnings.push({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }); },
  ]) {
    const f = fakeDatabase(createSharedMongoManifest("catalogPipeline")); change(f);
    const records = sharedMongoRecords(f.connection, f.manifest); await assert.rejects(records.prepare()); await records.cleanup();
    assert.equal(f.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false);
  }
});

test("pipeline preflight accepts only the reviewed deployed and schema identity variants without changing indexes", async () => {
  const report = JSON.parse(await readFile(new URL("./fixtures/catalogDeployedIndexes.json", import.meta.url), "utf8"));
  const deployed = report.stores.find((store) => store.name === "users").indexes;
  const recorded = fakeDatabase(createSharedMongoManifest("catalogPipeline"));
  for (const store of report.stores) if (store.exists && Object.hasOwn(recorded.indexes, store.name)) recorded.indexes[store.name] = structuredClone(store.indexes);
  await sharedMongoRecords(recorded.connection, recorded.manifest).prepare();
  assert.equal(recorded.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false,
    "All recorded deployed prerequisites are checked offline, with only the two missing stores simulated as present");
  for (const shape of ["deployed", "plain_email_sparse_provider", "partial_email_partial_provider"]) {
    const f = fakeDatabase(createSharedMongoManifest("catalogPipeline"));
    f.indexes.users = structuredClone(deployed);
    if (shape === "plain_email_sparse_provider") {
      const index = f.indexes.users.find((index) => index.key["authProviders.provider"]);
      delete index.partialFilterExpression; index.sparse = true;
    }
    if (shape === "partial_email_partial_provider") f.indexes.users.find((index) => index.key.email).partialFilterExpression = { email: { $type: "string" } };
    const before = structuredClone(f.indexes); await sharedMongoRecords(f.connection, f.manifest).prepare();
    assert.deepEqual(f.indexes, before); assert.equal(f.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false);
  }
});

test("pipeline rejects unsafe plain phone, nonunique and unreviewed identity constraints even alongside valid indexes", async () => {
  for (const change of [
    (indexes) => { delete indexes[1].partialFilterExpression; },
    (indexes) => { indexes[0].unique = false; },
    (indexes) => { indexes[0].sparse = true; },
    (indexes) => { delete indexes[2].sparse; },
    (indexes) => { delete indexes[2].sparse; indexes[2].partialFilterExpression = { "authProviders.providerUserId": { $exists: true } }; },
    (indexes) => { indexes.push({ key: { phone: 1 }, unique: true }); },
    (indexes) => { indexes[0].partialFilterExpression = { email: { $type: "string" }, active: true }; },
  ]) {
    const f = fakeDatabase(createSharedMongoManifest("catalogPipeline")); change(f.indexes.users);
    const records = sharedMongoRecords(f.connection, f.manifest); await assert.rejects(records.prepare(), /unique index/i);
    await records.cleanup(); assert.equal(f.calls.some(([kind]) => ["insert", "delete"].includes(kind)), false);
  }
});
