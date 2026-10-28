import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { readAssistantCatalog } from "../../../src/domains/assistant/products/assistant.catalog-read.js";
import { catalogDietaryRisk, classifyCatalogProduct, validCatalogClassification } from "../../../src/domains/assistant/products/assistant.catalog-policy.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { BrandModel } from "../../../src/domains/brand/brand.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { mapProductToCardDto } from "../../../src/domains/product/product.service.js";
import { testConfig, structuredReply, knownUsage } from "./fixtures/foundationPolicy.js";
import { customerChatFixture } from "./fixtures/customerChat.js";
import { prepareProductSearch } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { catalogReadSeed } from "./fixtures/catalogReadSeed.js";

const W = "111111111111111111111111", F = "222222222222222222222222", N = "333333333333333333333333";
const SF = "444444444444444444444444", SN = "555555555555555555555555";
const subject = { id: "pet:666666666666666666666666", saved: true, profile: { chronicConditions: [], temporaryIssues: [] } };
const policy = () => ({ version: "reviewed-test-v1", foodCategoryIds: [F], nonFoodCategoryIds: [N], foodSubcategoryIds: [SF], nonFoodSubcategoryIds: [SN] });
const product = (overrides = {}) => ({ _id: new mongoose.Types.ObjectId(), slug: "cat-match", type: "SIMPLE", isActive: true,
  name_ar: "لعبة قطط", name_en: "Cat toy", tags: ["cat"], category: N, subcategory: null, price: 100, discountedPrice: null,
  warehouseStocks: [{ warehouse: W, quantity: 5 }], images: [], ...overrides });

function fixture(t, products = [product()]) {
  const state = { products, reads: [], warehouses: [], promotions: [], brands: [], brandReads: [], collections: [] };
  const query = (read) => {
    let limit = Infinity;
    return { populate() { return this; }, select() { return this; }, sort() { return this; }, lean() { return this; },
      limit(value) { limit = value; return this; }, maxTimeMS(value) { assert.equal(value, 5000); return this; },
      then(resolve, reject) { return Promise.resolve().then(() => { const value = read(); return Array.isArray(value) ? value.slice(0, limit) : value; }).then(resolve, reject); } };
  };
  const matchesSearch = (row, term) => term.$and ? term.$and.every((part) => matchesSearch(row, part)) : Object.entries(term).some(([key, match]) => {
    if (key === "brand") return match.$in.some((id) => String(id) === String(row.brand));
    const values = key.startsWith("variants.options.") ? (row.variants ?? []).flatMap((variant) => (variant.options ?? []).map((option) => option[key.split(".").at(-1)]))
      : Array.isArray(row[key]) ? row[key] : [row[key] ?? ""];
    return values.some((value) => new RegExp(match.$regex, match.$options).test(value));
  });
  state.warehouseRows = [{ _id: W, active: true }];
  t.mock.method(WarehouseModel, "findById", async (id) => { state.warehouses.push(String(id)); return state.warehouseRows.find((row) => String(row._id) === String(id)); });
  t.mock.method(BrandModel, "find", (filter) => {
    state.brandReads.push(filter);
    return query(() => state.brands.filter((row) => filter.$or.some((term) => matchesSearch(row, term))));
  });
  t.mock.method(ProductModel, "find", (filter) => {
    state.reads.push(filter);
    assert.equal(filter.$and[0].isActive, true);
    assert.deepEqual(filter.$and[0].type, { $in: ["SIMPLE", "VARIANT"] });
    const stock = filter.$and[1].$nor?.[0] ?? filter.$and[1];
    const warehouse = stock.$or[0].warehouseStocks.$elemMatch.warehouse;
    assert.equal(stock.$or[1].variants.$elemMatch.warehouseStocks.$elemMatch.warehouse, warehouse);
    assert.deepEqual(stock.$or[0].warehouseStocks.$elemMatch.quantity, { $gt: 0 });
    const outOfStock = Boolean(filter.$and[1].$nor);
    return query(() => state.products.filter((row) => {
      const matches = filter.$and[0].$or.some((term) => matchesSearch(row, term));
      const stocks = row.type === "VARIANT" ? (row.variants ?? []).flatMap((variant) => variant.warehouseStocks ?? []) : row.warehouseStocks;
      const available = stocks.some((stock) => String(stock.warehouse) === warehouse && stock.quantity > 0);
      return row.isActive === true && ["SIMPLE", "VARIANT"].includes(row.type) && matches && available !== outOfStock;
    }));
  });
  t.mock.method(SubcategoryModel, "find", () => query(() => []));
  t.mock.method(CollectionModel, "find", (filter) => { state.promotions.push(filter); return query(() => state.collections); });
  for (const model of [ProductModel, BrandModel, CollectionModel, SubcategoryModel, WarehouseModel]) {
    for (const method of ["create", "updateOne", "updateMany", "deleteMany"]) t.mock.method(model, method, () => assert.fail("Product lookup must not mutate database records"));
  }
  t.mock.method(FavoriteModel, "findOne", () => assert.fail("Product lookup must not read user favorites"));
  state.read = (overrides = {}, config = testConfig({ catalogClassification: policy() })) => readAssistantCatalog({
    query: "cat", warehouseId: W, language: "en", subject, warnings: [], ...overrides }, config);
  return state;
}

