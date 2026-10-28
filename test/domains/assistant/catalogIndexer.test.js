import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogIndexer, readCatalogSource, catalogSourceOffers } from "../../../src/domains/assistant/products/assistant.catalog-indexer.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { bundleCatalogOffer } from "../../../src/domains/assistant/products/assistant.catalog-offers.js";
import { AssistantCatalogVector } from "../../../src/domains/assistant/products/assistant.catalog-vector.model.js";
import { AssistantProviderError } from "../../../src/domains/assistant/providers/providerContract.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { catalogEmbeddingLedger, catalogPrice, catalogUsage, catalogVector } from "./fixtures/catalogEmbedding.js";

function fixture(t) {
  const ledger = catalogEmbeddingLedger(), state = ledger.state;
  const owner = "1".repeat(24), warehouse = "2".repeat(24), id = "3".repeat(24);
  const config = testConfig({ productSearchEnabled: true, catalogSemanticEnabled: true, catalogSemanticMinimumScore: 0.8 });
  Object.assign(state, { calls: 0, projectionWrites: 0, vectors: [], errors: [], role: "superAdmin", currentConfig: config,
    product: { _id: id, isActive: true, type: "SIMPLE", name_en: "Scratching post", name_ar: "عمود خربشة", price: 100,
      warehouseStocks: [{ warehouse, quantity: 3 }], desc_en: "Stable scratching surface" } });
  t.mock.method(console, "error", message => state.errors.push(message));
  const query = read => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, async lean() { return read(); } });
  const vectors = {
    find(filter) { return query(() => state.vectors.filter(row => !filter._id || row._id > filter._id.$gt).slice(0, 16)); },
    findById: value => query(() => state.vectors.find(row => row._id === value) ?? null),
    deleteMany(filter) { return { async maxTimeMS() {
      const before = state.vectors.length;
      state.vectors = state.vectors.filter(row => filter._id.$in ? !filter._id.$in.includes(row._id)
        : row.kind !== filter.kind || String(row.sourceId) !== String(filter.sourceId) || filter._id.$nin.includes(row._id));
      return { deletedCount: before - state.vectors.length };
    } }; },
    async updateOne(filter, update, options) {
      state.projectionWrites++;
      assert.equal(options.upsert, true); assert.equal(options.runValidators, true);
      await new AssistantCatalogVector(update.$set).validate();
      if (state.failProjection) throw Error("Fictional failed vector write");
      const index = state.vectors.findIndex(row => row._id === filter._id), saved = structuredClone(update.$set);
      if (index < 0) state.vectors.push(saved); else state.vectors[index] = saved;
    },
  };
  const products = {
    find: filter => query(() => state.product && filter._id.$in.map(String).includes(String(state.product._id)) ? [{ _id: state.product._id }] : []),
    findOne: filter => query(() => state.product && (!filter._id || String(state.product._id) > String(filter._id.$gt)) ? { _id: state.product._id } : null),
  };
  const bundles = { find: () => query(() => []), findOne: () => query(() => null) };
  const options = { ...ledger.execution, vectors, products, bundles, ownerId: () => owner, getConfig: () => state.currentConfig,
    getActor: async value => { assert.equal(String(value), owner); return { user: { role: state.role } }; },
    ensureStore: async () => {}, ensureReceipts: async () => {}, ensureIndex: async () => {},
    readSource: async () => state.product, embeddingConfig: () => ({ price: catalogPrice, timeoutMs: 1000 }),
    adapterFactory: () => ({ model: catalogPrice.model, dimensions: 1536, async embed({ input }) {
      state.calls++; assert.equal(input.length, 1); if (state.respond) return state.respond();
      return { vectors: [catalogVector()], usage: catalogUsage };
    } }),
  };
  let worker = createCatalogIndexer(options);
  return { ...ledger, config, warehouse, restart() { worker = createCatalogIndexer(options); },
    async tick(enabled = true) { const result = worker.start(config, enabled); await worker.idle(); return result; },
    async cycle() { for (let i = 0; i < 4; i++) { worker.start(config, true); await worker.idle(); } }, stop: () => worker.stop() };
}

