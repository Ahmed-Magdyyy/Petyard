import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import mongoose from "mongoose";

export const catalogNativeAssets = [
  ".scratch/assistant-retrieval/catalog-semantic-quality-v3/results.jsonl",
  ".scratch/assistant-retrieval/catalog-semantic-quality-v3/summary.json",
  ".scratch/assistant-retrieval/catalog-semantic-quality-v3/documents.json",
  ".scratch/assistant-retrieval/catalog-semantic-quality-v3/catalog.json",
  ".scratch/assistant-retrieval/catalog-semantic-quality-v3/cases.json",
  ".scratch/assistant-retrieval/catalog-semantic-focused-v4/summary.json",
];
export const nativeWarehouses = [1, 2, 3, 4].map(number => String(number).repeat(24));
export async function buildCatalogNativeAssets(run) {
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  const base = ".scratch/assistant-retrieval/catalog-semantic-quality-v3/";
  const catalog = await json(base + "catalog.json"), documents = await json(base + "documents.json");
  const summary = await json(base + "summary.json"), cases = await json(base + "cases.json");
  const focused = await json(".scratch/assistant-retrieval/catalog-semantic-focused-v4/summary.json");
  const batches = (await readFile(base + "results.jsonl", "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.type === "embedding");
  const texts = batches.flatMap(row => row.input), vectors = batches.flatMap(row => row.vectors);
  assert.equal(texts.length, 18); assert.equal(vectors.length, 18);
  assert.ok(vectors.every(row => row.length === 1536 && row.every(Number.isFinite) && row.some(value => value !== 0)));
  assert.deepEqual(texts, [...documents.map(row => row.text), ...summary.queryRows.map(row => row.queryText)]);
  const byText = new Map(texts.map((text, index) => [text, vectors[index]]));
  assert.equal(byText.size, 18);
  const oid = value => new mongoose.Types.ObjectId(String(value));
  const stocks = (rows, ids) => ids.map(id => ({ warehouse: oid(id), quantity: rows[0].quantity }));
  const brands = new Map(), categories = new Map();
  const products = catalog.products.map(source => {
    const product = structuredClone(source);
    product._id = oid(source._id);
    if (source.brand) { brands.set(source.brand._id, { ...source.brand, _id: oid(source.brand._id) }); product.brand = oid(source.brand._id); }
    if (source.category) { categories.set(String(source.category), { _id: oid(source.category) }); product.category = oid(source.category); }
    const ids = source._id.endsWith("4") ? [nativeWarehouses[0], nativeWarehouses[1], nativeWarehouses[3]]
      : source._id.endsWith("5") ? nativeWarehouses.slice(1) : nativeWarehouses;
    if (source.type === "SIMPLE") product.warehouseStocks = stocks(source.warehouseStocks, ids);
    else product.variants = source.variants.map(variant => ({ ...variant, _id: oid(variant._id),
      warehouseStocks: stocks(variant.warehouseStocks, variant._id === "bbbbbbbbbbbbbbbbbbbbbbbb"
        ? [nativeWarehouses[1], nativeWarehouses[3]] : nativeWarehouses) }));
    return product;
  });
  const bundles = catalog.bundles.map(bundle => ({ ...bundle, _id: oid(bundle._id), components: bundle.components.map(row => ({ ...row,
    productId: oid(row.productId), ...(row.variantId ? { variantId: oid(row.variantId) } : {}) })) }));
  const { catalogOffers, bundleCatalogOffer } = await import("../../../../src/domains/assistant/products/assistant.catalog-offers.js");
  const populated = products.map(product => ({ ...product, brand: brands.get(String(product.brand)),
    category: product.category ? categories.get(String(product.category)) : null }));
  const offers = [...populated.flatMap(catalogOffers), ...bundles.map(bundle => bundleCatalogOffer(bundle, populated))];
  assert.equal(offers.length, 10);
  for (const offer of offers) {
    const original = documents.find(row => row._id === offer._id); assert.ok(original);
    assert.equal(offer.text, original.text); assert.equal(offer.textHash, original.textHash);
    assert.ok(offer.warehouseIds.includes(nativeWarehouses[1]));
  }
  const queries = cases.filter(row => row.shopping).map(row => {
    const saved = summary.queryRows.find(item => item.caseId === row.id); assert.ok(saved);
    const data = structuredClone(row.id === "en_brand_sku_fountain"
      ? focused.responses.find(item => item.id === "en_brand_sku_fountain_1").result
      : summary.responses.find(item => item.id === row.id).result);
    const queryText = `Species: ${row.species}\nShopping request: ${data.productSearch.query}`;
    assert.equal(queryText, saved.queryText, "Reused vectors require identical input bytes");
    assert.ok(byText.has(queryText)); return { ...row, data, queryText, vector: byText.get(queryText) };
  });
  return { products, populated, bundles, offers, brands: [...brands.values()], categories: [...categories.values()],
    warehouses: nativeWarehouses.map(id => ({ _id: oid(id), active: true })), subject: catalog.pet, queries, byText,
    owner: oid(createHash("sha256").update(run + ":owner").digest("hex").slice(0, 24)) };
}
