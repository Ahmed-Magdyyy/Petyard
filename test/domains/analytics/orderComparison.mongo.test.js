import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { getOrderComparisonService } from "../../../src/domains/analytics/analytics.order-comparison.js";
import { getOrdersOverviewService } from "../../../src/domains/analytics/analytics.service.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "../assistant/fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "../assistant/fixtures/mongoCleanup.js";

test("isolated Mongo comparison matches dashboard totals, statuses, warehouse and Cairo boundaries", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`; let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true;
  t.diagnostic(`assistant_test_database=${database}`);
  const warehouse = new mongoose.Types.ObjectId(); const other = new mongoose.Types.ObjectId();
  const fixtures = [
    ["2026-07-31T20:59:59.999Z", "delivered", 9999],
    ["2026-07-31T21:00:00.000Z", "pending", 1000],
    ["2026-08-31T20:59:59.999Z", "accepted", 200],
    ["2026-08-31T21:00:00.000Z", "awaiting_payment", 500],
    ["2026-09-15T12:00:00.000Z", "delivered", 700],
    ["2026-09-30T20:59:59.999Z", "failed", 100],
    ["2026-09-30T21:00:00.000Z", "delivered", 9999],
    ["2026-09-15T12:00:00.000Z", "cancelled", 9999],
    ["2026-09-15T12:00:00.000Z", "returned", 9999],
  ].map(([createdAt, status, total], index) => ({ _id: new mongoose.Types.ObjectId(), orderNumber: `comparison-${index}`,
    warehouse, createdAt: new Date(createdAt), status, total, paymentMethod: "cod", currency: status === "failed" ? "USD" : "EGP" }));
  fixtures.push({ _id: new mongoose.Types.ObjectId(), orderNumber: "comparison-other", warehouse: other,
    createdAt: new Date("2026-09-15T12:00:00Z"), status: "delivered", total: 5000, paymentMethod: "cod", currency: "EGP" });
  await OrderModel.collection.insertMany(fixtures);
  const now = new Date("2026-10-19T12:00:00Z");
  const comparison = await getOrderComparisonService({ month: "2026-09", compareTo: "2026-08", warehouse: String(warehouse) }, now);
  assert.deepEqual(comparison.periods.current.metrics, { totalSales: 1300, totalOrders: 3, avgOrderValue: 433.33 });
  assert.deepEqual(comparison.periods.baseline.metrics, { totalSales: 1200, totalOrders: 2, avgOrderValue: 600 });
  assert.deepEqual(comparison.changes.totalSales, { absolute: 100, percentage: 8.33, percentageUnavailableReason: null });
  assert.deepEqual(comparison.changes.avgOrderValue, { absolute: -166.67, percentage: -27.78, percentageUnavailableReason: null });
  const dashboard = await getOrdersOverviewService({ from: "2026-08-31T21:00:00Z", to: "2026-09-30T20:59:59.999Z", warehouse });
  for (const key of ["totalSales", "totalOrders", "avgOrderValue"]) assert.equal(comparison.periods.current.metrics[key], dashboard[key]);
  assert.equal(dashboard.statusBreakdown.cancelled, 1); assert.equal(dashboard.statusBreakdown.returned, 1);
  assert.equal(comparison.definition.currency, null, "Mixed recorded currencies are not falsely labeled EGP");
  const all = await getOrderComparisonService({ month: "2026-09", compareTo: "2026-08" }, now);
  assert.equal(all.periods.current.metrics.totalSales, 6300);
  const empty = await getOrderComparisonService({ month: "2026-09", compareTo: "2026-08", warehouse: String(new mongoose.Types.ObjectId()) }, now);
  assert.equal(empty.periods.current.metrics.totalSales, 0); assert.equal(empty.changes.totalSales.percentage, null);
  const partial = await getOrderComparisonService({ month: "2026-09", compareTo: "2026-08", warehouse: String(warehouse) }, new Date("2026-09-16T00:00:00Z"));
  assert.equal(partial.periods.current.partial, true); assert.equal(partial.periods.current.metrics.totalSales, 1200);
});
