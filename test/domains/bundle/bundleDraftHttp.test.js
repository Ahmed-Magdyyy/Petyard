import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { createBundleManagementRouter } from "../../../src/domains/bundle/bundle.routes.js";
import { createBundleManagementService } from "../../../src/domains/bundle/bundle.service.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { ApiError } from "../../../src/shared/utils/ApiError.js";

const userId = "a00000000000000000000001", productId = "b00000000000000000000001", warehouseId = "c00000000000000000000001";
const draftId = "d00000000000000000000001";
const body = () => ({ name_en: "Fixed bundle", price: 125.5, components: [{ productId, productType: "SIMPLE", quantity: 2 }] });
async function fixture(t, parsedFirst = false, applicationOverride) {
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-bundle-draft-http";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const previousMode = process.env.NODE_ENV; process.env.NODE_ENV = "test";
  t.after(() => { if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode; });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const f = { actor: { _id: userId, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed", deletedAt: null }, calls: [] };
  t.mock.method(UserModel, "findById", async id => String(id) === userId ? f.actor : null);
  const application = applicationOverride ?? {};
  if (!applicationOverride) for (const method of ["create", "get", "list", "replace", "remove", "publish", "pause"]) application[method] = async (...args) => {
    f.calls.push({ method, args }); return method === "list" ? { bundles: [], nextCursor: null } : { bundle: { id: draftId, revision: 1, status: "draft", origin: "manual" } };
  };
  const app = express(); if (parsedFirst) app.use(express.json({ limit: "64kb" }));
  app.use("/drafts", createBundleManagementRouter({ application }));
  app.use((_req, res) => res.status(404).json({ message: "Route not found" }));
  app.use(globalError);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" });
  f.rawJson = async raw => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/drafts`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: raw });
    return { status: response.status, body: await response.json() };
  };
  f.request = async (method, path = "", value, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/drafts${path}`, { method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  return f;
}

test("real JWT authentication denies guests, invalid tokens and every non-superAdmin management request", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("GET", "", undefined, { authorization: "", "x-guest-id": "guest" })).status, 401);
  assert.equal((await f.request("GET", "", undefined, { authorization: "Bearer invalid" })).status, 401);
  for (const role of ["admin", "moderator", "user", "guest"]) {
    f.actor.role = role; f.actor.enabledControls = ["products"];
    for (const [method, path, value] of [["POST", "", body()], ["GET", "", undefined], ["GET", `/${draftId}`, undefined],
      ["PUT", `/${draftId}`, { ...body(), expectedRevision: 1 }], ["DELETE", `/${draftId}`, { expectedRevision: 1 }],
      ["POST", `/${draftId}/publish`, { expectedRevision: 1 }], ["POST", `/${draftId}/pause`, { expectedRevision: 1 }]]) {
      assert.equal((await f.request(method, path, value)).status, 403);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("superAdmin draft requests use standard validators and forward the authenticated actor", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("POST", "", body())).status, 201);
  assert.equal((await f.request("GET")).status, 200); assert.equal((await f.request("GET", `/${draftId}`)).status, 200);
  assert.equal((await f.request("PUT", `/${draftId}`, { ...body(), expectedRevision: 1 })).status, 200);
  assert.equal((await f.request("POST", `/${draftId}/publish`, { expectedRevision: 1 })).status, 200);
  assert.equal((await f.request("POST", `/${draftId}/pause`, { expectedRevision: 2 })).status, 200);
  const removed = await f.request("DELETE", `/${draftId}`, { expectedRevision: 1 }); assert.equal(removed.status, 204); assert.equal(removed.body, null);
  assert.deepEqual(f.calls.map(call => call.method), ["create", "list", "get", "replace", "publish", "pause", "remove"]);
  assert.ok(f.calls.every(call => call.args[0]._id === userId));
});

test("HTTP body validation rejects provenance/publication injection, malformed components and string money", async t => {
  const f = await fixture(t);
  for (const change of [{ origin: "ai" }, { status: "published" }, { approvedBy: userId }, { role: "superAdmin" }, { createdBy: productId },
    { price: "125.5" }, { price: -1 }, { name_ar: null }, { components: [] },
    { components: [{ ...body().components[0], stock: 100 }] }]) {
    assert.equal((await f.request("POST", "", { ...body(), ...change })).status, 400);
  }
  assert.equal((await f.request("PUT", `/${draftId}`, body())).status, 400);
  assert.equal((await f.request("DELETE", `/${draftId}`, { expectedRevision: "1" })).status, 400);
  assert.deepEqual(f.calls, []);
});

test("HTTP params, pagination and unexpected queries are validated before service calls", async t => {
  const f = await fixture(t);
  for (const path of ["/bad", `/${draftId}?role=superAdmin`, "?limit=0", "?limit=51", "?limit[]=2", "?cursor=bad", "?sort=price", "?status=scheduled", "?status[]=published"]) {
    assert.equal((await f.request("GET", path)).status, 400);
  }
  assert.equal((await f.request("GET", "?limit=2&cursor=" + draftId)).status, 200); assert.equal(f.calls.length, 1);
});

test("oversized drafts are rejected both before and after an outer JSON parser", async t => {
  for (const parsedFirst of [false, true]) {
    const f = await fixture(t, parsedFirst);
    assert.equal((await f.request("POST", "", { ...body(), desc_en: "x".repeat(20000) })).status, 413); assert.deepEqual(f.calls, []);
  }
});

test("malformed JSON returns a shared operational 400 without parser internals or service access", async t => {
  const f = await fixture(t), invalid = await f.rawJson('{"privateInput":');
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { status: "fail", error: [], message: "Invalid bundle draft JSON" });
  assert.deepEqual(f.calls, []);
});

