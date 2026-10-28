import test from "node:test";
import assert from "node:assert/strict";
import { attributeName, attributeValue, normalizeOfferAttributes, packageWeightGrams } from "../../../src/domains/assistant/products/assistant.product-attributes.js";
import { matchProductOffers, productFilters } from "../../../src/domains/assistant/products/assistant.product-matching.js";
import { computeFinalDiscountedPrice } from "../../../src/shared/utils/pricing.js";

const W = "111111111111111111111111", OTHER = "222222222222222222222222";
const A = "aaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbb", C = "cccccccccccccccccccccccc";
const filters = (changes = {}) => ({ minimumPackageWeightGrams: 3000, maximumPriceMinor: 100000, options: [], ...changes });
const variant = (changes = {}) => ({ _id: A, price: 800, discountedPrice: null,
  options: [{ name: "Weight", value: "3 kg" }], warehouseStocks: [{ warehouse: W, quantity: 2 }], ...changes });
const product = (variants = [variant()], changes = {}) => ({ _id: OTHER, type: "VARIANT", name_en: "Cat dry food", name_ar: "طعام قطط", variants, ...changes });
const match = (row = product(), criteria = filters(), promotion = null) => matchProductOffers(row, criteria, W, promotion);

test("the unsupported attribute marker cannot prove a match even when a catalog label uses the same word", () => {
  const row = product([variant({ options: [{ name: "weight", value: "3kg" }, { name: "other", value: "chicken" }] })]);
  assert.equal(match(row).matches.length, 1);
  assert.deepEqual(match(row, filters({ options: [{ name: "other", value: "chicken" }] })), { matches: [], unverifiedCount: 1 });
});

test("exact package mass uses integer grams across Arabic/Persian digits and explicit units", () => {
  for (const [raw, expected] of [["3kg", 3000], ["3 KG", 3000], ["３ ㎏", 3000], ["٣٫٥ كجم", 3500], ["۳٫۵ کیلو", null],
    ["۳٫۵ كيلو", 3500], ["0.001 kg", 1], ["900 Gm", 900], ["١٥ جرام", 15], ["2 kilograms", 2000], ["2 غرام", 2]]) {
    assert.equal(packageWeightGrams(raw), expected, raw);
  }
  for (const raw of [null, "", "3", "3 K", "1.5 K", "15", "5L", "300 ml", "2.5-5kg", "3kg-5kg", "3kg x2", "2 x 3 kg",
    "3kg + 1kg", "10mg/kg", "1,5kg", "0.5g", "0.0001kg", "-3kg", "0kg", "1000001kg", "3kg dog", "3kg\n4kg"]) {
    assert.equal(packageWeightGrams(raw), null, String(raw));
  }
});

test("literal options remain distinct and piece aliases do not turn every quantity into a count", () => {
  assert.equal(attributeName("  COLOUR  "), "color"); assert.equal(attributeName("النكهة"), "flavor");
  assert.equal(attributeName("Scent"), "scent"); assert.equal(attributeValue("scent", "  Baby   Powder "), "baby powder");
  assert.equal(attributeValue("pieces", "٥ pcs"), 5); assert.equal(attributeValue("count", "5"), 5);
  assert.equal(attributeValue("pieces", "Box (12 Pouch)"), null); assert.equal(attributeValue("pieces", "5 Pipette"), null);
  assert.equal(attributeValue("quantity", "1 pouch"), "1 pouch"); assert.equal(attributeName("quanitity"), "quanitity");
  assert.equal(attributeValue("Model", "Red Plaid Tartan"), "red plaid tartan");
});

test("Arabic flavor label matches canonical attributes without accepting missing or conflicting facts", () => {
  assert.equal(attributeName("  الطعم  "), "flavor");
  for (const [requested, stored] of [["الطعم", "flavor"], ["flavor", "الطعم"]]) {
    const offer = variant({ options: [{ name: "weight", value: "3kg" }, { name: stored, value: "فراخ" }] });
    const result = match(product([offer]), filters({ options: [{ name: requested, value: "فراخ" }] }));
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0].attributes.find((entry) => entry.name === "flavor"), {
      name: "flavor", value: "فراخ", sources: [{ field: "variant.options", variantId: A, name: stored, value: "فراخ" }],
    });
  }
  const criteria = filters({ options: [{ name: "الطعم", value: "فراخ" }] });
  for (const options of [
    [{ name: "weight", value: "3kg" }, { name: "Unknown Product Label", value: "فراخ" }],
    [{ name: "weight", value: "3kg" }, { name: "flavor", value: "فراخ" }, { name: "الطعم", value: "سمك" }],
  ]) {
    assert.deepEqual(match(product([variant({ options })]), criteria), { matches: [], unverifiedCount: 1 });
  }
  assert.equal(match(product([variant({ options: [{ name: "weight", value: "3kg" }, { name: "flavor", value: "سمك" }] })]), criteria).matches.length, 0);
});

