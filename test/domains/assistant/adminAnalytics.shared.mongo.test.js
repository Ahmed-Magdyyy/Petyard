import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { validateSharedMongoTarget, createSharedMongoManifest, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { analyticsSeed } from "./fixtures/analyticsSeed.js";

test("shared test-cluster analytics uses only registered records and a unique warehouse", {
  skip: !process.env.ASSISTANT_SHARED_TEST_MONGO_URI && "Prepared only; requires explicit shared-test opt-in",
}, async (t) => {
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  // Disable automatic schema/index creation before importing application models.
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { executeAdminAnalyticsTool } = await import("../../../src/domains/assistant/admin/assistant.admin-analytics.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const manifest = createSharedMongoManifest();
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const path = new URL(`${manifest.marker}.json`, directory);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`owned_record_manifest=${path.pathname}`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  try {
    await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false, bufferCommands: false });
  } catch { throw new Error("Shared test connection failed; credentials and connection details withheld"); }
  records = sharedMongoRecords(mongoose.connection, manifest);
  await records.prepare();
  const { actor, warehouse, sold, zero, seed } = analyticsSeed(manifest);
  for (const { collection, document } of seed) await records.insert(collection, document);
  const config = testConfig(); const options = { getConfig: () => config };
  const args = { month: "2026-09", warehouse: String(warehouse) };
  const comparison = await executeAdminAnalyticsTool(actor, { tool: "compare_order_months", arguments: { ...args, compareTo: "2026-08" } }, options);
  assert.equal(comparison.data.periods.current.metrics.totalSales, 240);
  assert.equal(comparison.data.periods.baseline.metrics.totalSales, 100);
  assert.equal(comparison.data.changes.totalSales.percentage, 140);
  const lowest = await executeAdminAnalyticsTool(actor, { tool: "lowest_selling_products", arguments: { ...args, metric: "units", limit: 2 } }, options);
  assert.equal(lowest.data.results[0].productId, String(zero)); assert.equal(lowest.data.results[0].unitsSold, 0);
  const highest = await executeAdminAnalyticsTool(actor, { tool: "highest_selling_products", arguments: { ...args, metric: "item_value", limit: 1 } }, options);
  assert.equal(highest.data.results[0].productId, String(sold)); assert.equal(highest.data.results[0].recordedItemValue, 200);
});
