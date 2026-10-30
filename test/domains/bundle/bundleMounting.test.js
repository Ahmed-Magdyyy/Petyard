import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { createBundleRouter, bundleJsonBody } from "../../../src/domains/bundle/bundle.routes.js";
import { bundleManagementService } from "../../../src/domains/bundle/bundle.service.js";
import { bundleCatalogService } from "../../../src/domains/bundle/bundle.customer-service.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";

const U = "111111111111111111111111", W = "222222222222222222222222", B = "333333333333333333333333";
async function fixture(t) {
  for (const [key, value] of Object.entries({ JWT_ACCESS_SECRET: "bundle-mount-fixture-only", NODE_ENV: "test", ASSISTANT_BUNDLE_CART_ENABLED: "true" })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const s = { actor: { _id: U, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" }, calls: [], authReads: 0 };
  t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  t.mock.method(UserModel, "findById", async id => { s.authReads++; return String(id) === U ? s.actor : null; });
  for (const name of ["create", "get", "list", "replace", "remove", "publish", "pause"]) t.mock.method(bundleManagementService, name, async () => {
    s.calls.push(`admin:${name}`); return name === "list" ? { bundles: [], nextCursor: null } : { bundle: { id: B, origin: "manual", status: "draft", revision: 1 } };
  });
  t.mock.method(bundleCatalogService, "list", async (_actor, query) => { s.calls.push("catalog:list"); assert.equal(query.warehouseId, W); return { bundles: [], nextCursor: null }; });
  t.mock.method(bundleCatalogService, "get", async (_actor, id, query) => { s.calls.push("catalog:get"); assert.equal(id, B); assert.equal(query.warehouseId, W); return { bundle: { id: B, type: "BUNDLE" } }; });
  const app = express(); app.use("/api/v1/bundles/admin", bundleJsonBody); app.use(express.json({ limit: "5mb" }));
  app.use("/api/v1/bundles", createBundleRouter()); app.use((_req, res) => res.status(404).json({ message: "Not found" })); app.use(globalError);
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  s.request = async (path = "", { method = "GET", body, raw, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/bundles${path}`, { method,
      headers: { Authorization: `Bearer ${jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET)}`, "Content-Type": "application/json", ...headers },
      ...(raw === undefined && body === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
    return { status: response.status, cache: response.headers.get("cache-control"), body: response.status === 204 ? null : await response.json() };
  };
  return s;
}

test("the existing disabled flag rejects catalog and management before data access", async t => {
  const s = await fixture(t); delete process.env.ASSISTANT_BUNDLE_CART_ENABLED;
  for (const path of ["/admin", "", `/${B}?warehouseId=${W}&language=en`]) {
    const response = await s.request(path); assert.equal(response.status, 503); assert.equal(response.cache, "no-store");
  }
  assert.equal(s.authReads, 0); assert.deepEqual(s.calls, []);
});

test("management mounts before customer IDs while the public catalog stays warehouse-scoped", async t => {
  const s = await fixture(t);
  assert.equal((await s.request("/admin")).status, 200);
  assert.equal((await s.request("/admin", { method: "POST", body: { name_en: "Pair", price: 15, components: [{ productId: B, productType: "SIMPLE", quantity: 2 }] } })).status, 201);
  const list = await s.request(`?warehouseId=${W}&language=en`); assert.equal(list.status, 200); assert.equal(list.cache, "private, no-store");
  assert.equal((await s.request(`/${B}?warehouseId=${W}&language=en`)).status, 200);
  assert.deepEqual(s.calls, ["admin:list", "admin:create", "catalog:list", "catalog:get"]);
  assert.equal((await s.request("?language=en")).status, 400); assert.equal(s.calls.length, 4);
});

test("public catalog access preserves JWT and SuperAdmin requirements on management paths", async t => {
  const s = await fixture(t);
  assert.equal((await s.request("/admin", { headers: { Authorization: "", "x-guest-id": "guest" } })).status, 401);
  assert.equal((await s.request(`?warehouseId=${W}&language=en`, { headers: { Authorization: "" } })).status, 200);
  for (const role of ["user", "admin", "moderator"]) { s.actor.role = role; assert.equal((await s.request("/admin")).status, 403); }
  s.actor.role = "user"; assert.equal((await s.request(`?warehouseId=${W}&language=en`)).status, 200);
  assert.deepEqual(s.calls, ["catalog:list", "catalog:list"]);
});

test("the pre-parser enforces 16 KiB before the app's larger parser and safely maps malformed JSON", async t => {
  const s = await fixture(t);
  const large = await s.request("/admin", { method: "POST", raw: " ".repeat(17000) + "{}" }); assert.equal(large.status, 413); assert.equal(large.cache, "no-store");
  const malformed = await s.request("/admin", { method: "POST", raw: '{"privateInput":' }); assert.equal(malformed.status, 400);
  assert.equal(malformed.cache, "no-store");
  assert.equal(malformed.body.message, "Invalid bundle draft JSON"); assert.deepEqual(s.calls, []);
});

test("application wiring registers these exact paths and the bounded parser before general JSON parsing", () => {
  const routes = readFileSync(new URL("../../../src/app/routes.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../../src/app/server.js", import.meta.url), "utf8");
  assert.match(routes, /app\.use\("\/api\/v1\/bundles", bundleRoutes\)/);
  const bounded = server.indexOf('app.use("/api/v1/bundles/admin", bundleJsonBody)');
  assert.ok(bounded >= 0 && bounded < server.indexOf('app.use(express.json({ limit: "5mb" }))'));
});