test("simple title facts require a complete explicit package suffix, never a partial multipack/range/dose", () => {
  for (const title of ["Food bag 3kg", "Food Net Weight: ٣ كجم", "طعام - وزن العبوة: ۳ كيلو"]) {
    const row = { type: "SIMPLE", name_en: title, price: 900, warehouseStocks: [] };
    assert.equal(match(row).matches.length, 1, title);
  }
  for (const title of ["Food 3 kg", "For dogs weighing 3kg", "Capacity 3L", "bag 3kg x 2", "2 x bag 3kg", "2 bag 3kg", "bag 3kg - 5kg",
    "bag 3kg; 2 bags", "bag 3kg | 2 pieces", "bag 3kg + 1kg", "bag 3kg per dose", "bag 3kg-5kg", "pack 3kg/ml", "pack 3kg bottle 500ml", "٢ عبوة ٣ كجم"]) {
    const row = { type: "SIMPLE", name_en: title, price: 900, warehouseStocks: [] };
    assert.equal(match(row).matches.length, 0, title);
    assert.equal(match(row).unverifiedCount, 1, title);
  }
});

test("title conflicts remain unknown and cannot fill missing variant attributes", () => {
  const conflicting = product([variant()], { name_en: "Food bag 4kg", name_ar: "عبوة ٣ كجم" });
  assert.equal(match(conflicting).unverifiedCount, 1); assert.equal(match(conflicting).matches.length, 0);
  const missing = product([variant({ options: [{ name: "color", value: "red" }] })], { name_en: "Food bag 3kg" });
  assert.equal(match(missing).unverifiedCount, 1);
  assert.equal(normalizeOfferAttributes(missing, missing.variants[0]).has("weight"), false);
  const simple = { type: "SIMPLE", name_en: "Food bag 3kg", name_ar: "عبوة ٤ كجم", price: 900, warehouseStocks: [] };
  assert.equal(match(simple).unverifiedCount, 1);
  assert.equal(match(product([variant()], { name_en: "Food Size: 4kg" })).unverifiedCount, 1);
});

test("simple generic title values never qualify from just the first part of a list", () => {
  const row = { type: "SIMPLE", name_en: "Toy Color: red, blue", price: 900, warehouseStocks: [] };
  assert.equal(match(row, filters({ minimumPackageWeightGrams: null, options: [{ name: "color", value: "red" }] })).matches.length, 0);
  row.name_en = "Toy Color: red";
  assert.equal(match(row, filters({ minimumPackageWeightGrams: null, options: [{ name: "color", value: "red" }] })).matches.length, 1);
});

test("generic Weight/Size mass excludes known body-weight/dose context and non-mass values", () => {
  assert.equal(match(product([variant({ options: [{ name: "Size", value: "3000 g" }] })])).matches.length, 1);
  for (const name_en of ["Leash max weight 50KG", "Medicine for body weight 3kg", "Simparica for dogs", "Powder dose for pets"]) {
    assert.equal(match(product([variant()], { name_en })).unverifiedCount, 1, name_en);
    assert.equal(match({ type: "SIMPLE", name_en: `${name_en} Size: 3kg`, price: 900, warehouseStocks: [] }).unverifiedCount, 1, name_en);
  }
  for (const value of ["2.5-5kg", "20-40kg", "5 L", "1.5 K", "15", "1"]) {
    assert.equal(match(product([variant({ options: [{ name: "Weight", value }] })])).unverifiedCount, 1, value);
  }
});

