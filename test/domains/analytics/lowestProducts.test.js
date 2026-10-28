import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import analyticsRouter from "../../../src/domains/analytics/analytics.routes.js";
import { getLowestProductsService } from "../../../src/domains/analytics/analytics.lowest-products.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";

const now = new Date("2026-10-19T12:00:00Z");
const warehouse = "111111111111111111111111";

test("lowest products validates explicit metric and bounded inputs before database access", async (t) => {
  let calls = 0; t.mock.method(OrderModel, "aggregate", () => { calls += 1; throw new Error("Unexpected query"); });
  const base = { month: "2026-09", metric: "units" };
  for (const query of [null, [], {}, { month: "2026-09" }, { ...base, metric: "profit" }, { ...base, month: "2026-9" },
    { ...base, month: "2026-11" }, { ...base, month: ["2026-09"] }, { ...base, warehouse: { $ne: null } },
    { ...base, limit: "0" }, { ...base, limit: "51" }, { ...base, limit: "1.5" }, { ...base, limit: ["5"] },
    { ...base, limit: "5e0" }, { ...base, sort: "desc" }, { ...base, includeInactive: "true" }]) {
    await assert.rejects(getLowestProductsService(query, now), (error) => error.statusCode === 400);
  }
  assert.equal(calls, 0);
});

test("lowest products uses one bounded union aggregation, allowlisted output and explicit eligibility metadata", async (t) => {
  const calls = [];
  t.mock.method(OrderModel, "aggregate", (pipeline) => {
    const call = { pipeline }; calls.push(call);
    return Object.assign(Promise.resolve([{ _id: warehouse, name_en: "Food", name_ar: "أكل", imageUrl: null,
      unitsSold: 0, recordedItemValue: 0, privateInternalField: "must not escape" }]),
    { option(options) { call.options = options; return this; } });
  });
  const result = await getLowestProductsService({ month: "2026-09", metric: "units", warehouse }, now);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.maxTimeMS, 5000);
  assert.equal(result.limit, 5); assert.equal(result.definition.zeroSalesIncluded, true);
  assert.equal(result.definition.stockAvailabilityAdjusted, false); assert.equal(result.definition.currency, null);
  assert.equal(result.definition.eligibility, "currently_active_created_before_period");
  assert.deepEqual(result.results[0], { productId: warehouse, name_en: "Food", name_ar: "أكل", imageUrl: null, unitsSold: 0, recordedItemValue: 0 });
  const union = calls[0].pipeline.find((stage) => stage.$unionWith).$unionWith;
  assert.equal(union.pipeline[0].$match.isActive, true);
  assert.equal(union.pipeline[0].$match.createdAt.$lt.toISOString(), "2026-08-31T21:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(union), /quantity/);
  assert.deepEqual(calls[0].pipeline.find((stage) => stage.$sort).$sort, { unitsSold: 1, _id: 1 });
  await getLowestProductsService({ month: "2026-10", metric: "item_value", limit: "50" }, now);
  assert.deepEqual(calls[1].pipeline.find((stage) => stage.$sort).$sort, { recordedItemValue: 1, _id: 1 });
});

test("lowest products sanitizes query failure and rejects non-finite aggregates", async (t) => {
  const failure = t.mock.method(OrderModel, "aggregate", () => { throw new Error("private database credentials"); });
  await assert.rejects(getLowestProductsService({ month: "2026-09", metric: "units" }, now), (error) =>
    error.statusCode === 503 && error.message === "Lowest-selling products are currently unavailable");
  failure.mock.restore();
  t.mock.method(OrderModel, "aggregate", () => ({ option: async () => [{ _id: warehouse, unitsSold: Infinity, recordedItemValue: 0 }] }));
  await assert.rejects(getLowestProductsService({ month: "2026-09", metric: "units" }, now), (error) => error.statusCode === 503);
});

