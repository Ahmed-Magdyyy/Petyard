import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { ApiError } from "../../../src/shared/utils/ApiError.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { createBundleCatalogService } from "../../../src/domains/bundle/bundle.customer-service.js";
import { createBundleCatalogRouter } from "../../../src/domains/bundle/bundle.customer-routes.js";

const user = "a00000000000000000000001", p = "b00000000000000000000001", w = "c00000000000000000000001", other = "c00000000000000000000002";
const id = number => "d" + String(number).padStart(23, "0");
const parameters = `warehouseId=${w}&language=en`;
async function fixture(t) {
  const previousKey = process.env.JWT_ACCESS_SECRET, previousMode = process.env.NODE_ENV;
  process.env.JWT_ACCESS_SECRET = "synthetic-bundle-catalog-http"; process.env.NODE_ENV = "test";
  t.after(() => {
    if (previousKey === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousKey;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
  });
  t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  const f = { actor: { _id: user, role: "user", active: true, phoneVerified: true, account_status: "confirmed" }, reads: [],
    rows: [{ _id: id(1), origin: "manual", status: "published", revision: 2, name_en: "Bundle", name_ar: "باكدج",
      pricePiastres: 12550, createdBy: "private staff", components: [{ productId: p, productType: "SIMPLE", quantity: 2 }] }],
    warehouse: { _id: w, active: true }, product: { _id: p, type: "SIMPLE", isActive: true, name_en: "Food", price: 100,
      warehouseStocks: [{ warehouse: w, quantity: 7 }, { warehouse: other, quantity: 100 }] } };
  t.mock.method(UserModel, "findById", async value => String(value) === user ? f.actor : null);
  f.products = [f.product]; f.productWarehouses = [];
  const db = {
    async requireBundleCatalogStore() { f.reads.push("ready"); if (f.unready) throw new ApiError("Catalog unavailable", 503); },
    async findBundleWarehouse(value) { f.reads.push("warehouse"); return value === w ? structuredClone(f.warehouse) : { _id: value, active: true }; },
    async listPublishedBundles(cursor, limit) { f.reads.push("list"); return structuredClone(f.rows.filter(row => row.status === "published" && row.origin === "manual" && (!cursor || row._id < cursor))
      .sort((a, b) => b._id.localeCompare(a._id)).slice(0, limit)); },
    async findPublishedBundle(value) { f.reads.push("get"); return structuredClone(f.rows.find(row => row._id === value && row.status === "published" && row.origin === "manual") ?? null); },
    async findBundleProducts(ids, warehouseId) { f.reads.push("products"); f.productWarehouses.push(warehouseId); return structuredClone(f.products.filter(row => ids.includes(row._id))); },
  };
  const app = express(); app.use("/bundles", createBundleCatalogRouter({ application: createBundleCatalogService(db) }));
  app.use((_req, res) => res.status(404).json({ message: "Route not found" })); app.use(globalError);
  const server = await new Promise((resolve, reject) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); instance.on("error", reject); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/bundles`, token = jwt.sign({ userId: user }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" });
  f.request = async (path = "", headers = {}, method = "GET") => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...headers } });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return { status: response.status, body: await response.json() };
  };
  f.withBody = () => new Promise((resolve, reject) => {
    const body = '{"warehouseId":"' + other + '"}', req = http.request(base + "?" + parameters, { method: "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
      let data = ""; response.setEncoding("utf8"); response.on("data", chunk => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    }); req.on("error", reject); req.end(body);
  });
  return f;
}

test("public catalog list/detail work without a login or guest identity and never load an account", async t => {
  const f = await fixture(t);
  t.mock.method(UserModel, "findById", () => assert.fail("Public catalog must not load user accounts"));
  for (const path of [`?${parameters}`, `/${id(1)}?${parameters}`]) {
    assert.equal((await f.request(path, { authorization: "" })).status, 200);
    assert.equal((await f.request(path, { authorization: "", "x-guest-id": "guest" })).status, 200);
    assert.equal((await f.request(path, { authorization: "Bearer invalid" })).status, 200);
  }
  assert.ok(f.reads.includes("products"));
});

test("customer HTTP strictly validates required warehouse/language, IDs, filters and body absence", async t => {
  const f = await fixture(t);
  for (const path of ["", "?language=en", `?warehouseId=${w}`, `?${parameters}&status=draft`, `?${parameters}&ownerId=${user}`,
    `?${parameters}&warehouseId=${other}`, `?${parameters}&limit[]=1`, `?${parameters}&limit=51`, `?${parameters}&cursor=bad`,
    `/bad?${parameters}`, `/${id(1)}?${parameters}&limit=2`, `?warehouseId=${w}&language=arabizi`]) {
    assert.equal((await f.request(path)).status, 400);
  }
  assert.equal((await f.withBody()).status, 400); assert.deepEqual(f.reads, []);
});

test("composed customer list/detail use actual service and shared response contract with product-like fields", async t => {
  const f = await fixture(t), list = await f.request(`?${parameters}`);
  assert.equal(list.status, 200); assert.equal(list.body.nextCursor, null); assert.equal(list.body.results, 1);
  const card = list.body.data[0]; assert.equal(card.type, "BUNDLE"); assert.equal(card.price, 200);
  assert.equal(card.discountedPrice, 125.5); assert.equal(card.stock, 3); assert.equal(card.warehouseId, w);
  assert.equal(JSON.stringify(card).includes("private staff"), false);
  const detail = await f.request(`/${card.id}?warehouseId=${w}&language=ar`);
  assert.equal(detail.status, 200); assert.equal(detail.body.data.name, "باكدج");
  assert.equal(detail.body.data.revision, card.revision);
  for (const role of ["admin", "moderator", "superAdmin"]) { f.actor.role = role; assert.equal((await f.request(`?${parameters}`)).status, 200); }
});

test("wrong warehouse, paused records and depleted selected-warehouse stock are unavailable without fallback or writes", async t => {
  const f = await fixture(t);
  f.product.warehouseStocks[1].quantity = 1;
  assert.deepEqual((await f.request(`?warehouseId=${other}&language=en`)).body, { data: [], results: 0, nextCursor: null });
  assert.equal((await f.request(`/${id(1)}?warehouseId=${other}&language=en`)).status, 404);
  f.product.warehouseStocks[0].quantity = 1;
  assert.equal((await f.request(`/${id(1)}?${parameters}`)).status, 404);
  assert.deepEqual((await f.request(`?${parameters}`)).body.data, []);
  f.product.warehouseStocks[0].quantity = 7; f.rows[0].status = "paused";
  assert.equal((await f.request(`/${id(1)}?${parameters}`)).status, 404);
  assert.equal((await f.request(`/${id(1)}/publish?${parameters}`, {}, "POST")).status, 404);
  assert.equal(f.rows[0].status, "paused"); assert.equal(f.product.warehouseStocks[0].quantity, 7);
});

test("empty filtered HTTP pages keep a cursor for later eligible bundles and re-read current price", async t => {
  const f = await fixture(t); f.rows.push({ ...structuredClone(f.rows[0]), _id: id(2), pricePiastres: 20100 });
  const first = await f.request(`?${parameters}&limit=1`);
  assert.deepEqual(first.body, { data: [], results: 0, nextCursor: id(2) });
  f.product.price = 90;
  const second = await f.request(`?${parameters}&limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(second.body.data[0].id, id(1)); assert.equal(second.body.data[0].price, 180);
  assert.equal(second.body.data[0].discountedPrice, 125.5); assert.equal(second.body.nextCursor, null);
});