test("reviewed category policy validates IDs/version without names, tags, overrides or conflicting declarations", () => {
  assert.equal(validCatalogClassification(undefined), true); assert.equal(validCatalogClassification(policy()), true);
  assert.equal(classifyCatalogProduct({ category: F, tags: ["nonfood"] }, policy()), "food");
  assert.equal(classifyCatalogProduct({ category: { _id: N }, subcategory: SF }, policy()), "food");
  assert.equal(classifyCatalogProduct({ category: F, subcategory: SN }, policy()), "food");
  assert.equal(classifyCatalogProduct({ category: N }, policy()), "nonfood");
  assert.equal(classifyCatalogProduct({ subcategory: { _id: SN } }, policy()), "nonfood");
  assert.equal(classifyCatalogProduct({ name_en: "Definitely a toy", tags: ["nonfood"] }, policy()), "unknown");
  assert.equal(classifyCatalogProduct({ category: N }), "unknown");
  for (const value of [null, [], {}, { ...policy(), version: " " }, { ...policy(), model: "no" }, { ...policy(), foodCategoryIds: ["food"] },
    { ...policy(), nonFoodCategoryIds: [F] }, { ...policy(), nonFoodSubcategoryIds: [SF] }, { ...policy(), foodCategoryIds: [F, F] },
    { ...policy(), foodSubcategoryIds: null }]) {
    assert.equal(validCatalogClassification(value), false);
    assert.throws(() => testConfig({ catalogClassification: value }), { code: "assistant_configuration_required" });
  }
  assert.notEqual(testConfig().signature, testConfig({ catalogClassification: policy() }).signature);
  const config = testConfig({ catalogClassification: policy() }); const signature = config.signature;
  assert.throws(() => config.catalogClassification.nonFoodCategoryIds.push(F), TypeError);
  assert.throws(() => { config.catalogClassification.foodCategoryIds = []; }, TypeError);
  assert.equal(config.signature, signature); assert.equal(classifyCatalogProduct({ category: F }, config.catalogClassification), "food");
});