test("reviewed legacy labels are product-specific, preserve provenance and support names longer than the model bound", () => {
  const examples = [
    ["69c3f22634e2e2e70fe8a75a", "alpha adult dog food with chicken", "4 kg", "weight", 4000],
    ["69b46fa00c9ac0a2214ee30c", "birbo cat food chicken ,beef & fish", "25kg", "weight", 25000],
    ["69b47cf00c9ac0a221550207", "ciuffi salmon cat dry food", "15kg", "weight", 15000],
    ["69b81a6b7b15b268715779f2", "amna cat creamy treats with blueberry & chicken", "5 pieces", "pieces", 5],
    ["6ad6b59ceb45a87653b72bae", "Blue", "Pink", "color", "pink"],
    ["6a30262bb3969830981e78aa", "Nunbell Dog Chew Toy", "Green", "color", "green"],
    ["6a12e650f1b561ed6cbed489", "Best Pet Gurme Adult Cat With Different Flavors", "Salmon", "flavor", "salmon"],
    ["69c71428e439a89ee5ad83f6", "royal canin giant adult - dry food for giant active dogs. adult weight from 45 kg and over - over 18\\24 months", "4KG", "weight", 4000],
  ];
  for (const [_id, name, value, key, expected] of examples) {
    const offer = variant({ options: [{ name, value }] }); const row = product([offer], { _id, name_en: name });
    const actual = normalizeOfferAttributes(row, offer).get(key);
    assert.equal(actual.state, "known", name); assert.equal(actual.value, expected, name);
    assert.deepEqual(actual.sources, [{ field: "variant.options", variantId: A, name, value }]);
    const foreign = normalizeOfferAttributes({ ...row, _id: OTHER }, offer);
    assert.equal(foreign.has(key), false, "a reviewed label cannot become a global alias");
  }
});

test("unreviewed legacy labels remain available as literal facts but cannot prove the requested dimension", () => {
  const offer = variant({ options: [{ name: "New Full Product Title", value: "3kg" }] });
  const facts = normalizeOfferAttributes(product(), offer);
  assert.equal(facts.get("new full product title").value, "3kg"); assert.equal(facts.has("weight"), false);
  assert.equal(match(product([offer])).unverifiedCount, 1);
  assert.equal(match(product([offer]), filters({ minimumPackageWeightGrams: null, options: [{ name: "New Full Product Title", value: "3kg" }] })).matches.length, 1);
});

test("same-variant weight/price matching cannot borrow a cheaper smaller variant or its discount", () => {
  const row = product([variant({ price: 400, discountedPrice: 300, options: [{ name: "weight", value: "1kg" }] }), variant({ _id: B, price: 1200 })]);
  assert.deepEqual(match(row), { matches: [], unverifiedCount: 0 });
  row.variants[1].discountedPrice = 999.99;
  const result = match(row); assert.equal(result.matches.length, 1); assert.equal(result.matches[0].variantId, B);
  assert.equal(result.matches[0].price, 1200); assert.equal(result.matches[0].discountedPrice, 999.99);
  assert.equal(result.matches[0].finalPriceMinor, 99999);
});

test("all requested options belong to the same offer and all ambiguous/contradictory facts withhold exact matches", () => {
  const row = product([
    variant({ options: [{ name: "weight", value: "3kg" }, { name: "color", value: "Red" }, { name: "flavor", value: "Salmon" }] }),
    variant({ _id: B, options: [{ name: "weight", value: "3kg" }, { name: "color", value: "Blue" }, { name: "flavor", value: "Chicken" }] }),
  ]);
  const criteria = filters({ options: [{ name: "Colour", value: "RED" }, { name: "flavour", value: "Chicken" }] });
  assert.equal(match(row, criteria).matches.length, 0);
  criteria.options[1].value = "salmon"; assert.equal(match(row, criteria).matches[0].variantId, A);
  for (const options of [[{ name: "Weight", value: "3kg" }, { name: "وزن", value: "4kg" }],
    [{ name: "Weight", value: "3kg" }, { name: "Size", value: "5kg" }], [{ name: "Weight", value: "3kg" }, { name: "weight", value: "3 K" }]]) {
    assert.equal(match(product([variant({ options })])).unverifiedCount, 1);
  }
  assert.equal(match(product([variant({ options: [{ name: "Weight", value: "3kg" }, { name: "وزن", value: "3000 g" }] })])).matches.length, 1);
});

