import { ProductModel } from "../../product/product.model.js";
import { ManualBundle } from "../../bundle/bundle.model.js";
import { roles } from "../../../shared/constants/enums.js";
import { requireAnalyticsActor } from "../admin/assistant.admin-access.js";
import { loadAssistantConfig } from "../shared/assistant.config.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { createOpenAIEmbeddingsAdapter, embeddingProfile } from "../providers/openaiEmbeddings.js";
import { createEmbeddingExecutor } from "../references/assistant.embedding-executor.js";
import { assertEmbeddingBatchStore } from "../references/assistant.embedding-batch.model.js";
import { loadEmbeddingConfig } from "../references/assistant.reference-config.js";
import { AssistantCatalogVector, assertCatalogVectorStore, assertCatalogVectorIndex } from "./assistant.catalog-vector.model.js";
import { catalogOffers, bundleCatalogOffer, catalogSourceFields } from "./assistant.catalog-offers.js";
import { catalogOfferEmbeddingKey } from "./assistant.catalog-semantic.js";

// Paid admission also calls this reader in a transaction, where populate queries must be sequential.
const taxonomy = ["brand", "category", "subcategory"].map(path => ({ path, select: "_id name_en name_ar", ordered: true }));
const validVector = value => Array.isArray(value) && value.length === embeddingProfile.dimensions &&
  Array.from(value).every(Number.isFinite) && value.some(number => number !== 0);
export async function readCatalogSource(kind, id, session = null) {
  if (kind === "product") return ProductModel.findById(id).select(catalogSourceFields).populate(taxonomy).session(session).maxTimeMS(5000).lean();
  if (kind !== "bundle") reject("invalid_catalog_source");
  const bundle = await ManualBundle.findById(id).select("_id origin aiEvidenceJson status revision name_en name_ar desc_en desc_ar components pricePiastres").session(session).maxTimeMS(5000).lean();
  if (!bundle) return null;
  const ids = [...new Set((bundle.components ?? []).map(row => String(row.productId)))].map(objectId);
  const products = await ProductModel.find({ _id: { $in: ids } }).select(catalogSourceFields).populate(taxonomy).session(session).maxTimeMS(5000).lean();
  return { bundle, products };
}
export const catalogSourceOffers = (kind, source) => !source ? [] : kind === "product" ? catalogOffers(source)
  : [bundleCatalogOffer(source.bundle, source.products)].filter(Boolean);