test("inactive, banned and unverified superAdmins fail real authentication", async t => {
  const f = await fixture(t);
  for (const change of [{ active: false }, { phoneVerified: false }, { deletedAt: new Date() }, { account_status: "banned" }]) {
    const original = { ...f.actor }; Object.assign(f.actor, change);
    assert.ok([401, 403].includes((await f.request("GET")).status)); f.actor = original;
  }
  assert.deepEqual(f.calls, []);
});

test("the old publication path is absent and PUT cannot bypass the explicit publish action", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("POST", `/${draftId}/publications`, {})).status, 404);
  assert.equal((await f.request("PUT", `/${draftId}`, { ...body(), expectedRevision: 1, status: "published" })).status, 400);
  assert.deepEqual(f.calls, []);
});

function draftStore() {
  const state = { row: null, mutations: 0, reads: 0, unavailable: false, failCreate: false, stock: 10 };
  const clone = value => structuredClone(value);
  const db = {
    async requireManualBundleStore() {
      state.reads++;
      if (state.unavailable) throw new ApiError("Manual bundle draft store is not ready", 503);
    },
    async findBundleWarehouse() { return { _id: warehouseId, active: true }; },
    async findBundleWarehouses() { return [{ _id: warehouseId, active: true }]; },
    async findBundleProducts() { return [{ _id: productId, type: "SIMPLE", price: 100, isActive: true, warehouseStocks: [{ warehouse: warehouseId, quantity: state.stock }] }]; },
    async createManualBundle(values) {
      if (state.failCreate) throw Error("private database failure detail");
      state.mutations++; state.row = { ...clone(values), _id: draftId, createdAt: new Date(), updatedAt: new Date() };
      return clone(state.row);
    },
    async findBundle() { return clone(state.row); },
    async listManualBundles(cursor, limit, status) { return state.row && (!status || state.row.status === status) && (!cursor || state.row._id < cursor) ? [clone(state.row)].slice(0, limit) : []; },
    async updateManualBundle(id, revision, status, values) {
      if (!state.row || state.row._id !== id || state.row.revision !== revision || state.row.status !== status || state.row.origin !== "manual") return null;
      state.mutations++; Object.assign(state.row, clone(values), { revision: revision + 1, updatedAt: new Date() });
      return clone(state.row);
    },
    async deleteManualDraft(id, revision) {
      if (!state.row || state.row._id !== id || state.row.revision !== revision || state.row.status !== "draft" || state.row.origin !== "manual") return null;
      state.mutations++; const row = state.row; state.row = null; return clone(row);
    },
  };
  return { state, service: createBundleManagementService(db) };
}

test("composed HTTP/auth/validator/service flow preserves the saved DTO and rejects stale edits and deletion", async t => {
  const store = draftStore(), f = await fixture(t, false, store.service);
  const created = await f.request("POST", "", { ...body(), name_en: "  Fixed bundle  ", components: [
    { productId, productType: "SIMPLE", quantity: 2 }, { productId, productType: "SIMPLE", quantity: 1 }] });
  assert.equal(created.status, 201);
  const first = created.body.data.bundle;
  assert.deepEqual(Object.keys(first).sort(), ["id", "origin", "status", "revision", "name_en", "name_ar", "desc_en", "desc_ar",
    "currency", "pricePiastres", "price", "components", "createdBy", "updatedBy", "createdAt", "updatedAt",
    "publishedBy", "publishedAt", "pausedBy", "pausedAt"].sort());
  assert.equal(first.name_en, "Fixed bundle"); assert.equal(first.components[0].quantity, 3);
  assert.equal(first.components[0].variantId, null); assert.equal(first.pricePiastres, 12550);
  assert.equal(first.price, 125.5); assert.equal(first.createdBy, userId); assert.equal(first.revision, 1);
  assert.equal(first.origin, "manual"); assert.equal(first.status, "draft"); assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.deepEqual((await f.request("GET", `/${first.id}`)).body.data.bundle, first);
  assert.deepEqual((await f.request("GET", "?limit=1")).body.data, { bundles: [first], nextCursor: null });
  const competing = await Promise.all([100, 110].map(price => f.request("PUT", `/${first.id}`, { ...body(), price, expectedRevision: first.revision })));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  const saved = competing.find(result => result.status === 200).body.data.bundle;
  assert.equal(saved.revision, 2); assert.equal(saved.createdAt, first.createdAt);
  const stale = await f.request("DELETE", `/${first.id}`, { expectedRevision: first.revision });
  assert.equal(stale.status, 409); assert.deepEqual(Object.keys(stale.body).sort(), ["error", "message", "status"]);
  assert.equal(stale.body.status, "fail"); assert.deepEqual(stale.body.error, []);
  assert.deepEqual((await f.request("GET", `/${first.id}`)).body.data.bundle, saved);
  assert.equal((await f.request("DELETE", `/${first.id}`, { expectedRevision: saved.revision })).status, 204);
  assert.equal((await f.request("GET", `/${first.id}`)).status, 404);
  assert.deepEqual((await f.request("GET")).body.data, { bundles: [], nextCursor: null });
  assert.equal(store.state.mutations, 3);
});

