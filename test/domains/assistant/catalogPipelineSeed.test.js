import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { createIsolatedBudgetManifest, financialTestTime } from "./fixtures/isolatedBudget.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { catalogPipelineSeed, pipelineAuditTypes, pipelineInput } from "./fixtures/catalogPipelineSeed.js";

test("pipeline offline seed validates all 20 shapes, seeds only seven app rows and retains omitted user identity fields", async (t) => {
  t.mock.method(mongoose, "connect", () => assert.fail("Offline seed must not connect"));
  t.mock.timers.enable({ apis: ["Date"], now: new Date(financialTestTime) });
  const config = testConfig({ productSearchEnabled: true, timeoutMs: 30000 });
  const budget = createIsolatedBudgetManifest(config), manifest = createSharedMongoManifest("catalogPipeline");
  manifest.records.users = [...budget.owners];
  const f = await catalogPipelineSeed(manifest, budget, config);
  assert.equal(f.planned.length, 20); assert.equal(f.seed.length, 7);
  assert.equal(Object.keys(manifest.records).length, 15); assert.equal(Object.values(manifest.records).flat().length, 15);
  assert.deepEqual(f.seed.map((row) => row.collection), ["users", "users", "assistantaccounts", "assistantchats", "categories", "warehouses", "products"]);
  for (const row of f.seed.filter((row) => row.collection === "users")) {
    assert.equal(Object.hasOwn(row.document, "phone"), false); assert.equal(Object.hasOwn(row.document, "authProviders"), false);
    assert.match(row.document.email, /\.invalid$/);
  }
  assert.deepEqual(f.planned.filter((row) => row.collection === "assistantevents").map((row) => row.document.type), pipelineAuditTypes);
  assert.notEqual(manifest.warehouse, f.context.warehouseId);
  assert.equal(f.result.structured.reply, ""); assert.equal(f.result.structured.dietaryWarningQuote, pipelineInput.split(";")[0]);
  assert.equal(f.result.structured.resolvedSubjectId, manifest.subjectId);
  assert.deepEqual(f.classification.nonFoodCategoryIds, manifest.records.categories);
  assert.equal(f.seed.find((row) => row.collection === "products").document.warehouseStocks[0].quantity, 1);
  assert.equal(f.seed.find((row) => row.collection === "assistantchats").document.subjects[0].expiresAt > new Date(), true);
  assert.equal(new Date().toISOString(), financialTestTime);
  const wrong = createSharedMongoManifest("catalogPipeline");
  await assert.rejects(catalogPipelineSeed(wrong, budget, config));
});