test("dietary risk distinguishes unknown from no recorded conditions and rejects cross-pet or removed-warning context", () => {
  assert.equal(catalogDietaryRisk(null, []), "general_browse"); assert.equal(catalogDietaryRisk(subject, []), "none_recorded");
  assert.equal(catalogDietaryRisk({ ...subject, profile: undefined }, []), "unknown");
  assert.equal(catalogDietaryRisk({ id: "chat:12345678-1234-1234-1234-123456789012", saved: false }, []), "unknown");
  assert.equal(catalogDietaryRisk({ ...subject, profile: { chronicConditions: ["kidney disease"], temporaryIssues: [] } }, []), "known");
  assert.equal(catalogDietaryRisk(subject, [{ subjectId: subject.id, state: "active", text: "User-reported allergy" }]), "known");
  for (const [pet, warnings] of [[null, [{}]], [subject, [{ subjectId: `pet:${W}`, state: "active", text: "allergy" }]],
    [subject, [{ subjectId: subject.id, state: "removed", text: "allergy" }]], [{ ...subject, saved: false }, []]]) {
    assert.throws(() => catalogDietaryRisk(pet, warnings), { code: "invalid_catalog_context" });
  }
});

test("lookup uses bounded database name/tag/brand queries and renders three real localized cards with available products first", async (t) => {
  const rows = [product({ warehouseStocks: [] }), product(), product({ name_en: "Brand item", name_ar: "منتج العلامة", tags: [], brand: new mongoose.Types.ObjectId() }),
    product({ isActive: false }), product()];
  const state = fixture(t, rows); state.brands.push({ _id: rows[2].brand, name_en: "Cat supplies" });
  const result = await state.read({ language: "ar" });
  assert.equal(result.status, "results"); assert.equal(result.products.length, 3);
  assert.ok(result.products.every((card) => card.inStock)); assert.equal(result.products[1].name, "منتج العلامة");
  assert.equal(state.reads.length, 1); assert.equal(state.reads[0].$and[1].$nor, undefined);
  assert.doesNotMatch(JSON.stringify(result.products), /tags|revision|warehouseStocks|rating|category|owner|isFavorite/);
  assert.ok(result.generatedAt); assert.equal(result.classificationVersion, "reviewed-test-v1");
});

test("a known or unknown dietary risk withholds food and unknown classification while keeping reviewed nonfood", async (t) => {
  const rows = [product({ category: F }), product({ category: null }), product()];
  const state = fixture(t, rows);
  for (const overrides of [{ warnings: [{ subjectId: subject.id, state: "active", text: "allergy" }] }, { subject: { ...subject, profile: undefined } }]) {
    const result = await state.read(overrides); assert.equal(result.withheldCount, 2);
    assert.equal(result.products.length, 1); assert.equal(result.products[0].id, String(rows[2]._id)); assert.equal(result.products[0].inStock, true);
  }
  const unavailable = await state.read({ warnings: [{ subjectId: subject.id, state: "active", text: "allergy" }] }, testConfig());
  assert.equal(unavailable.status, "food_review_required"); assert.equal(unavailable.products.length, 0);
  assert.equal(unavailable.classificationVersion, null);
});

test("general product browsing is separate from personalized approval, including food with no recorded condition", async (t) => {
  const state = fixture(t, [product({ category: F })]);
  for (const pet of [null, subject]) {
    const result = await state.read({ subject: pet }); assert.equal(result.status, "results"); assert.equal(result.products.length, 1);
    assert.equal(Object.hasOwn(result.products[0], "suitable"), false);
  }
});

test("missing location reads nothing and a routing change cannot substitute another warehouse", async (t) => {
  const state = fixture(t);
  assert.equal((await state.read({ warehouseId: null })).status, "needs_location");
  assert.equal(state.warehouses.length, 0); assert.equal(state.reads.length, 0);
  state.warehouseRows = [{ _id: W, active: true, fulfillment: { status: "MAINTENANCE", fallbackWarehouse: F } }, { _id: F, active: true }];
  await assert.rejects(state.read(), { code: "catalog_warehouse_changed", status: 409 });
  assert.equal(state.reads.length, 0);
  assert.equal(state.brandReads.length, 0);
  state.warehouseRows[0] = { _id: W, active: true, fulfillment: { status: "CLOSED" } };
  await assert.rejects(state.read(), { statusCode: 409 });
});