test("indexing shares embedding accounting and reuses content after stock/price changes and restart", async t => {
  const f = fixture(t); await f.tick(); assert.equal(f.state.errors.length, 0); assert.equal(f.state.vectors.length, 1);
  assert.equal(f.state.rows[0].kind, "catalog_offer"); assert.equal(f.state.rows[0].sourceId, f.state.product._id);
  assert.equal(f.state.calls, 1); assert.equal(f.state.spent, 15); assert.equal(f.state.held, 0);
  f.state.product.price = 90; f.state.product.warehouseStocks = [{ warehouse: "4".repeat(24), quantity: 2 }];
  f.restart(); await f.tick(); assert.equal(f.state.calls, 1); assert.deepEqual(f.state.vectors[0].warehouseIds, ["4".repeat(24)]);
  assert.equal(f.state.reserved, 1); assert.equal(f.state.errors.length, 0);
  const writes = f.state.projectionWrites;
  f.state.product.price = 80; f.state.product.warehouseStocks[0].quantity = 4;
  f.restart(); await f.tick(); assert.equal(f.state.projectionWrites, writes); assert.equal(f.state.calls, 1);
});
test("changed content gets its own durable receipt; a failed projection reuses its settled vector", async t => {
  const f = fixture(t); f.state.failProjection = true; await f.tick(); assert.equal(f.state.calls, 1); assert.equal(f.state.vectors.length, 0);
  f.state.failProjection = false; await f.tick(); assert.equal(f.state.calls, 1); assert.equal(f.state.vectors.length, 1);
  f.state.product.name_en = "Updated scratching post"; f.restart(); await f.tick(); assert.equal(f.state.calls, 2);
  assert.equal(f.state.rows.length, 2); assert.equal(f.state.spent, 30); assert.match(f.state.vectors[0].text, /Updated/);
});
test("unknown usage is held and repeat scans cannot redispatch it", async t => {
  const f = fixture(t); f.state.respond = () => { throw new AssistantProviderError("timeout", { chargeExposure: "unknown" }); };
  await f.tick(); f.restart(); await f.tick(); assert.equal(f.state.calls, 1); assert.equal(f.state.rows[0].status, "uncertain");
  assert.equal(f.state.vectors.length, 0); assert.ok(f.state.held > 0); assert.equal(f.state.spent, 0);
});
test("disabled indexing, missing budget and non-SuperAdmin ownership cannot dispatch", async t => {
  const f = fixture(t); assert.equal((await f.tick(false)).enabled, false); assert.equal(f.state.calls, 0);
  f.state.role = "admin"; await f.tick(); assert.equal(f.state.calls, 0); assert.equal(f.state.rows.length, 0);
  f.state.role = "superAdmin"; f.state.denyBudget = true; await f.tick(); assert.equal(f.state.calls, 0); assert.equal(f.state.held, 0);
});
test("inactive and deleted parents remove only the derived vector without new spending", async t => {
  const f = fixture(t); await f.tick(); f.state.product.isActive = false; f.restart(); await f.tick();
  assert.equal(f.state.vectors.length, 0); assert.equal(f.state.calls, 1);
  f.state.product.isActive = true; f.restart(); await f.tick(); assert.equal(f.state.calls, 1); assert.equal(f.state.vectors.length, 1);
  f.state.product = null; f.restart(); await f.tick(); assert.equal(f.state.vectors.length, 0); assert.equal(f.state.rows.length, 1);
});
test("config/source changes after paid response settle usage without publishing a stale vector", async t => {
  const f = fixture(t); f.state.respond = () => {
    f.state.product.name_en = "Changed while embedding"; return { vectors: [catalogVector()], usage: catalogUsage };
  };
  await f.tick(); assert.equal(f.state.spent, 15); assert.equal(f.state.vectors.length, 0);
  f.state.respond = () => { f.state.currentConfig = { ...f.config, signature: "different" }; return { vectors: [catalogVector()], usage: catalogUsage }; };
  await f.cycle(); assert.equal(f.state.vectors.length, 0);
});

test("the real Mongoose source query orders taxonomy population inside a shared transaction", async t => {
  const session = { fictional: true }; let reads = 0;
  t.mock.method(ProductModel.Query.prototype, "exec", async function () {
    reads++; assert.equal(this.getOptions().session, session);
    const populated = this.mongooseOptions().populate;
    assert.deepEqual(Object.keys(populated).sort(), ["brand", "category", "subcategory"]);
    assert.ok(Object.values(populated).every(option => option.ordered === true));
    return { _id: "3".repeat(24) };
  });
  await readCatalogSource("product", "3".repeat(24), session); assert.equal(reads, 1);
});

test("the database bundle selection preserves descriptions used by fresh semantic hashes", async t => {
  const warehouse = "1".repeat(24);
  const products = ["a", "b"].map(letter => ({ _id: letter.repeat(24), type: "SIMPLE", isActive: true,
    name_en: `Product ${letter}`, price: 100, warehouseStocks: [{ warehouse, quantity: 2 }] }));
  const bundle = { _id: "c".repeat(24), origin: "manual", status: "published", name_en: "Kit", name_ar: "مجموعة",
    desc_en: "A description used in the semantic document", desc_ar: "وصف المجموعة", pricePiastres: 15000,
    components: products.map(row => ({ productId: row._id, productType: "SIMPLE", quantity: 1 })) };
  t.mock.method(ManualBundle.Query.prototype, "exec", async function () {
    const fields = this.projection(); return Object.fromEntries(Object.entries(bundle).filter(([key]) => fields[key]));
  });
  t.mock.method(ProductModel.Query.prototype, "exec", async () => products);
  const source = await readCatalogSource("bundle", bundle._id);
  assert.equal(catalogSourceOffers("bundle", source)[0].textHash, bundleCatalogOffer(bundle, products).textHash);
});