test("shared HTTP errors distinguish unavailable store/warehouse from a successful empty catalog", async t => {
  const f = await fixture(t); f.unready = true;
  const unavailable = await f.request(`?${parameters}`); assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { status: "error", error: [], message: "Catalog unavailable" });
  assert.deepEqual(f.reads, ["ready"]);
  f.unready = false; f.warehouse.active = false;
  assert.equal((await f.request(`?${parameters}`)).status, 409);
  assert.equal(f.reads.includes("list"), false);
});

test("the same bundle is automatically visible in warehouses 2 and 4 while 1 and 3 lack a required component", async t => {
  const f = await fixture(t), warehouse = n => "c" + String(n).padStart(23, "0"), q = "b00000000000000000000002";
  f.rows[0].components.push({ productId: q, productType: "SIMPLE", quantity: 1 });
  f.product.warehouseStocks = [1, 2, 4].map(n => ({ warehouse: warehouse(n), quantity: 5 }));
  f.products.push({ _id: q, type: "SIMPLE", price: 50, isActive: true, warehouseStocks: [2, 3, 4].map(n => ({ warehouse: warehouse(n), quantity: 3 })) });
  for (const number of [1, 2, 3, 4]) {
    const response = await f.request(`?warehouseId=${warehouse(number)}&language=en`);
    assert.equal(response.status, 200); assert.equal(response.body.data.length, [2, 4].includes(number) ? 1 : 0);
    assert.equal(f.productWarehouses.at(-1), warehouse(number));
    if (response.body.data[0]) { assert.equal(response.body.data[0].id, id(1)); assert.equal(response.body.data[0].warehouseId, warehouse(number)); }
  }
});

test("four-warehouse HTTP reads keep stock independent during depletion and restock without writing inventory", async t => {
  const f = await fixture(t), warehouse = n => "c" + String(n).padStart(23, "0"), q = "b00000000000000000000002";
  f.rows[0].components = [{ productId: p, productType: "SIMPLE", quantity: 2 }, { productId: q, productType: "SIMPLE", quantity: 3 }];
  f.product.warehouseStocks = [10, 9, 0, 20].map((quantity, i) => ({ warehouse: warehouse(i + 1), quantity }));
  const second = { _id: q, type: "SIMPLE", price: 50, isActive: true,
    warehouseStocks: [0, 12, 30, 6].map((quantity, i) => ({ warehouse: warehouse(i + 1), quantity })) };
  f.products.push(second);
  const availability = async () => {
    const before = structuredClone(f.products), result = [];
    for (const n of [1, 2, 3, 4]) {
      const response = await f.request(`?warehouseId=${warehouse(n)}&language=en`); assert.equal(response.status, 200);
      result.push(response.body.data[0]?.stock ?? 0);
      if (response.body.data[0]) assert.equal(response.body.data[0].warehouseId, warehouse(n));
    }
    assert.deepEqual(f.products, before); return result;
  };
  assert.deepEqual(await availability(), [0, 4, 0, 2]);
  f.product.warehouseStocks[1].quantity = 0;
  assert.deepEqual(await availability(), [0, 0, 0, 2]);
  second.warehouseStocks[0].quantity = 6; second.warehouseStocks[3].quantity = 2;
  assert.deepEqual(await availability(), [2, 0, 0, 0]);
  assert.equal(f.rows[0].revision, 2); assert.equal(f.rows[0].status, "published");
});