test("real promotion/pricing mapping is reused and variant minima remain from-prices without selecting a variant", async (t) => {
  const row = product({ type: "VARIANT", variants: [{ price: 100, discountedPrice: 95, warehouseStocks: [{ warehouse: W, quantity: 1 }] },
    { price: 150, discountedPrice: 80, warehouseStocks: [] }] });
  const state = fixture(t, [row]); const promotionId = new mongoose.Types.ObjectId();
  state.collections = [{ _id: promotionId, slug: "test-promotion", promotion: { discountPercent: 30 }, selector: { productIds: [row._id] } }];
  const result = await state.read(); const expected = mapProductToCardDto({ ...row, variants: [row.variants[0]] }, { warehouseId: W, lang: "en", promotion: { discountPercent: 30 } });
  assert.equal(result.products[0].price, expected.price); assert.equal(result.products[0].discountedPrice, expected.discountedPrice);
  assert.equal(result.products[0].priceDisplay, "from"); assert.equal(result.products[0].hasVariants, true);
  assert.equal(state.promotions[0]["promotion.enabled"], true); assert.equal(state.promotions[0]["promotion.isActive"], true);
});

test("literal search input cannot become an arbitrary regex and raw metadata cannot override the read contract", async (t) => {
  const state = fixture(t, [product({ name_en: "A .* toy", tags: [] }), product({ name_en: "Different", tags: [] })]);
  assert.equal((await state.read({ query: ".*" })).products.length, 1);
  for (const input of [{ query: " " }, { query: "x".repeat(121) }, { language: "fr" }, { warehouseId: {} },
    { includeZeroStock: true }, { price: 1 }, { subjectId: subject.id }]) await assert.rejects(state.read(input));
  await assert.rejects(state.read({}, { enabled: false }), { code: "assistant_disabled" });
});

test("saved case2 query finds reordered product terms after removing only its selected-pet reference", async (t) => {
  const rows = [product({ name_en: "Cat dry food", tags: [] }), product({ name_en: "Chicken dry food for cats", tags: [] }),
    product({ name_en: "Cat wet food", tags: [] }), product({ name_en: "Dog dry food", tags: [] })];
  const state = fixture(t, rows), milo = { ...subject, name: "Milo", species: "cat" };
  const result = await state.read({ query: "dry food for cat Milo", subject: milo });
  assert.deepEqual(result.products.map((card) => card.id), rows.slice(0, 2).map((row) => String(row._id)));
  assert.equal((await state.read({ query: "dry food for cat Milo", subject: { ...milo, name: "Roy" } })).products.length, 0);
  assert.equal((await state.read({ query: "dry food for cat Milo", subject: null })).products.length, 0);
  assert.equal((await state.read({ query: "Milo dry food", subject: milo })).products.length, 0, "an unlinked name may be a product or brand term");
  state.products = [product({ name_en: "Milo cat dry food", tags: [] }), ...rows];
  assert.equal((await state.read({ query: "Milo dry food for cat Milo", subject: milo })).products.length, 1, "the prefix product name is retained");
});

test("assistant term search keeps punctuation literal, species explicit and Arabic terms without fuzzy expansion", async (t) => {
  const state = fixture(t, [product({ name_en: "Cat food dry .*", name_ar: "طعام قطط جاف", tags: [] }),
    product({ name_en: "Cat dry food", name_ar: "طعام قطط رطب", tags: [] })]);
  assert.equal((await state.read({ query: "dry .* cat" })).products.length, 1);
  assert.equal((await state.read({ query: "جاف قطط" })).products.length, 1);
  assert.equal((await state.read({ query: "dry food for cat Milo.*", subject: { ...subject, name: "Milo.*", species: "cat" } })).products.length, 2);
  assert.equal((await state.read({ query: "dry food for cat MiloX", subject: { ...subject, name: "Milo.*", species: "cat" } })).products.length, 0);
});

