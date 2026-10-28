import test from "node:test";
import assert from "node:assert/strict";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { catalogReadSeed } from "./fixtures/catalogReadSeed.js";
import { matchProductOffers } from "../../../src/domains/assistant/products/assistant.product-matching.js";

test("native read seed validates all 23 real model documents and uses unique fixture references", async () => {
  const manifest = createSharedMongoManifest("catalogRead"), { seed, ids, classification } = await catalogReadSeed(manifest);
  assert.equal(seed.length, 23);
  for (const [name, registered] of Object.entries(manifest.records)) assert.deepEqual(seed.filter((row) => row.collection === name)
    .map((row) => String(row.document._id)), registered);
  assert.equal(seed.filter((row) => row.collection === "warehouses").every((row) => row.document.isDefault === false), true);
  const products = seed.filter((row) => row.collection === "products").map((row) => row.document);
  assert.equal(products[2].variants[1].price, 1200.5); assert.equal(products[2].variants[1].options[0].value, "3kg");
  assert.equal(String(products[2].variants[0].warehouseStocks[0].warehouse), String(ids.warehouses[0]));
  assert.equal(String(products[2].variants[1].warehouseStocks[0].warehouse), String(ids.warehouses[2]));
  assert.deepEqual(classification.foodCategoryIds, [String(ids.categories[0])]);
  assert.deepEqual(classification.nonFoodCategoryIds, [String(ids.categories[1])]);
  assert.equal(seed.find((row) => row.collection === "brands").document.name_en, "NativeBrand Royal Canin");
  assert.deepEqual(products[0].tags, ["tagonly", "alpha", "beta"]);
  assert.equal(String(products[4].category), String(ids.categories[0]));
  const food = matchProductOffers(products[4], { minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, options: [] }, String(ids.warehouses[0]));
  assert.equal(food.matches.length, 1); assert.equal(food.matches[0].finalPriceMinor, 95000); assert.equal(food.matches[0].inStock, true);
  assert.equal(food.matches[0].variantId, String(products[4].variants[0]._id));
  assert.ok(!JSON.stringify(manifest).includes("mongodb+srv"));
  const filters = { minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, options: [{ name: "color", value: "pink" }] };
  const matched = matchProductOffers(products[2], filters, String(ids.warehouses[0]), { discountPercent: 20 });
  assert.equal(matched.matches.length, 1); assert.equal(matched.matches[0].finalPriceMinor, 96000); assert.equal(matched.matches[0].inStock, false);
  assert.equal(matchProductOffers(products[2], filters, String(ids.warehouses[2]), { discountPercent: 20 }).matches[0].inStock, true);
  // A bare package clause is deliberately uncertain; this fixture needs a neutral title to test known offers.
  const ambiguous = matchProductOffers({ ...products[2], name_en: "Native package" }, filters, String(ids.warehouses[0]), { discountPercent: 20 });
  assert.equal(ambiguous.matches.length, 0); assert.equal(ambiguous.unverifiedCount, 1);
});