test("composed errors use the shared response contract and never reach storage on invalid or forbidden input", async t => {
  const store = draftStore(), f = await fixture(t, false, store.service);
  const invalid = await f.request("POST", "", { ...body(), price: "125.5" });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.message, "Validation error");
  assert.ok(invalid.body.error.some(error => error.field === "price" && error.location === "body"));
  assert.equal(store.state.reads, 0); assert.equal(store.state.mutations, 0);
  f.actor.role = "admin";
  const forbidden = await f.request("POST", "", body()); assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, undefined); assert.equal(forbidden.body.status, "fail"); assert.equal(store.state.reads, 0);
  f.actor.role = "superAdmin"; store.state.unavailable = true;
  const unavailable = await f.request("POST", "", body()); assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.status, "error"); assert.equal(store.state.mutations, 0);
  store.state.unavailable = false; store.state.failCreate = true;
  const failed = await f.request("POST", "", body()); assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { status: "error", error: [], message: "Something went very wrong!" });
  assert.equal(JSON.stringify(failed.body).includes("private database"), false);
  assert.equal(failed.body.stack, undefined); assert.equal(store.state.mutations, 0);
});

test("composed manual publication and pause use saved revisions, exact stock and canonical metadata", async t => {
  const store = draftStore(), f = await fixture(t, false, store.service);
  const created = (await f.request("POST", "", body())).body.data.bundle;
  for (const action of ["publish", "pause"]) {
    for (const invalid of [{}, { expectedRevision: "1" }, { expectedRevision: 1, endsAt: "2026-12-01" },
      { expectedRevision: 1, publishedBy: userId }, { expectedRevision: 1, status: "published" }]) {
      assert.equal((await f.request("POST", `/${created.id}/${action}`, invalid)).status, 400);
    }
  }
  assert.equal(store.state.mutations, 1);
  store.state.row.pricePiastres = 0;
  assert.equal((await f.request("POST", `/${created.id}/publish`, { expectedRevision: 1 })).status, 409);
  assert.equal(store.state.row.status, "draft"); assert.equal(store.state.row.revision, 1);
  store.state.row.pricePiastres = 20001;
  assert.equal((await f.request("POST", `/${created.id}/publish`, { expectedRevision: 1 })).status, 409);
  store.state.row.pricePiastres = 12550;
  const publishedResponse = await f.request("POST", `/${created.id}/publish`, { expectedRevision: created.revision });
  assert.equal(publishedResponse.status, 200);
  const published = publishedResponse.body.data.bundle;
  assert.equal(published.status, "published"); assert.equal(published.revision, 2);
  assert.equal(published.publishedBy, userId); assert.ok(Number.isFinite(Date.parse(published.publishedAt)));
  assert.equal((await f.request("PUT", `/${created.id}`, { ...body(), expectedRevision: 2 })).status, 409);
  assert.equal((await f.request("GET", "?status=published")).body.data.bundles.length, 1);
  store.state.stock = 0;
  const paused = await f.request("POST", `/${created.id}/pause`, { expectedRevision: published.revision });
  assert.equal(paused.status, 200); assert.equal(paused.body.data.bundle.status, "paused");
  assert.equal(paused.body.data.bundle.pausedBy, userId); assert.equal(paused.body.data.bundle.revision, 3);
  assert.equal((await f.request("GET", "?status=published")).body.data.bundles.length, 0);
  assert.equal((await f.request("POST", `/${created.id}/publish`, { expectedRevision: 3 })).status, 409);
  assert.equal((await f.request("DELETE", `/${created.id}`, { expectedRevision: 3 })).status, 409);
  const edited = await f.request("PUT", `/${created.id}`, { ...body(), price: 100, expectedRevision: 3 });
  assert.equal(edited.body.data.bundle.status, "paused"); assert.equal(edited.body.data.bundle.revision, 4);
  store.state.stock = 2;
  const resumed = await f.request("POST", `/${created.id}/publish`, { expectedRevision: 4 });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.data.bundle.pricePiastres, 10000);
  assert.equal(resumed.body.data.bundle.revision, 5); assert.equal(store.state.stock, 2);
  assert.equal((await f.request("POST", `/${created.id}/pause`, { expectedRevision: 4 })).status, 409);
  assert.equal((await f.request("GET", `/${created.id}`)).body.data.bundle.status, "published");
});