test("a query containing only a pet reference never becomes an empty regex or broad catalog browse", async (t) => {
  const state = fixture(t, [product({ name_en: "Cat dry food", tags: [] })]);
  for (const query of ["for Milo", "for cat Milo", "  for Milo  ", "\nfor cat Milo\n"]) {
    const result = await state.read({ query, subject: { ...subject, name: "Milo", species: "cat" } });
    assert.deepEqual(result.products, []);
  }
  assert.ok(state.reads.every((filter) => filter.$and[0].$or.every((branch) => branch.$and.every((term) =>
    Object.values(term).every((regex) => typeof regex.$regex === "string" && regex.$regex.length > 0)))));
});

test("reordered brand terms are all required in one brand name and keep the same bounded lookup", async (t) => {
  const brand = new mongoose.Types.ObjectId(), otherBrand = new mongoose.Types.ObjectId();
  const state = fixture(t, [product({ name_en: "Adult formula", tags: [], brand }), product({ name_en: "Other formula", tags: [], brand: otherBrand })]);
  state.brands = [{ _id: brand, name_en: "Royal Canin" }, { _id: otherBrand, name_en: "Royal", name_ar: "Canin" }];
  const result = await state.read({ query: "canin royal" });
  assert.deepEqual(result.products.map((card) => card.id), [String(state.products[0]._id)]);
  assert.equal(state.brandReads.length, 1); assert.equal(state.reads.length, 1);
});

const exactFilters = (changes = {}) => ({ minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, options: [], ...changes });

test("assistant suggestions exclude zero stock and stock held only in another warehouse", async (t) => {
  const local = product();
  const remote = product({ warehouseStocks: [{ warehouse: F, quantity: 100 }] });
  const zero = product({ warehouseStocks: [{ warehouse: W, quantity: 0 }, { warehouse: F, quantity: 100 }] });
  const remoteVariant = product({ type: "VARIANT", variants: [offer({ warehouseStocks: [{ warehouse: F, quantity: 100 }] })] });
  const state = fixture(t, [remote, zero, remoteVariant, local]);
  const result = await state.read();
  assert.deepEqual(result.products.map((card) => card.id), [String(local._id)]);
  assert.ok(result.products.every((card) => card.inStock));
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].$and[1].$or[0].warehouseStocks.$elemMatch.warehouse, W);
  state.products = [remote, zero, remoteVariant];
  assert.equal((await state.read()).status, "empty");
});

test("matching variants cannot borrow stock from another size or warehouse", async (t) => {
  const small = offer({ price: 100, options: [{ name: "Weight", value: "1kg" }] });
  const remote = offer({ price: 500, warehouseStocks: [{ warehouse: F, quantity: 100 }] });
  const local = offer({ price: 900 });
  const row = product({ type: "VARIANT", variants: [small, remote] });
  const state = fixture(t, [row]);
  assert.equal((await state.read({ filters: exactFilters() })).status, "empty");
  row.variants.push(local);
  const result = await state.read({ filters: exactFilters() });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].price, 900);
  assert.equal(result.products[0].matchingOfferCount, 1);
  assert.deepEqual(result.products[0].matchingOffers.map((entry) => entry.variantId), [String(local._id)]);
});

test("unconstrained variant starting prices use only variants stocked in the app warehouse", async (t) => {
  const local = offer({ price: 900 });
  const remote = offer({ price: 100, warehouseStocks: [{ warehouse: F, quantity: 100 }] });
  const zero = offer({ price: 50, warehouseStocks: [{ warehouse: W, quantity: 0 }] });
  const state = fixture(t, [product({ type: "VARIANT", variants: [remote, zero, local] })]);
  const result = await state.read();
  assert.equal(result.products[0].price, 900);
  assert.equal(result.products[0].priceDisplay, "from");
  assert.equal(result.products[0].inStock, true);
});

