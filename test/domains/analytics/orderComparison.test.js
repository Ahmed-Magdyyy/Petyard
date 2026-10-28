import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { getOrderComparisonService } from "../../../src/domains/analytics/analytics.order-comparison.js";
import { getOrdersOverviewService } from "../../../src/domains/analytics/analytics.service.js";
import analyticsRouter from "../../../src/domains/analytics/analytics.routes.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";

const now = new Date("2026-11-15T12:00:00Z");
const warehouse = "111111111111111111111111";

function mockOverviews(t, metricsFor = () => ({ totalSales: 0, totalOrders: 0, avgOrderValue: 0 })) {
  const calls = [];
  t.mock.method(OrderModel, "aggregate", (pipeline) => {
    const call = { pipeline }; calls.push(call);
    const match = pipeline[0].$match;
    const result = pipeline[1].$group?._id === null ? [metricsFor(match.createdAt.$gte)] : [];
    return Object.assign(Promise.resolve(result), { option(options) { call.options = options; return this; } });
  });
  return calls;
}

test("comparison reuses dashboard populations and exact Cairo DST month boundaries without changing the old overview", async (t) => {
  const calls = mockOverviews(t, (start) => start.getUTCMonth() === 8
    ? { totalSales: 1200, totalOrders: 3, avgOrderValue: 400 }
    : { totalSales: 1000, totalOrders: 2, avgOrderValue: 500 });
  const result = await getOrderComparisonService({ month: "2026-10", compareTo: "2026-09", warehouse }, now);
  assert.deepEqual(result.changes.totalSales, { absolute: 200, percentage: 20, percentageUnavailableReason: null });
  assert.equal(result.changes.totalOrders.absolute, 1); assert.equal(result.changes.totalOrders.percentage, 50);
  assert.deepEqual(result.changes.avgOrderValue, { absolute: -100, percentage: -20, percentageUnavailableReason: null });
  assert.equal(result.periods.current.start, "2026-09-30T21:00:00.000Z");
  assert.equal(result.periods.current.endExclusive, "2026-10-31T22:00:00.000Z");
  assert.equal(result.periods.current.partial, false);
  assert.equal(result.periods.baseline.start, "2026-08-31T21:00:00.000Z");
  assert.equal(result.filters.warehouse, warehouse); assert.equal(result.definition.currency, null);
  assert.equal(result.definition.currencyTreatment, "not_partitioned_or_converted");
  assert.equal(result.consistency, "live_independent_reads");
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ pipeline, options }) => options.maxTimeMS === 5000 && String(pipeline[0].$match.warehouse) === warehouse));
  assert.ok(calls.filter(({ pipeline }) => pipeline[0].$match.status).every(({ pipeline }) =>
    JSON.stringify(pipeline[0].$match.status) === JSON.stringify({ $nin: ["cancelled", "returned"] }) && !pipeline[0].$match.paymentStatus));
  assert.equal(calls[0].pipeline[0].$match.createdAt.$lte.toISOString(), "2026-10-31T21:59:59.999Z");
  const old = await getOrdersOverviewService({ from: "2026-09-30T21:00:00Z", to: "2026-10-31T21:59:59.999Z" });
  assert.deepEqual(old, { totalSales: 1200, totalOrders: 3, avgOrderValue: 400, salesByPaymentMethod: {}, statusBreakdown: {} });
  assert.ok(calls.slice(6).every((call) => call.options === undefined));
});

test("current-month clipping, leap February and zero baselines have explicit semantics", async (t) => {
  const calls = mockOverviews(t);
  const current = await getOrderComparisonService({ month: "2026-11", compareTo: "2024-02" }, now);
  assert.equal(current.periods.current.partial, true);
  assert.equal(current.periods.current.observedThroughExclusive, now.toISOString());
  assert.equal(calls[0].pipeline[0].$match.createdAt.$lte.toISOString(), "2026-11-15T11:59:59.999Z");
  assert.equal(current.periods.baseline.start, "2024-01-31T22:00:00.000Z");
  assert.equal(current.periods.baseline.endExclusive, "2024-02-29T22:00:00.000Z");
  assert.equal(current.filters.warehouse, null);
  for (const change of Object.values(current.changes)) assert.deepEqual(change,
    { absolute: 0, percentage: null, percentageUnavailableReason: "zero_baseline" });
  const same = await getOrderComparisonService({ month: "2026-09", compareTo: "2026-09" }, now);
  assert.equal(same.changes.totalSales.absolute, 0);
});