test("all five existing analytics HTTP contracts retain lifetime defaults, filters, validation and permissions", async (t) => {
  const previousSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "local-analytics-compatibility";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; });
  const user = { _id: new mongoose.Types.ObjectId(), role: "superAdmin", active: true, phoneVerified: true, enabledControls: [] };
  const pipelines = [];
  for (const model of Object.values(mongoose.models)) {
    t.mock.method(model, "aggregate", (pipeline) => { pipelines.push(pipeline); return Object.assign(Promise.resolve([]), { option() { return this; } }); });
    t.mock.method(model, "countDocuments", async () => 0);
  }
  t.mock.method(UserModel, "findById", async () => user);
  const app = express(); app.use("/analytics", analyticsRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/analytics`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_ACCESS_SECRET)}` };
  const stats = { sales: { totalOrderSales: 0, totalServiceIncome: 0, totalOrders: 0, avgOrderValue: 0 },
    refunds: { totalReturnRequests: 0, pending: 0, approved: 0, rejected: 0, totalRefundAmount: 0, totalWalletRefund: 0 },
    customers: { total: 0 }, products: { total: 0, active: 0, inactive: 0 }, pets: { total: 0 },
    coupons: { active: 0, totalUsageInPeriod: 0 }, reviews: { productReviews: 0, serviceReviews: 0, avgProductRating: 0, avgServiceRating: 0 },
    carts: { active: 0, abandoned: 0 }, appDownloads: { overallDownloads: { total: 0, android: 0, ios: 0 }, inRangeDownloads: { total: 0, android: 0, ios: 0 } } };
  const legacy = [
    ["/orders", { totalSales: 0, totalOrders: 0, avgOrderValue: 0, salesByPaymentMethod: {}, statusBreakdown: {} }],
    ["/orders/top-products", { topProducts: [] }],
    ["/services", { totalIncome: 0, totalReservations: 0, avgReservationValue: 0, incomeByType: {}, statusBreakdown: {} }],
    ["/stats", stats], ["/sales-chart", { chart: [] }],
  ];
  for (const [route, expected] of legacy) {
    const response = await fetch(base + route, { headers }); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { appliedFilters: { timeRange: { from: null, to: null, type: "lifetime" } }, data: expected });
    assert.equal((await fetch(base + route + "?from=2026-09-01", { headers })).status, 400);
  }
  const oldTop = pipelines.find((pipeline) => pipeline.some((stage) => stage.$unwind === "$items"));
  assert.deepEqual(oldTop.find((stage) => stage.$sort).$sort, { totalIncome: -1, totalQuantitySold: -1 });
  assert.equal(oldTop.find((stage) => stage.$limit).$limit, 5);
  const filtered = await fetch(base + `/orders?from=2026-09-01&to=2026-09-30&warehouse=${warehouse}`, { headers });
  assert.deepEqual((await filtered.json()).appliedFilters, { timeRange: { from: "2026-09-01", to: "2026-09-30", type: "custom" }, warehouse });
  assert.equal((await fetch(base + "/orders/top-products?limit=51", { headers })).status, 400);
  const newRoute = "/orders/lowest-products?month=2020-09&metric=units";
  const report = await fetch(base + newRoute, { headers }); assert.equal(report.status, 200);
  assert.equal(report.headers.get("cache-control"), "no-store");
  assert.deepEqual((await report.json()).data.results, []);
  for (const route of [...legacy.map(([path]) => path), newRoute]) {
    assert.equal((await fetch(base + route)).status, 401);
    user.role = "admin"; user.enabledControls = ["products"];
    assert.equal((await fetch(base + route, { headers })).status, 403);
    user.role = "moderator"; assert.equal((await fetch(base + route, { headers })).status, 403);
  }
  user.role = "admin"; user.enabledControls = ["analytics"];
  assert.equal((await fetch(base + newRoute, { headers })).status, 200);
  user.enabledControls = []; assert.equal((await fetch(base + newRoute, { headers })).status, 403);
});