test("revised native seed has the expected query results under mocked models without connecting", async (t) => {
  const { ids, seed, classification } = await catalogReadSeed(createSharedMongoManifest("catalogRead"));
  const rows = (name) => seed.filter((row) => row.collection === name).map((row) => row.document);
  const state = fixture(t, rows("products")); state.brands = rows("brands"); state.warehouseRows = rows("warehouses");
  const milo = { ...subject, name: "Milo", species: "cat" }, config = testConfig({ catalogClassification: classification });
  const read = (input) => state.read({ warehouseId: String(ids.warehouses[0]), subject: null, ...input }, config);
  const found = async (input) => (await read(input)).products.map((card) => card.id);
  const toys = [String(ids.products[0])];
  assert.deepEqual(await found({ query: "toy cat" }), toys);
  assert.deepEqual(await found({ query: "قطط لعبة", language: "ar" }), [String(ids.products[0])]);
  assert.deepEqual(await found({ query: "toy missingterm" }), []);
  assert.deepEqual(await found({ query: "cat .*" }), [String(ids.products[0])]);
  for (const name of ["Milo", "Milo.+"]) assert.deepEqual(await found({ query: `toy for cat ${name}`, subject: { ...milo, name } }), toys);
  for (const selected of [null, { ...milo, name: "Roy" }]) assert.deepEqual(await found({ query: "toy for cat Milo", subject: selected }), []);
  assert.deepEqual(await found({ query: "toy for cat MiloX", subject: { ...milo, name: "Milo.+" } }), []);
  for (const query of ["Canin Royal", "تجريبية علامة"]) assert.deepEqual(await found({ query }), [String(ids.products[1])]);
  for (const query of ["Royal missingterm", "Royal علامة"]) assert.deepEqual(await found({ query }), []);
  const result = await read({ query: "dry food for cat Milo", subject: milo, filters: exactFilters() });
  assert.equal(result.dietaryRisk, "none_recorded"); assert.deepEqual(result.products.map((card) => card.id), [String(ids.products[4])]);
  const card = result.products[0]; assert.equal(card.price, 950); assert.equal(card.inStock, true);
  assert.equal(card.matchingOffers[0].variantId, String(state.products[4].variants[0]._id));
  assert.equal(card.matchingOffers[0].finalPriceMinor, 95000);
  assert.equal(card.matchingOffers[0].attributes.find((entry) => entry.name === "weight").value, 3000);
  for (const limits of [{ minimumPackageWeightGrams: 4000 }, { maximumPriceMinor: 90000 }]) {
    assert.deepEqual(await found({ query: "dry food for cat Milo", subject: milo, filters: exactFilters(limits) }), []);
  }
  assert.deepEqual(await found({ query: "beta alpha" }), [String(ids.products[0])]);
  const constrained = await read({ query: "beta alpha", filters: exactFilters({ options: [{ name: "color", value: "pink" }] }) });
  assert.equal(constrained.status, "needs_verified_filters"); assert.deepEqual(constrained.products, []);
  const unknown = { id: "chat:12345678-1234-1234-1234-123456789012", saved: false };
  assert.equal((await read({ query: "feed", subject: unknown })).status, "food_review_required");
  assert.equal((await read({ query: "feed" })).status, "results");
});

const offer = (changes = {}) => ({ _id: new mongoose.Types.ObjectId(), price: 1200, discountedPrice: null,
  options: [{ name: "Weight", value: "3kg" }], warehouseStocks: [{ warehouse: W, quantity: 1 }], ...changes });

