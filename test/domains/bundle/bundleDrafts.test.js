import assert from "node:assert/strict";
import test from "node:test";
import { createBundleManagementService } from "../../../src/domains/bundle/bundle.service.js";
import { requireBundleSuperAdmin } from "../../../src/domains/bundle/bundle.access.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import * as repository from "../../../src/domains/bundle/bundle.repository.js";

const actor = { _id: "a00000000000000000000001", role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" };
const productId = "b00000000000000000000001", warehouseId = "c00000000000000000000001", draftId = "d00000000000000000000001";
const body = () => ({ name_en: "Fixed bundle", name_ar: "باكدج", price: 125.5,
  components: [{ productId, productType: "SIMPLE", quantity: 2 }] });
function fixture() {
  const f = { rows: [], calls: [], products: [{ _id: productId, type: "SIMPLE", price: 100, isActive: true, warehouseStocks: [{ warehouse: warehouseId, quantity: 10 }] }], warehouse: { _id: warehouseId, active: true } };
  const db = {
    async requireManualBundleStore() { f.calls.push("ready"); if (f.unready) throw Object.assign(Error("store unavailable"), { code: "BUNDLE_STORE_UNAVAILABLE" }); },
    async findBundleWarehouse() { return f.warehouse; }, async findBundleProducts() { return f.products; },
    async findBundleWarehouses(ids) { return f.warehouse && ids.includes(String(f.warehouse._id)) ? [f.warehouse] : []; },
    async createManualBundle(values) { f.calls.push("create"); const row = { ...structuredClone(values), _id: draftId, createdAt: new Date(), updatedAt: new Date() };
      f.rows.push(row); return structuredClone(row); },
    async findBundle(id) { return structuredClone(f.rows.find(row => row._id === id) ?? null); },
    async listManualBundles(cursor, limit, status) { return structuredClone(f.rows.filter(row => row.origin === "manual" && (!status || row.status === status) && (!cursor || row._id < cursor))
      .sort((a, b) => b._id.localeCompare(a._id)).slice(0, limit)); },
    async updateManualBundle(id, revision, status, values) { f.calls.push("replace"); const row = f.rows.find(row => row._id === id && row.revision === revision && row.status === status && row.origin === "manual");
      if (!row) return null; Object.assign(row, structuredClone(values), { revision: revision + 1 }); return structuredClone(row); },
    async deleteManualDraft(id, revision) { f.calls.push("delete"); const index = f.rows.findIndex(row => row._id === id && row.revision === revision && row.status === "draft" && row.origin === "manual");
      if (index < 0) return null; return f.rows.splice(index, 1)[0]; },
  };
  f.db = db; f.service = createBundleManagementService(db); return f;
}

test("all non-superAdmin roles and inactive/unverified principals are denied before any storage call", async () => {
  const invalid = [null, { ...actor, _id: null }, ...["admin", "moderator", "user", "guest"].map(role => ({ ...actor, role, enabledControls: ["products"] })),
    { ...actor, active: false }, { ...actor, phoneVerified: false }, { ...actor, deletedAt: new Date() }, { ...actor, account_status: "banned" }];
  for (const user of invalid) {
    const f = fixture();
    for (const callback of [() => f.service.create(user, body()), () => f.service.get(user, draftId), () => f.service.list(user, {}),
      () => f.service.replace(user, draftId, { ...body(), expectedRevision: 1 }), () => f.service.remove(user, draftId, { expectedRevision: 1 }),
      () => f.service.publish(user, draftId, { expectedRevision: 1 }), () => f.service.pause(user, draftId, { expectedRevision: 1 })]) {
      await assert.rejects(callback);
    }
    assert.deepEqual(f.calls, []);
  }
  assert.equal(requireBundleSuperAdmin(actor), actor._id);
});

test("manual draft creation uses server provenance, canonical components and integer EGP price without stock writes", async () => {
  const f = fixture(), request = body(); request.components.push({ productId, productType: "SIMPLE", quantity: 1 });
  const result = await f.service.create(actor, request), draft = result.bundle;
  assert.equal(draft.pricePiastres, 12550); assert.equal(draft.price, 125.5); assert.equal(draft.revision, 1);
  assert.equal(draft.components[0].quantity, 3); assert.equal(draft.createdBy, actor._id); assert.equal(draft.origin, "manual");
  assert.equal(draft.status, "draft"); assert.equal(draft.currency, "EGP"); assert.deepEqual(f.calls, ["ready", "create"]);
  assert.equal(request.components.length, 2); assert.equal(JSON.stringify(draft).includes("__v"), false);
});

test("body injection and invalid types are rejected on non-HTTP paths", async () => {
  for (const change of [{ status: "published" }, { origin: "manual" }, { createdBy: productId }, { approvedBy: actor._id }, { currency: "USD" },
    { revision: 5 }, { expectedRevision: 1 }, { price: "100" }, { price: -1 }, { name_ar: null }, { warehouseId: "bad" }]) {
    const f = fixture(); await assert.rejects(f.service.create(actor, { ...body(), ...change })); assert.deepEqual(f.calls, []);
  }
});

test("missing products, changed type and ambiguous/missing variants cannot be saved", async () => {
  const f = fixture(); f.products = []; await assert.rejects(f.service.create(actor, body()), { code: "BUNDLE_COMPONENT_CHANGED" });
  f.products = [{ _id: productId, type: "VARIANT", variants: [] }];
  await assert.rejects(f.service.create(actor, body()), { code: "BUNDLE_COMPONENT_CHANGED" });
  const request = body(); request.components[0] = { productId, productType: "VARIANT", variantId: warehouseId, quantity: 1 };
  for (const variants of [[], {}, [{ _id: warehouseId }, { _id: warehouseId }]]) {
    f.products[0].variants = variants; await assert.rejects(f.service.create(actor, request), { code: "BUNDLE_COMPONENT_CHANGED" });
  }
  assert.equal(f.rows.length, 0);
});

test("two editors cannot overwrite the same revision and stale deletion cannot remove the winner", async () => {
  const f = fixture(); await f.service.create(actor, body());
  const changes = await Promise.allSettled([f.service.replace(actor, draftId, { ...body(), price: 100, expectedRevision: 1 }),
    f.service.replace(actor, draftId, { ...body(), price: 110, expectedRevision: 1 })]);
  assert.equal(changes.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(changes.find(row => row.status === "rejected").reason.code, "BUNDLE_REVISION_CONFLICT");
  assert.equal(f.rows[0].revision, 2); await assert.rejects(f.service.remove(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_REVISION_CONFLICT" });
  await f.service.remove(actor, draftId, { expectedRevision: 2 }); assert.equal(f.rows.length, 0);
  await assert.rejects(f.service.get(actor, draftId), { code: "BUNDLE_NOT_FOUND" });
});

test("manual operations refuse AI-origin and unknown-state records even for a superAdmin", async () => {
  for (const change of [{ origin: "ai" }, { origin: undefined }, { status: "unknown" }]) {
    const f = fixture(); await f.service.create(actor, body()); Object.assign(f.rows[0], change);
    await assert.rejects(f.service.get(actor, draftId), { code: "BUNDLE_MANUAL_REQUIRED" });
    await assert.rejects(f.service.replace(actor, draftId, { ...body(), expectedRevision: 1 }), { code: "BUNDLE_MANUAL_REQUIRED" });
    await assert.rejects(f.service.remove(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_MANUAL_REQUIRED" });
    await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_MANUAL_REQUIRED" });
    await assert.rejects(f.service.pause(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_MANUAL_REQUIRED" });
    assert.equal(f.calls.includes("replace"), false); assert.equal(f.calls.includes("delete"), false);
  }
});

test("draft listing is cursor-bounded and rejects unsupported query fields", async () => {
  const f = fixture(); await f.service.create(actor, body()); f.rows.push({ ...structuredClone(f.rows[0]), _id: productId });
  const first = await f.service.list(actor, { limit: "1" }); assert.equal(first.bundles.length, 1); assert.equal(first.nextCursor, draftId);
  const next = await f.service.list(actor, { limit: "1", cursor: first.nextCursor }); assert.equal(next.bundles[0].id, productId); assert.equal(next.nextCursor, null);
  for (const query of [{ limit: "0" }, { limit: "51" }, { limit: ["1"] }, { sort: "price" }]) await assert.rejects(f.service.list(actor, query));
});

test("missing draft store stops before creation", async () => {
  const f = fixture(); f.unready = true; await assert.rejects(f.service.create(actor, body()), { code: "BUNDLE_STORE_UNAVAILABLE" });
  assert.equal(f.rows.length, 0); assert.deepEqual(f.calls, ["ready"]);
});

test("schema disables automatic DDL/buffering and validates safe persisted money and component identity", () => {
  for (const option of ["autoCreate", "autoIndex", "bufferCommands"]) assert.equal(ManualBundle.schema.options[option], false);
  const values = { name_en: "Bundle", components: [{ ...body().components[0], variantId: null }],
    pricePiastres: 12550, createdBy: actor._id, updatedBy: actor._id };
  assert.equal(new ManualBundle(values).validateSync(), undefined);
  for (const change of [{ pricePiastres: 0.5 }, { pricePiastres: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { components: [] }, { origin: "ai" }, { status: "scheduled" }, { status: "published" }, { status: "paused" }]) assert.ok(new ManualBundle({ ...values, ...change }).validateSync());
  const published = { ...values, status: "published", publishedBy: actor._id, publishedAt: new Date() };
  assert.equal(new ManualBundle(published).validateSync(), undefined);
  assert.equal(new ManualBundle({ ...published, status: "paused", pausedBy: actor._id, pausedAt: new Date() }).validateSync(), undefined);
  assert.equal(ManualBundle.collection.name, "manualbundles");
  assert.throws(() => new ManualBundle({ ...values, approvedBy: actor._id }), /strict mode/);
});

test("repository mutations carry exact revision and manual-draft predicates in the real Mongoose call", async t => {
  const calls = [];
  for (const method of ["findOneAndUpdate", "findOneAndDelete"]) t.mock.method(ManualBundle, method, (...args) => {
    calls.push({ method, args }); return { lean: async () => null };
  });
  await repository.updateManualBundle(draftId, 3, "draft", { name_en: "Changed" }); await repository.deleteManualDraft(draftId, 3);
  for (const call of calls) assert.deepEqual(call.args[0], { _id: draftId, origin: "manual", status: "draft", revision: 3 });
  assert.deepEqual(calls[0].args[1].$inc, { revision: 1 }); assert.equal(calls[0].args[2].runValidators, true);
});

test("a maximum safe revision can be deleted but cannot overflow through editing", async () => {
  const f = fixture(); await f.service.create(actor, body()); f.rows[0].revision = Number.MAX_SAFE_INTEGER;
  await assert.rejects(f.service.replace(actor, draftId, { ...body(), expectedRevision: Number.MAX_SAFE_INTEGER }), { code: "BUNDLE_REVISION_EXHAUSTED" });
  await f.service.remove(actor, draftId, { expectedRevision: Number.MAX_SAFE_INTEGER }); assert.equal(f.rows.length, 0);
});

test("real store guard refuses absent, capped, view, timeseries, missing-ID and TTL metadata without DDL", async t => {
  const connection = ManualBundle.db, previousDb = connection.db;
  const f = { stores: [{ type: "collection", options: {} }], indexes: [{ name: "_id_", key: { _id: 1 } }] };
  connection.db = { listCollections: () => ({ toArray: async () => f.stores }) };
  t.after(() => { connection.db = previousDb; });
  t.mock.method(ManualBundle.collection, "indexes", async () => f.indexes);
  await repository.requireManualBundleStore();
  for (const stores of [[], [{ type: "view", options: {} }], [{ type: "collection", options: { capped: true } }],
    [{ type: "collection", options: { timeseries: {} } }]]) {
    f.stores = stores; await assert.rejects(repository.requireManualBundleStore(), { code: "BUNDLE_STORE_UNAVAILABLE", statusCode: 503 });
  }
  f.stores = [{ type: "collection", options: {} }];
  for (const indexes of [[], [{ name: "_id_", key: { _id: 1 }, sparse: true }],
    [{ name: "_id_", key: { _id: 1 } }, { name: "expiry", key: { expiresAt: 1 }, expireAfterSeconds: 0 }]]) {
    f.indexes = indexes; await assert.rejects(repository.requireManualBundleStore(), { code: "BUNDLE_STORE_UNAVAILABLE" });
  }
});

test("manual publish, pause, edit and republish retain one identity, server actor/time and increasing revisions", async () => {
  const f = fixture(); const created = (await f.service.create(actor, body())).bundle;
  assert.equal(created.status, "draft"); assert.equal(created.publishedAt, null);
  const published = (await f.service.publish(actor, draftId, { expectedRevision: 1 })).bundle;
  assert.equal(published.status, "published"); assert.equal(published.revision, 2); assert.equal(published.publishedBy, actor._id);
  assert.ok(published.publishedAt instanceof Date); assert.equal(published.pricePiastres, 12550);
  assert.deepEqual(published.components, created.components); assert.equal(f.products[0].warehouseStocks[0].quantity, 10);
  await assert.rejects(f.service.replace(actor, draftId, { ...body(), expectedRevision: 2 }), { code: "BUNDLE_PAUSE_REQUIRED" });
  await assert.rejects(f.service.remove(actor, draftId, { expectedRevision: 2 }), { code: "BUNDLE_DELETE_DENIED" });
  // Pausing must remain possible even if stock or warehouse service becomes unavailable.
  f.products = []; f.warehouse.active = false;
  const paused = (await f.service.pause(actor, draftId, { expectedRevision: 2 })).bundle;
  assert.equal(paused.status, "paused"); assert.equal(paused.revision, 3); assert.equal(paused.pausedBy, actor._id);
  assert.ok(paused.pausedAt instanceof Date); assert.equal(paused.publishedAt.getTime(), published.publishedAt.getTime());
  await assert.rejects(f.service.remove(actor, draftId, { expectedRevision: 3 }), { code: "BUNDLE_DELETE_DENIED" });
  f.products = fixture().products; f.warehouse.active = true;
  const edited = (await f.service.replace(actor, draftId, { ...body(), price: 110, expectedRevision: 3 })).bundle;
  assert.equal(edited.status, "paused"); assert.equal(edited.revision, 4); assert.equal(edited.pricePiastres, 11000);
  const republished = (await f.service.publish(actor, draftId, { expectedRevision: 4 })).bundle;
  assert.equal(republished.status, "published"); assert.equal(republished.revision, 5); assert.equal(republished.id, created.id);
  assert.equal(republished.createdAt.getTime(), created.createdAt.getTime());
  assert.equal((await f.service.list(actor, { status: "paused" })).bundles.length, 0);
  assert.equal((await f.service.list(actor, { status: "published" })).bundles.length, 1);
});

test("publication uses only active products and sufficient exact-warehouse stock, with no fallback or reservation", async () => {
  const changes = [f => { f.products[0].isActive = false; },
    f => { f.products[0].warehouseStocks[0].quantity = 1; },
    f => { f.products[0].warehouseStocks[0].warehouse = productId; },
    f => { f.products[0].warehouseStocks.push({ warehouse: warehouseId, quantity: 100 }); },
    f => { f.warehouse.active = false; },
    f => { f.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse: productId }; }];
  for (const change of changes) {
    const f = fixture(); await f.service.create(actor, body()); change(f); const before = structuredClone(f.rows);
    await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 1 }), { statusCode: 409 });
    assert.deepEqual(f.rows, before); assert.equal(f.calls.includes("replace"), false);
  }
});

test("publication canonicalizes persisted ObjectIds and checks the exact variant instead of another variant", async () => {
  const f = fixture(), request = body(); request.components[0] = { productId, productType: "VARIANT", variantId: warehouseId, quantity: 2 };
  f.products = [{ _id: productId, type: "VARIANT", isActive: true, variants: [
    { _id: warehouseId, price: 100, warehouseStocks: [{ warehouse: warehouseId, quantity: 0 }] },
    { _id: draftId, price: 50, warehouseStocks: [{ warehouse: warehouseId, quantity: 100 }] }] }];
  await f.service.create(actor, request);
  await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_STOCK_UNAVAILABLE" });
  f.products[0].variants[0].warehouseStocks[0].quantity = 2;
  const document = new ManualBundle(f.rows[0]).toObject();
  f.rows[0] = document;
  // Exercise the BSON-shaped repository result without cloning away ObjectId methods.
  const service = createBundleManagementService({
    requireManualBundleStore: async () => {}, findBundle: async () => document,
    findBundleWarehouses: async () => [f.warehouse], findBundleProducts: async () => f.products,
    updateManualBundle: async (_id, revision, status, values) => {
      assert.equal(status, "draft"); assert.equal(revision, 1); return { ...document, ...values, revision: 2 };
    },
  });
  assert.equal((await service.publish(actor, draftId, { expectedRevision: 1 })).bundle.status, "published");
});

test("availability actions reject invalid states, stale revisions, schedule injection and revision overflow", async () => {
  const f = fixture(); await f.service.create(actor, body());
  await assert.rejects(f.service.pause(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_STATE_CONFLICT" });
  for (const method of ["publish", "pause"]) {
    for (const invalid of [{ expectedRevision: "1" }, { expectedRevision: 1, startsAt: new Date() },
      { expectedRevision: 1, status: "published" }, { expectedRevision: 1, price: 0 }]) {
      await assert.rejects(f.service[method](actor, draftId, invalid), { statusCode: 400 });
    }
    await assert.rejects(f.service[method](actor, draftId, { expectedRevision: Number.MAX_SAFE_INTEGER }), { code: "BUNDLE_REVISION_EXHAUSTED" });
  }
  await f.service.publish(actor, draftId, { expectedRevision: 1 });
  await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 2 }), { code: "BUNDLE_STATE_CONFLICT" });
  await assert.rejects(f.service.pause(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_REVISION_CONFLICT" });
  assert.equal(f.rows[0].status, "published"); assert.equal(f.rows[0].revision, 2);
});

test("publication competing with a draft edit or deletion cannot apply to a different revision", async () => {
  for (const competitor of [f => f.service.replace(actor, draftId, { ...body(), price: 99, expectedRevision: 1 }),
    f => f.service.remove(actor, draftId, { expectedRevision: 1 })]) {
    const f = fixture(); await f.service.create(actor, body());
    const results = await Promise.allSettled([f.service.publish(actor, draftId, { expectedRevision: 1 }), competitor(f)]);
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(results.find(row => row.status === "rejected").reason.statusCode, 409);
    if (f.rows[0]?.status === "published") assert.equal(f.rows[0].pricePiastres, 12550);
  }
});

test("repository state change matches origin, exact source status and revision without an upsert", async t => {
  const calls = [];
  t.mock.method(ManualBundle, "findOneAndUpdate", (...args) => { calls.push(args); return { lean: async () => null }; });
  await repository.updateManualBundle(draftId, 7, "paused", { status: "published", publishedBy: actor._id, publishedAt: new Date() });
  assert.deepEqual(calls[0][0], { _id: draftId, origin: "manual", status: "paused", revision: 7 });
  assert.equal(calls[0][1].$set.status, "published"); assert.deepEqual(calls[0][1].$inc, { revision: 1 });
  assert.equal(calls[0][2].upsert, undefined); assert.equal(calls[0][2].runValidators, true);
});

test("zero and sub-piastre prices can be drafted but publication requires a positive integer price", async () => {
  for (const price of [0, 0.001]) {
    const f = fixture(); await f.service.create(actor, { ...body(), price });
    assert.equal(f.rows[0].pricePiastres, 0);
    await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_PUBLICATION_PRICE_REQUIRED", statusCode: 409 });
    assert.equal(f.rows[0].status, "draft"); assert.equal(f.rows[0].revision, 1);
  }
  const f = fixture(); await f.service.create(actor, { ...body(), price: 0.01 });
  assert.equal((await f.service.publish(actor, draftId, { expectedRevision: 1 })).bundle.pricePiastres, 1);
});

test("publication cannot present a selling price above the current component original price", async () => {
  const f = fixture(); await f.service.create(actor, { ...body(), price: 201 });
  await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 1 }), { code: "BUNDLE_PRICE_CONFLICT" });
  assert.equal(f.rows[0].status, "draft"); assert.equal(f.rows[0].pricePiastres, 20100);
  await f.service.replace(actor, draftId, { ...body(), price: 200, expectedRevision: 1 });
  assert.equal((await f.service.publish(actor, draftId, { expectedRevision: 2 })).bundle.pricePiastres, 20000);
});

test("one global bundle publishes when any operational warehouse can supply all components, never by pooling warehouses", async () => {
  const f = fixture(), second = "b00000000000000000000002", warehouse = n => "c" + String(n).padStart(23, "0");
  f.products[0].warehouseStocks = [1, 2, 4].map(n => ({ warehouse: warehouse(n), quantity: 5 }));
  f.products.push({ _id: second, type: "SIMPLE", price: 50, isActive: true, warehouseStocks: [2, 3, 4].map(n => ({ warehouse: warehouse(n), quantity: 2 })) });
  const request = body(); request.components.push({ productId: second, productType: "SIMPLE", quantity: 1 });
  await f.service.create(actor, request);
  let candidates;
  f.db.findBundleWarehouses = async ids => { candidates = ids; return [{ _id: warehouse(2), active: true }, { _id: warehouse(4), active: false }]; };
  const published = (await f.service.publish(actor, draftId, { expectedRevision: 1 })).bundle;
  assert.equal(published.status, "published"); assert.deepEqual(candidates.sort(), [warehouse(2), warehouse(4)]);
  assert.equal(published.warehouseId, undefined); assert.equal(f.rows[0].warehouse, undefined);
  await f.service.pause(actor, draftId, { expectedRevision: 2 });
  f.products[0].warehouseStocks = [{ warehouse: warehouse(1), quantity: 100 }];
  f.products[1].warehouseStocks = [{ warehouse: warehouse(2), quantity: 100 }];
  await assert.rejects(f.service.publish(actor, draftId, { expectedRevision: 3 }), { code: "BUNDLE_STOCK_UNAVAILABLE" });
  assert.equal(f.rows[0].status, "paused");
});
