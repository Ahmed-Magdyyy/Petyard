import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { executeAdminAnalyticsTool } from "../../../src/domains/assistant/admin/assistant.admin-analytics.js";
import { AssistantAccount, AssistantRun, AssistantChat, AssistantMessage, AssistantMemory,
  AssistantBudget, AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { getOrderComparisonService } from "../../../src/domains/analytics/analytics.order-comparison.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("isolated Mongo admin tools reuse all three reports, read current authority and write no assistant state", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`; let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true; t.diagnostic(`assistant_test_database=${database}`);
  const actor = new mongoose.Types.ObjectId(); const warehouse = new mongoose.Types.ObjectId();
  const sold = new mongoose.Types.ObjectId(); const zero = new mongoose.Types.ObjectId();
  await UserModel.collection.insertOne({ _id: actor, role: "admin", enabledControls: ["analytics"], active: true, phoneVerified: true,
    account_status: "confirmed", deletedAt: null });
  await ProductModel.collection.insertMany([sold, zero].map((_id, index) => ({ _id, slug: `admin-analytics-${index}`, name_en: `Synthetic ${index}`,
    type: "SIMPLE", isActive: true, createdAt: new Date("2026-01-01"), warehouseStocks: [{ warehouse, quantity: 0 }] })));
  await OrderModel.collection.insertMany([
    { orderNumber: "admin-report-current", warehouse, createdAt: new Date("2026-09-15"), status: "pending", total: 240,
      paymentMethod: "cod", items: [{ product: sold, quantity: 2, itemPrice: 100 }] },
    { orderNumber: "admin-report-baseline", warehouse, createdAt: new Date("2026-08-15"), status: "delivered", total: 100,
      paymentMethod: "cod", items: [{ product: sold, quantity: 1, itemPrice: 90 }] },
  ]);
  const config = testConfig(); const options = { getConfig: () => config };
  const args = { month: "2026-09", warehouse: String(warehouse) };
  const comparison = await executeAdminAnalyticsTool(actor, { tool: "compare_order_months", arguments: { ...args, compareTo: "2026-08" } }, options);
  assert.equal(comparison.data.periods.current.metrics.totalSales, 240);
  assert.equal(comparison.data.periods.baseline.metrics.totalSales, 100);
  assert.equal(comparison.data.changes.totalSales.percentage, 140);
  const lowest = await executeAdminAnalyticsTool(actor, { tool: "lowest_selling_products", arguments: { ...args, metric: "units", limit: 2 } }, options);
  assert.equal(lowest.data.results[0].productId, String(zero)); assert.equal(lowest.data.results[0].unitsSold, 0);
  const highCall = { tool: "highest_selling_products", arguments: { ...args, metric: "item_value", limit: 1 } };
  const highest = await executeAdminAnalyticsTool(actor, highCall, options);
  assert.equal(highest.data.results[0].productId, String(sold)); assert.equal(highest.data.results[0].recordedItemValue, 200);
  assert.equal(await AssistantAccount.countDocuments(), 0, "Read-only tools do not create an AI account");
  await UserModel.collection.updateOne({ _id: actor }, { $set: { enabledControls: ["products"] } });
  await assert.rejects(executeAdminAnalyticsTool(actor, highCall, options), (error) => error.status === 403 && error.code === "access_denied");
  await UserModel.collection.updateOne({ _id: actor }, { $set: { role: "moderator", enabledControls: ["analytics"] } });
  await assert.rejects(executeAdminAnalyticsTool(actor, highCall, options), (error) => error.status === 403);
  await UserModel.collection.updateOne({ _id: actor }, { $set: { role: "superAdmin", enabledControls: [] } });
  assert.equal((await executeAdminAnalyticsTool(actor, highCall, options)).data.results.length, 1);
  await AssistantAccount.collection.insertOne({ owner: actor, blocked: true });
  await assert.rejects(executeAdminAnalyticsTool(actor, highCall, options), (error) => error.status === 403 && error.code === "ai_restricted");
  assert.equal((await getOrderComparisonService({ ...args, compareTo: "2026-08" })).periods.current.metrics.totalSales, 240,
    "Ordinary deterministic analytics is not changed by an AI-only access block");
  for (const model of [AssistantRun, AssistantChat, AssistantMessage, AssistantMemory, AssistantBudget, AssistantEvent]) {
    assert.equal(await model.countDocuments(), 0, `${model.modelName} was not written by read-only tools`);
  }
});