test("saved case2 search terms still require weight and price on the same verified offer", async (t) => {
  const split = product({ name_en: "Cat dry food", tags: [], type: "VARIANT", variants: [
    offer({ price: 400, options: [{ name: "weight", value: "1kg" }] }), offer({ price: 1200 }),
  ] });
  const exact = product({ name_en: "Chicken dry food for cats", tags: [], type: "VARIANT", variants: [offer({ price: 950 })] });
  const unknown = product({ name_en: "Cat dry food", tags: [], type: "VARIANT", variants: [
    offer({ price: 900, options: [{ name: "Unreviewed Label", value: "3kg" }] }),
  ] });
  const state = fixture(t, [split, exact, unknown]);
  const result = await state.read({ query: "dry food for cat Milo", subject: { ...subject, name: "Milo", species: "cat" }, filters: exactFilters() });
  assert.deepEqual(result.products.map((card) => card.id), [String(exact._id)]);
  assert.equal(result.unverifiedOfferCount, 1);
  assert.equal(result.products[0].matchingOffers[0].variantId, String(exact.variants[0]._id));
  assert.equal(result.products[0].price, 950);
});

test("constrained cards use only the qualifying variant's promotion, price and stock instead of parent minima", async (t) => {
  const smaller = offer({ price: 400, options: [{ name: "weight", value: "1kg" }] });
  const qualifying = offer({ price: 1200.5, warehouseStocks: [] });
  const row = product({ type: "VARIANT", variants: [smaller, qualifying] });
  const state = fixture(t, [row]);
  assert.equal((await state.read({ filters: exactFilters() })).status, "empty");
  state.collections = [{ _id: new mongoose.Types.ObjectId(), slug: "promo", promotion: { discountPercent: 20 }, selector: { productIds: [row._id] } }];
  assert.equal((await state.read({ filters: exactFilters() })).status, "empty", "a promotion cannot make an unstocked variant purchasable");
  qualifying.warehouseStocks = [{ warehouse: W, quantity: 1 }];
  const result = await state.read({ filters: exactFilters() }); const card = result.products[0];
  assert.equal(card.price, 1200.5); assert.equal(card.discountedPrice, 960); assert.equal(card.priceDisplay, "exact");
  assert.equal(card.inStock, true, "the qualifying package itself must have local stock");
  assert.equal(card.matchingOfferCount, 1); assert.equal(card.matchingOffers[0].variantId, String(qualifying._id));
  assert.equal(card.matchingOffers[0].finalPriceMinor, 96000);
  assert.equal(card.matchingOffers[0].attributes.find((entry) => entry.name === "weight").value, 3000);
});

test("constrained matching excludes unavailable offers, with bounded previews and a locally stocked match count", async (t) => {
  const unavailable = product({ type: "VARIANT", variants: [offer({ price: 200, options: [{ name: "Weight", value: "1kg" }] }),
    offer({ price: 900, warehouseStocks: [] })] });
  const available = product({ type: "VARIANT", variants: Array.from({ length: 5 }, () => offer({ price: 950 })) });
  const state = fixture(t, [unavailable, available]);
  const result = await state.read({ filters: exactFilters() });
  assert.deepEqual(result.products.map((card) => card.id), [String(available._id)]);
  assert.equal(result.products[0].matchingOffers.length, 3); assert.equal(result.products[0].matchingOfferCount, 5);
  assert.ok(result.products.every((card) => card.inStock));
});

test("legacy labels and option values remain discoverable even when their dimension is unreviewed", async (t) => {
  const reviewed = product({ _id: new mongoose.Types.ObjectId("6ad6b59ceb45a87653b72bae"), name_en: "Soleil Tug Rugby Dog Toy", tags: [], type: "VARIANT",
    variants: [offer({ price: 100, options: [{ name: "Blue", value: "Pink" }] })] });
  const unreviewed = product({ name_en: "Unfamiliar toy", tags: [], type: "VARIANT",
    variants: [offer({ price: 100, options: [{ name: "Odd Product Label", value: "Pink" }] })] });
  const state = fixture(t, [reviewed, unreviewed]);
  const loose = await state.read({ query: "Pink" }); assert.equal(loose.products.length, 2);
  assert.equal((await state.read({ query: "Odd Product Label" })).products.length, 1);
  const filters = exactFilters({ minimumPackageWeightGrams: null, options: [{ name: "color", value: "pink" }] });
  const exact = await state.read({ query: "Pink", filters });
  assert.equal(exact.products.length, 1); assert.equal(exact.products[0].id, String(reviewed._id)); assert.equal(exact.unverifiedOfferCount, 1);
  state.products = [unreviewed];
  const unknown = await state.read({ query: "Pink", filters });
  assert.equal(unknown.status, "needs_verified_filters"); assert.deepEqual(unknown.products, []);
  assert.match(JSON.stringify(state.reads[0].$and[0].$or), /variants\.options\.value/);
});