test("real shared promotion rounding and manual discounts determine the exact inclusive EGP budget", () => {
  const row = product([variant({ price: 1200.5, discountedPrice: 950.25 })]);
  const promotion = { discountPercent: 20 };
  const price = computeFinalDiscountedPrice({ ...row.variants[0], promoPercent: 20 });
  assert.equal(price.promoPrice, 960); assert.equal(match(row, filters({ maximumPriceMinor: 95025 }), promotion).matches[0].finalPriceMinor, 95025);
  assert.equal(match(row, filters({ maximumPriceMinor: 95024 }), promotion).matches.length, 0);
  row.variants[0].discountedPrice = 0;
  assert.equal(match(row, filters({ maximumPriceMinor: 96000 }), promotion).matches[0].discountedPrice, 960);
  assert.equal(match(row, filters({ maximumPriceMinor: 95999 }), promotion).matches.length, 0);
  assert.equal(match(row, filters({ maximumPriceMinor: 0 }), { discountPercent: 100 }).matches[0].finalPriceMinor, 0);
});

test("missing, invalid and fractional-cent money cannot qualify even with a valid discount or free promotion", () => {
  for (const price of [null, undefined, "900", NaN, Infinity, -1, 900.001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(match(product([variant({ price, discountedPrice: 1 })]), filters(), { discountPercent: 100 }).unverifiedCount, 1, String(price));
  }
  for (const discountedPrice of [NaN, Infinity, -1, "300", 800.001, 900]) {
    assert.equal(match(product([variant({ discountedPrice })])).unverifiedCount, 1, String(discountedPrice));
  }
  for (const discountPercent of [undefined, NaN, Infinity, -1, 101, "20"]) {
    assert.equal(match(product(), filters(), { discountPercent }).unverifiedCount, 1, String(discountPercent));
  }
  assert.equal(match(product([variant({ price: 0 })]), filters({ maximumPriceMinor: 0 })).matches[0].finalPriceMinor, 0);
});

test("stock is variant-local and warehouse-specific; availability sorts before price then variant ID", () => {
  const row = product([
    variant({ price: 100, warehouseStocks: [{ warehouse: OTHER, quantity: 99 }] }),
    variant({ _id: C, price: 900 }), variant({ _id: B, price: 900 }),
  ], { warehouseStocks: [{ warehouse: W, quantity: 99 }] });
  const offers = match(row).matches;
  assert.deepEqual(offers.map((offer) => offer.variantId), [B, C, A]); assert.deepEqual(offers.map((offer) => offer.inStock), [true, true, false]);
  assert.equal(matchProductOffers(row, filters(), OTHER).matches[0].variantId, A);
});

test("malformed or duplicate stock/variant identities remain unverified, while an explicit empty stock array is unavailable", () => {
  for (const warehouseStocks of [undefined, null, [null], [{ warehouse: W, quantity: -1 }], [{ warehouse: W, quantity: "2" }],
    [{ warehouse: W, quantity: Infinity }], [{ warehouse: W, quantity: 1 }, { warehouse: W, quantity: 2 }], [{ warehouse: "invalid", quantity: 1 }]]) {
    assert.equal(match(product([variant({ warehouseStocks })])).unverifiedCount, 1);
  }
  for (const variants of [[null], [variant({ _id: undefined })], [variant({ _id: "invalid" })], [variant(), variant()]]) {
    const result = match(product(variants)); assert.equal(result.matches.length, 0); assert.equal(result.unverifiedCount, variants.length);
  }
  assert.equal(match(product([variant({ warehouseStocks: [] })])).matches[0].inStock, false);
  assert.throws(() => matchProductOffers(product(), filters(), null), { code: "invalid_catalog_context" });
});

test("strict filter validation never converts missing/invalid constraints into a loose match", () => {
  assert.equal(productFilters(undefined), null); assert.equal(productFilters(filters({ minimumPackageWeightGrams: null, maximumPriceMinor: null })), null);
  const valid = filters(); assert.equal(productFilters(valid), valid);
  for (const value of [null, [], {}, { ...filters(), extra: 1 }, filters({ minimumPackageWeightGrams: undefined }), filters({ maximumPriceMinor: undefined }),
    filters({ maximumPriceMinor: -1 }), filters({ minimumPackageWeightGrams: 1.2 }), filters({ maximumPriceMinor: "100" }),
    filters({ options: Array(6).fill({ name: "color", value: "red" }) }), filters({ options: [null] }), filters({ options: [[]] }),
    filters({ options: [{ name: " ", value: "red" }] }), filters({ options: [{ name: "color", value: "red", variantId: A }] })]) {
    assert.throws(() => productFilters(value), { code: "invalid_product_filters" });
  }
});
