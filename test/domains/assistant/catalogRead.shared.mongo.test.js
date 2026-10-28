import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, validateSharedMongoTarget, sharedMongoConnection, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

const optIn = process.env.ASSISTANT_SHARED_CATALOG_READ_TEST;
test("native catalog queries preserve search, stock, promotion and exact-offer rules inside owned fixtures", {
  skip: !optIn && "Requires separate native-catalog-query-owned-records-only fixture approval",
}, async (t) => {
  assert.equal(optIn, "native-catalog-query-owned-records-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { catalogReadSeed } = await import("./fixtures/catalogReadSeed.js");
  const { mockSharedCatalogReadBoundaries } = await import("./fixtures/sharedCatalogReadBoundaries.js");
  const { readAssistantCatalog } = await import("../../../src/domains/assistant/products/assistant.catalog-read.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const manifest = createSharedMongoManifest("catalogRead");
  const { ids, seed, classification } = await catalogReadSeed(manifest);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  const file = new URL(`${manifest.marker}.json`, directory);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }); t.diagnostic(`catalog_read_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 }); }
  catch { throw new Error("Native catalog read connection failed; details withheld"); }
  const target = sharedMongoConnection(mongoose.connection);
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  manifest.indexes = {};
  for (const name of Object.keys(manifest.records)) {
    target.check(); manifest.indexes[name] = await target.db.collection(name).listIndexes().toArray();
  }
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const row of seed) await records.insert(row.collection, row.document);
  const reads = mockSharedCatalogReadBoundaries(t, manifest, target.check);
  const config = testConfig({ catalogClassification: classification });
  const subject = { id: `chat:${manifest.marker.slice("assistant_shared_".length)}`, saved: false };
  const read = (overrides = {}, policy = config) => readAssistantCatalog({ query: "Native", warehouseId: String(ids.warehouses[0]),
    language: "en", subject: null, warnings: [], ...overrides }, policy);
  const productIds = (result) => result.products.map((product) => product.id);
  const filters = { minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, options: [{ name: "color", value: "pink" }] };
  await t.test("missing location reads nothing; closed warehouse refuses fulfillment", async () => {
    assert.equal((await read({ warehouseId: null })).status, "needs_location"); assert.equal(reads.length, 0);
    await assert.rejects(read({ warehouseId: String(ids.warehouses[3]) }), { statusCode: 409 });
    assert.ok(reads.every((entry) => entry.name === "warehouses"));
  });
  await t.test("actual Mongo name, Arabic, tag, brand and escaped literal queries return fixture matches", async () => {
    for (const query of [".*", "tagonly", "قطط"]) {
      const result = await read({ query, language: "ar" });
      assert.deepEqual(productIds(result), [String(ids.products[0])]); assert.equal(result.products[0].name, "لعبة قطط");
    }
    assert.deepEqual(productIds(await read({ query: "NativeBrand" })), [String(ids.products[1])]);
    assert.deepEqual(productIds(await read({ query: "no-fixture-matches" })), []);
  });
  await t.test("inactive products and products without stock in the supplied warehouse are excluded", async () => {
    const result = await read({ query: "cat toy" });
    assert.deepEqual(productIds(result), [String(ids.products[0])]);
    assert.deepEqual(result.products.map((card) => card.inStock), [true]);
    assert.equal(result.products[0].discountedPrice, null, "expired promotion must not discount");
    assert.equal((await read()).products.length, 3);
  });
  await t.test("native promotion selector and subcategory ancestry produce exact expected prices", async () => {
    const lineage = await read({ query: "lineage" }); assert.equal(lineage.products[0].price, 100); assert.equal(lineage.products[0].discountedPrice, 85);
    assert.deepEqual((await read({ query: "offer", filters })).products, [], "remote matching stock cannot borrow the locally stocked smaller variant");
    const result = await read({ query: "offer", filters, warehouseId: String(ids.warehouses[2]) }); const card = result.products[0];
    assert.equal(card.price, 1200.5); assert.equal(card.discountedPrice, 960); assert.equal(card.inStock, true);
    assert.equal(card.priceDisplay, "exact"); assert.equal(card.matchingOfferCount, 1);
    const variant = seed.find((row) => String(row.document._id) === String(ids.products[2])).document.variants[1];
    assert.equal(card.matchingOffers[0].variantId, String(variant._id)); assert.equal(card.matchingOffers[0].finalPriceMinor, 96000);
  });
  await t.test("maintenance requires refreshed app context instead of silently searching a fallback warehouse", async () => {
    const before = reads.length;
    await assert.rejects(read({ query: "offer", filters, warehouseId: String(ids.warehouses[1]) }), { code: "catalog_warehouse_changed" });
    assert.ok(reads.slice(before).every((entry) => entry.name === "warehouses"));
  });
  await t.test("known and unknown dietary risk withhold food and unknown classifications", async () => {
    for (const warnings of [[], [{ subjectId: subject.id, state: "active", text: "Synthetic reported allergy" }]]) {
      const result = await read({ subject, warnings }); assert.equal(result.withheldCount, 2);
      assert.ok(!productIds(result).some((id) => [String(ids.products[4]), String(ids.products[5])].includes(id)));
    }
    assert.equal((await read({ query: "feed", subject })).status, "food_review_required");
    assert.equal((await read({ query: "feed" })).status, "results");
    assert.equal((await read({ subject }, testConfig())).status, "food_review_required");
  });
  await t.test("legacy labels stay searchable but unverified dimensions and mixed variants cannot satisfy exact filters", async () => {
    assert.deepEqual(productIds(await read({ query: "Odd Product Label" })), [String(ids.products[3])]);
    const unknown = await read({ query: "mystery", filters: { ...filters, minimumPackageWeightGrams: null } });
    assert.equal(unknown.status, "needs_verified_filters"); assert.deepEqual(unknown.products, []);
    const mixed = await read({ query: "split", filters }); assert.equal(mixed.status, "empty"); assert.deepEqual(mixed.products, []);
  });
  const milo = { id: "pet:111111111111111111111111", saved: true, name: "Milo", species: "cat",
    profile: { chronicConditions: [], temporaryIssues: [] } };
  await t.test("all query terms are required in either order and punctuation remains literal", async () => {
    assert.deepEqual(productIds(await read({ query: "toy cat" })), [String(ids.products[0]), String(ids.products[7])]);
    assert.deepEqual(productIds(await read({ query: "قطط لعبة", language: "ar" })), [String(ids.products[0])]);
    assert.deepEqual(productIds(await read({ query: "toy missingterm" })), []);
    assert.deepEqual(productIds(await read({ query: "cat .*" })), [String(ids.products[0])]);
  });
  await t.test("only the exact selected pet suffix is removed, including literal name punctuation", async () => {
    for (const name of ["Milo", "Milo.+"]) assert.deepEqual(productIds(await read({ query: `toy for cat ${name}`, subject: { ...milo, name } })),
      [String(ids.products[0]), String(ids.products[7])]);
    for (const selected of [null, { ...milo, name: "Roy" }]) assert.deepEqual(productIds(await read({ query: "toy for cat Milo", subject: selected })), []);
    assert.deepEqual(productIds(await read({ query: "toy for cat MiloX", subject: { ...milo, name: "Milo.+" } })), []);
  });
  await t.test("brand terms must all occur in one localized name branch", async () => {
    for (const query of ["Canin Royal", "تجريبية علامة"]) assert.deepEqual(productIds(await read({ query })), [String(ids.products[1])]);
    for (const query of ["Royal missingterm", "Royal علامة"]) assert.deepEqual(productIds(await read({ query })), []);
  });
  await t.test("saved case2 query selects the same verified 3kg EGP950 offer without clinical approval", async () => {
    const result = await read({ query: "dry food for cat Milo", subject: milo, filters: { ...filters, options: [] } });
    assert.equal(result.dietaryRisk, "none_recorded"); assert.deepEqual(productIds(result), [String(ids.products[4])]);
    const card = result.products[0], variant = seed.find((row) => String(row.document._id) === String(ids.products[4])).document.variants[0];
    assert.equal(card.price, 950); assert.equal(card.inStock, true); assert.equal(card.priceDisplay, "exact"); assert.equal(card.matchingOfferCount, 1);
    assert.equal(card.matchingOffers[0].variantId, String(variant._id)); assert.equal(card.matchingOffers[0].finalPriceMinor, 95000);
    assert.equal(card.matchingOffers[0].attributes.find((entry) => entry.name === "weight").value, 3000);
    assert.equal(Object.hasOwn(card, "suitable"), false);
    for (const limits of [{ minimumPackageWeightGrams: 4000 }, { maximumPriceMinor: 90000 }]) {
      assert.deepEqual((await read({ query: "dry food for cat Milo", subject: milo, filters: { ...filters, options: [], ...limits } })).products, []);
    }
  });
  await t.test("separate tag entries can discover candidates but cannot verify exact offer attributes", async () => {
    assert.deepEqual(productIds(await read({ query: "beta alpha" })), [String(ids.products[0])]);
    const constrained = await read({ query: "beta alpha", filters });
    assert.equal(constrained.status, "needs_verified_filters"); assert.deepEqual(constrained.products, []);
  });
  assert.ok(reads.some((entry) => entry.name === "categories"), "real Mongoose category population must run");
  assert.ok(reads.some((entry) => entry.name === "subcategories" && Object.keys(entry.filter).length === 0), "real promotion ancestry lookup must run");
  assert.ok(reads.some((entry) => entry.name === "collections"));
});