test("positive-to-zero baseline never invents a percentage and money deltas are rounded", async (t) => {
  mockOverviews(t, (start) => start.getUTCMonth() === 8 ? { totalSales: 0.3, totalOrders: 2, avgOrderValue: 0.15 }
    : { totalSales: 0, totalOrders: 0, avgOrderValue: 0 });
  const result = await getOrderComparisonService({ month: "2026-10", compareTo: "2026-09" }, now);
  assert.deepEqual(result.changes.totalSales, { absolute: 0.3, percentage: null, percentageUnavailableReason: "zero_baseline" });
  assert.deepEqual(result.changes.totalOrders, { absolute: 2, percentage: null, percentageUnavailableReason: "zero_baseline" });
});

test("strict service validation rejects unbounded, ambiguous and injected fields before querying", async (t) => {
  const calls = mockOverviews(t);
  const base = { month: "2026-09", compareTo: "2026-08" };
  for (const query of [null, [], {}, { ...base, month: "2026-9" }, { ...base, month: "0000-01" },
    { ...base, month: "2026-13" }, { ...base, month: "2026-12" }, { ...base, compareTo: "2027-01" },
    { ...base, month: ["2026-09"] }, { ...base, warehouse: { $ne: null } }, { ...base, warehouse: "bad" },
    { ...base, warehouse: null }, { ...base, from: "2026-09-01" }, { ...base, role: "superAdmin" }]) {
    await assert.rejects(getOrderComparisonService(query, now), (error) => error.statusCode === 400);
  }
  assert.equal(calls.length, 0);
});

test("database failures and invalid aggregates fail closed with a sanitized 503", async (t) => {
  const failure = t.mock.method(OrderModel, "aggregate", () => { throw new Error("mongodb secret and internal query"); });
  await assert.rejects(getOrderComparisonService({ month: "2026-09", compareTo: "2026-08" }, now), (error) =>
    error.statusCode === 503 && error.message === "Order comparison is currently unavailable");
  failure.mock.restore();
  mockOverviews(t, () => ({ totalSales: Infinity, totalOrders: 1, avgOrderValue: 1 }));
  await assert.rejects(getOrderComparisonService({ month: "2026-09", compareTo: "2026-08" }, now), (error) => error.statusCode === 503);
});

test("real analytics HTTP permissions use fresh identity/control checks before the comparison", async (t) => {
  const prior = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "local-comparison-test-only";
  t.after(() => { if (prior === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = prior; });
  const user = { _id: new mongoose.Types.ObjectId(), role: "superAdmin", active: true, phoneVerified: true, enabledControls: [] };
  t.mock.method(UserModel, "findById", async () => user);
  const calls = mockOverviews(t);
  const app = express(); app.use("/api/v1/analytics", analyticsRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/analytics/orders/comparison?month=2020-09&compareTo=2020-08`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_ACCESS_SECRET)}` };
  assert.equal((await fetch(url)).status, 401); assert.equal(calls.length, 0);
  const authorized = await fetch(url, { headers }); assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get("cache-control"), "no-store");
  assert.equal((await authorized.json()).data.definition.id, "dashboard_order_totals_v1");
  calls.length = 0;
  for (const role of ["user", "moderator", "admin"]) {
    user.role = role;
    assert.equal((await fetch(url + "&role=superAdmin", { headers })).status, 403);
  }
  assert.equal(calls.length, 0);
  user.enabledControls = ["analytics"];
  assert.equal((await fetch(url, { headers })).status, 200);
  user.enabledControls = []; assert.equal((await fetch(url, { headers })).status, 403);
  user.role = "superAdmin"; user.phoneVerified = false;
  assert.equal((await fetch(url, { headers })).status, 403);
  user.phoneVerified = true; user.active = false;
  assert.equal((await fetch(url, { headers })).status, 401);
  user.active = true;
  assert.equal((await fetch(url + "&warehouse[$ne]=null", { headers })).status, 400);
  assert.equal((await fetch(url + "&month=2020-10", { headers })).status, 400);
});
