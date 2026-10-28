import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import analyticsRouter from "../../../src/domains/analytics/analytics.routes.js";
import { getHighestProductsService } from "../../../src/domains/analytics/analytics.highest-products.js";
import { getTopProductsService } from "../../../src/domains/analytics/analytics.service.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";

const now = new Date("2026-10-19T12:00:00Z");
const productId = "111111111111111111111111";

test("highest ranking requires the explicit measure and rejects invalid query fields before reads", async (t) => {
  let reads = 0; t.mock.method(OrderModel, "aggregate", () => { reads += 1; throw new Error("Unexpected query"); });
  const base = { month: "2026-09", metric: "units" };
  for (const query of [{}, { month: "2026-09" }, { ...base, metric: "profit" }, { ...base, metric: ["units"] },
    { ...base, month: "2026-11" }, { ...base, warehouse: { $ne: null } }, { ...base, limit: "51" },
    { ...base, limit: "1.5" }, { ...base, sort: "total" }, { ...base, includeInactive: "true" }]) {
    await assert.rejects(getHighestProductsService(query, now), (error) => error.statusCode === 400);
  }
  assert.equal(reads, 0);
});

test("highest ranking applies descending selected metric, preserves missing catalog rows and allowlists output", async (t) => {
  const calls = [];
  t.mock.method(OrderModel, "aggregate", (pipeline) => {
    const call = { pipeline }; calls.push(call);
    return Object.assign(Promise.resolve([{ _id: productId, unitsSold: 8, recordedItemValue: 80, catalogPresent: false,
      name_en: null, name_ar: null, imageUrl: null, private: "hidden" }]), { option(options) { call.options = options; return this; } });
  });
  const result = await getHighestProductsService({ month: "2026-09", metric: "units", warehouse: productId }, now);
  assert.equal(result.limit, 5); assert.equal(result.definition.eligibility, "recorded_sales");
  assert.equal(result.definition.currency, null); assert.equal(result.definition.zeroSalesIncluded, false);
  assert.deepEqual(result.results, [{ productId, unitsSold: 8, recordedItemValue: 80, catalogPresent: false, name_en: null, name_ar: null, imageUrl: null }]);
  assert.equal(calls[0].options.maxTimeMS, 5000);
  assert.deepEqual(calls[0].pipeline.find((stage) => stage.$sort).$sort, { unitsSold: -1, _id: 1 });
  assert.equal(String(calls[0].pipeline[0].$match.warehouse), productId);
  assert.equal(calls[0].pipeline[0].$match.createdAt.$gte.toISOString(), "2026-08-31T21:00:00.000Z");
  assert.equal(calls[0].pipeline[0].$match.createdAt.$lt.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.ok(calls[0].pipeline.some((stage) => stage.$unwind?.preserveNullAndEmptyArrays === true));
  assert.doesNotMatch(JSON.stringify(calls[0].pipeline), /isActive|warehouseStocks|unionWith/);
  await getHighestProductsService({ month: "2026-10", metric: "item_value", limit: "50" }, now);
  assert.deepEqual(calls[1].pipeline.find((stage) => stage.$sort).$sort, { recordedItemValue: -1, _id: 1 });
  assert.equal(calls[1].pipeline[0].$match.createdAt.$lt.toISOString(), now.toISOString());
});

test("legacy top-products aggregation remains identical after extracting its calculation", async (t) => {
  let captured;
  t.mock.method(OrderModel, "aggregate", async (pipeline) => { captured = pipeline; return []; });
  assert.deepEqual(await getTopProductsService({}), { topProducts: [] });
  const quantity = { $ifNull: ["$items.fulfillmentQuantity", { $ifNull: ["$items.quantity", 0] }] };
  const expected = [
    { $match: { status: { $nin: ["cancelled", "returned"] } } },
    { $unwind: "$items" }, { $match: { $expr: { $gt: [quantity, 0] } } },
    { $group: { _id: "$items.product", totalIncome: { $sum: { $multiply: [quantity, { $ifNull: ["$items.itemPrice", 0] }] } },
      totalQuantitySold: { $sum: quantity } } },
    { $sort: { totalIncome: -1, totalQuantitySold: -1 } }, { $limit: 5 },
    { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, productId: "$_id", name: { $ifNull: ["$product.name_en", "Deleted Product"] },
      imageUrl: { $ifNull: [{ $arrayElemAt: ["$product.images.url", 0] }, null] }, totalQuantitySold: 1, totalIncome: 1 } },
  ];
  assert.deepEqual(captured, expected);
  await getTopProductsService({ from: "2026-08-31T21:00:00Z", to: "2026-09-30T20:59:59.999Z", warehouse: productId, limit: "7" });
  expected[0].$match.createdAt = { $gte: new Date("2026-08-31T21:00:00Z"), $lte: new Date("2026-09-30T20:59:59.999Z") };
  expected[0].$match.warehouse = new mongoose.Types.ObjectId(productId); expected[5].$limit = 7;
  assert.deepEqual(captured, expected);
});

test("highest ranking sanitizes database and invalid-number failures", async (t) => {
  const query = { month: "2026-09", metric: "units" };
  const failure = t.mock.method(OrderModel, "aggregate", () => { throw new Error("private database details"); });
  await assert.rejects(getHighestProductsService(query, now), (error) => error.statusCode === 503 && error.message === "Highest-selling products are currently unavailable");
  failure.mock.restore();
  t.mock.method(OrderModel, "aggregate", () => ({ option: async () => [{ _id: productId, unitsSold: 1, recordedItemValue: NaN }] }));
  await assert.rejects(getHighestProductsService(query, now), (error) => error.statusCode === 503);
});

test("highest ranking HTTP uses current analytics permissions and no-store responses", async (t) => {
  const prior = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "local-highest-products-only";
  t.after(() => { if (prior === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = prior; });
  const user = { _id: new mongoose.Types.ObjectId(), role: "superAdmin", active: true, phoneVerified: true, enabledControls: [] };
  t.mock.method(UserModel, "findById", async () => user);
  let reads = 0; t.mock.method(OrderModel, "aggregate", () => { reads += 1; return { option: async () => [] }; });
  const app = express(); app.use("/analytics", analyticsRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/analytics/orders/highest-products?month=2020-09&metric=units`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_ACCESS_SECRET)}` };
  assert.equal((await fetch(url)).status, 401); assert.equal(reads, 0);
  const response = await fetch(url, { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.deepEqual((await response.json()).data.results, []);
  reads = 0;
  for (const role of ["user", "moderator", "admin"]) { user.role = role; user.enabledControls = ["products"];
    assert.equal((await fetch(url + "&role=superAdmin", { headers })).status, 403); }
  assert.equal(reads, 0); user.enabledControls = ["analytics"];
  assert.equal((await fetch(url, { headers })).status, 200);
  user.enabledControls = []; assert.equal((await fetch(url, { headers })).status, 403);
  user.role = "superAdmin"; user.phoneVerified = false; assert.equal((await fetch(url, { headers })).status, 403);
  user.phoneVerified = true; user.active = false; assert.equal((await fetch(url, { headers })).status, 401);
  user.active = true; assert.equal((await fetch(url + "&warehouse[$ne]=null", { headers })).status, 400);
});