test("constrained reads require the app's refreshed warehouse and preserve dietary withholding", async (t) => {
  const food = product({ category: F, type: "VARIANT", variants: [offer({ price: 900, warehouseStocks: [{ warehouse: F, quantity: 2 }] })] });
  const toy = product({ type: "VARIANT", variants: [offer({ price: 900, warehouseStocks: [{ warehouse: F, quantity: 2 }] })] });
  const state = fixture(t, [food, toy]);
  state.warehouseRows = [{ _id: W, active: true, fulfillment: { status: "MAINTENANCE", fallbackWarehouse: F } }, { _id: F, active: true }];
  const input = { filters: exactFilters(), warnings: [{ subjectId: subject.id, state: "active", text: "allergy" }] };
  await assert.rejects(state.read(input), { code: "catalog_warehouse_changed" });
  assert.equal(state.reads.length, 0);
  const result = await state.read({ ...input, warehouseId: F });
  assert.equal(result.withheldCount, 1); assert.equal(result.products.length, 1); assert.equal(result.products[0].id, String(toy._id));
  assert.equal(result.products[0].inStock, true); assert.equal(result.effectiveWarehouseId, F);
});

test("owned preparation uses the actual matcher and never replaces unverified constraints with loose results", async (t) => {
  const state = customerChatFixture(t, "I need cat food at least 3kg under 1000 EGP", { catalogClassification: policy() });
  const catalog = fixture(t, [product({ type: "VARIANT", variants: [offer({ price: 400, options: [{ name: "weight", value: "1kg" }] }), offer()] })]);
  const result = { structured: structuredReply({ reply: "", productSearch: { action: "pet", query: "cat", ...exactFilters(), sourceQuote: state.run.input } }),
    finishReason: "completed", toolCalls: [], serviceTier: "default", usage: knownUsage };
  const prepare = () => prepareProductSearch(state.prepared, result, state.config, { context: { warehouseId: W, language: "en" } });
  assert.equal((await prepare()).result.status, "empty");
  catalog.products[0].variants[1].options = [{ name: "Unreviewed product label", value: "3kg" }];
  catalog.products[0].variants[1].discountedPrice = 950;
  const unknown = await prepare(); assert.equal(unknown.result.status, "needs_verified_filters"); assert.deepEqual(unknown.result.products, []);
  catalog.products[0].variants[1].options = [{ name: "weight", value: "3kg" }];
  const verified = await prepare(); assert.equal(verified.result.products[0].discountedPrice, 950);
  assert.equal(verified.result.products[0].matchingOffers[0].variantId, String(catalog.products[0].variants[1]._id));
  assert.equal(state.messages.length, 0); assert.equal(state.events.length, 0); assert.equal(state.budgetUpdates.length, 0);
});

test("invalid constrained read filters fail before any warehouse or product query", async (t) => {
  const state = fixture(t);
  for (const filters of [null, {}, exactFilters({ maximumPriceMinor: "100000" }), exactFilters({ minimumPackageWeightGrams: undefined }), exactFilters({ options: [{ name: "color" }] })]) {
    await assert.rejects(state.read({ filters }), { code: "invalid_product_filters" });
  }
  assert.equal(state.warehouses.length, 0); assert.equal(state.reads.length, 0);
});