// One source page per poll. Restarting safely rescans; paid keys survive process restarts.
export function createCatalogIndexer({ vectors = AssistantCatalogVector, products = ProductModel, bundles = ManualBundle,
  readSource = readCatalogSource, ensureStore = assertCatalogVectorStore, ensureIndex = assertCatalogVectorIndex,
  ensureReceipts = assertEmbeddingBatchStore, getActor = requireAnalyticsActor, getConfig = loadAssistantConfig,
  embeddingConfig = loadEmbeddingConfig, adapterFactory = () => createOpenAIEmbeddingsAdapter({ apiKey: process.env.OPENAI_API_KEY }),
  ownerId = () => process.env.ASSISTANT_CATALOG_INDEX_OWNER_ID, now = () => new Date(), ...execution } = {}) {
  const execute = createEmbeddingExecutor({ now, ...execution });
  let cursor = null, kind = "product", pending = null, cleanupCursor = null, running = null, controller = null, stopping = false;
  const sourceModel = value => value === "product" ? products : bundles;
  async function actor(owner, session = null) {
    const { user } = await getActor(owner, { session }); if (user.role !== roles.SUPER_ADMIN) reject("access_denied", 403);
  }
  async function removeOrphans() {
    const rows = await vectors.find(cleanupCursor ? { _id: { $gt: cleanupCursor } } : {}).select("_id kind sourceId").sort({ _id: 1 }).limit(16).maxTimeMS(5000).lean();
    const missing = [];
    for (const type of ["product", "bundle"]) {
      const ids = rows.filter(row => row.kind === type).map(row => row.sourceId);
      if (!ids.length) continue;
      const current = await sourceModel(type).find({ _id: { $in: ids } }).select("_id").limit(16).maxTimeMS(5000).lean();
      const present = new Set(current.map(row => String(row._id)));
      missing.push(...rows.filter(row => row.kind === type && !present.has(String(row.sourceId))).map(row => row._id));
    }
    if (missing.length) await vectors.deleteMany({ _id: { $in: missing } }).maxTimeMS(5000);
    cleanupCursor = rows.length === 16 ? rows.at(-1)._id : null;
  }
  async function processOne(config, signal) {
    const owner = objectId(ownerId()); await actor(owner);
    await ensureStore(); await ensureReceipts(); await ensureIndex();
    const retrieval = embeddingConfig(config); await removeOrphans();
    if (!pending) {
      const source = await sourceModel(kind).findOne(cursor ? { _id: { $gt: cursor } } : {}).select("_id").sort({ _id: 1 }).maxTimeMS(5000).lean();
      if (!source) { cursor = null; kind = kind === "product" ? "bundle" : "product"; return; }
      pending = { id: source._id, kind, offset: 0 };
    }
    const current = pending, source = await readSource(current.kind, current.id), offers = catalogSourceOffers(current.kind, source);
    await vectors.deleteMany({ kind: current.kind, sourceId: current.id, _id: { $nin: offers.map(row => row._id) } }).maxTimeMS(5000);
    for (const offer of offers.slice(current.offset, current.offset + 16)) {
      if (signal.aborted) return;
      const latestConfig = getConfig();
      if (latestConfig.catalogSemanticEnabled !== true || latestConfig.signature !== config.signature) reject("configuration_changed", 409);
      await actor(owner);
      const existing = await vectors.findById(offer._id).maxTimeMS(5000).lean();
      const key = catalogOfferEmbeddingKey(offer);
      let vector = existing?.textHash === offer.textHash && existing.embeddingKey === key && existing.model === embeddingProfile.model &&
        existing.dimensions === embeddingProfile.dimensions && validVector(existing.vector) ? existing.vector : null;
      // Price/quantity-only changes need no vector rewrite while the same warehouses remain eligible.
      if (vector && JSON.stringify((existing.warehouseIds ?? []).map(String).sort()) === JSON.stringify([...offer.warehouseIds].sort())) continue;
      if (!vector && !offer.warehouseIds.length) continue;
      if (!vector) {
        const receipt = await execute({ key, identity: { kind: "catalog_offer", owner, sourceId: objectId(offer.sourceId), offerId: offer._id, textHash: offer.textHash },
          input: [offer.text], shared: config, price: retrieval.price, timeoutMs: retrieval.timeoutMs, adapter: adapterFactory(), signal,
          authorize: async session => {
            const live = getConfig();
            if (live.catalogSemanticEnabled !== true || live.signature !== config.signature) reject("configuration_changed", 409);
            await actor(owner, session);
            const rows = catalogSourceOffers(current.kind, await readSource(current.kind, current.id, session));
            if (!rows.some(row => row._id === offer._id && row.textHash === offer.textHash && row.warehouseIds.length)) reject("catalog_source_changed", 409);
          } });
        if (receipt.kind !== "catalog_offer" || receipt.offerId !== offer._id || receipt.textHash !== offer.textHash ||
            String(receipt.sourceId) !== offer.sourceId || receipt.model !== embeddingProfile.model || receipt.dimensions !== embeddingProfile.dimensions) reject("catalog_embedding_conflict", 409);
        if (receipt.status !== "completed" || receipt.accounting !== "settled") continue;
        vector = receipt.vectors?.[0];
      }
      if (!validVector(vector)) reject("catalog_embedding_invalid", 503);
      const fresh = catalogSourceOffers(current.kind, await readSource(current.kind, current.id)).find(row => row._id === offer._id && row.textHash === offer.textHash);
      if (!fresh || signal.aborted || getConfig().signature !== config.signature) continue;
      await actor(owner);
      await vectors.updateOne({ _id: offer._id }, { $set: { ...fresh, model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
        vector, embeddingKey: key, checkedAt: now() } }, { upsert: true, runValidators: true, maxTimeMS: 5000 });
    }
    current.offset += 16;
    if (current.offset >= offers.length) { cursor = current.id; pending = null; }
  }
  return {
    start(config, enabled = process.env.ASSISTANT_CATALOG_INDEXING_ENABLED === "true") {
      if (config?.enabled !== true || config.catalogSemanticEnabled !== true || !enabled || stopping) return { enabled: false };
      if (running) return { enabled: true, scheduled: false };
      controller = new AbortController();
      running = processOne(config, controller.signal).catch(() => {
        console.error("[Assistant Catalog Worker] Index refresh unavailable; keyword search remains available");
      }).finally(() => { running = null; controller = null; });
      return { enabled: true, scheduled: true };
    },
    async idle() { await running; },
    async stop() { stopping = true; controller?.abort(); await running; },
  };
}
export const catalogIndexer = createCatalogIndexer();
