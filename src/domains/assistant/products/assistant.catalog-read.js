import { ManualBundle } from "../../bundle/bundle.model.js";
import { requireBundleCatalogStore } from "../../bundle/bundle.repository.js";
import { buildBundleProductCard } from "../../bundle/bundle.product-card.js";
import { ProductModel } from "../../product/product.model.js";
import { BrandModel } from "../../brand/brand.model.js";
import { findProducts } from "../../product/product.repository.js";
import { buildInStockFilter, mapProductToCardDto } from "../../product/product.service.js";
import { findActivePromotionsForProducts } from "../../collection/collection.promotion.js";
import { resolveEffectiveWarehouse } from "../../warehouse/warehouse.fulfillment.js";
import { buildFlexibleSearchPattern, escapeRegex } from "../../../shared/utils/escapeRegex.js";
import { catalogDietaryRisk, classifyCatalogProduct } from "./assistant.catalog-policy.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { fields, objectId, text } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { matchProductOffers, productFilters } from "./assistant.product-matching.js";
import { bundleCatalogOffer, catalogOffers, catalogSourceFields } from "./assistant.catalog-offers.js";
import { attributeName } from "./assistant.product-attributes.js";

const select = "_id slug type isActive name_en name_ar price discountedPrice images warehouseStocks.warehouse warehouseStocks.quantity variants._id variants.options variants.price variants.discountedPrice variants.warehouseStocks.warehouse variants.warehouseStocks.quantity category subcategory brand";
const semanticSelect = `${catalogSourceFields} slug discountedPrice images`;
const candidateLimit = 20;
const cardLimit = 3;

function searchTerms(query, subject) {
  const name = typeof subject?.name === "string" ? subject.name.trim() : "";
  const species = typeof subject?.species === "string" ? subject.species.trim() : "";
  if (name && name.length <= 80 && species.length <= 80) {
    const kind = species ? `(?:(?<species>${escapeRegex(species)})\\s+)?` : "";
    // Remove only an explicit trailing reference to this pet; the same name can still be a product/brand elsewhere.
    const reference = new RegExp(`\\s+for\\s+${kind}${escapeRegex(name)}$`, "iu").exec(query);
    if (reference) query = query.slice(0, reference.index) + (reference.groups?.species ? ` ${reference.groups.species}` : "");
  }
  return [...new Set(query.split(/\s+/u).map((term) => term.toLowerCase()))];
}

function validSemanticDescriptors(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(), valid = [];
  for (const candidate of value.slice(0, candidateLimit)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !== "_id,kind,sourceId,textHash,variantId" ||
        typeof candidate._id !== "string" || typeof candidate.kind !== "string" || typeof candidate.sourceId !== "string" ||
        typeof candidate.textHash !== "string" || !/^[a-f\d]{24}$/i.test(candidate.sourceId) || !/^[a-f\d]{64}$/.test(candidate.textHash)) continue;
    const sourceId = String(candidate.sourceId).toLowerCase();
    const variantId = candidate.variantId == null ? null : String(candidate.variantId).toLowerCase();
    if (candidate.kind === "product" && (candidate.variantId !== null && !/^[a-f\d]{24}$/i.test(candidate.variantId) ||
        typeof candidate.variantId !== "string" && candidate.variantId !== null)) continue;
    if (candidate.kind === "bundle" && candidate.variantId !== null) continue;
    const expected = candidate.kind === "bundle" ? `bundle:${sourceId}`
      : candidate.kind === "product" ? `product:${sourceId}:${variantId ?? "simple"}` : null;
    if (!expected || candidate._id !== expected || seen.has(expected)) continue;
    seen.add(expected);
    valid.push({ ...candidate, sourceId, variantId });
  }
  return valid;
}

async function semanticDocuments(semanticCandidates, signal, warehouseId, query) {
  if (signal?.aborted || typeof semanticCandidates !== "function") return [];
  try {
    const candidates = await semanticCandidates({ warehouseId, query });
    return signal?.aborted ? [] : validSemanticDescriptors(candidates);
  }
  catch { return []; }
}

async function semanticProducts(descriptors, warehouseId) {
  const productsOnly = descriptors.filter(row => row.kind === "product");
  const ids = [...new Set(productsOnly.map(row => row.sourceId))];
  if (!ids.length) return new Map();
  try {
    const rows = await ProductModel.find({ _id: { $in: ids }, isActive: true, type: { $in: ["SIMPLE", "VARIANT"] },
      ...buildInStockFilter(warehouseId) }).select(semanticSelect).populate("brand", "_id name_en name_ar")
      .populate("category", "_id name_en name_ar").populate("subcategory", "_id name_en name_ar").maxTimeMS(5000).lean();
    const byId = new Map(rows.map(row => [String(row._id).toLowerCase(), row]));
    const matched = new Map();
    for (const descriptor of productsOnly) {
      const product = byId.get(descriptor.sourceId);
      const offer = product && catalogOffers(product).find(row => row._id === descriptor._id && row.textHash === descriptor.textHash && row.warehouseIds.includes(warehouseId));
      if (!offer) continue;
      const current = matched.get(descriptor.sourceId) ?? { product, variants: new Set(), rank: descriptors.indexOf(descriptor) };
      if (descriptor.variantId) current.variants.add(descriptor.variantId);
      matched.set(descriptor.sourceId, current);
    }
    return matched;
  } catch { return new Map(); }
}

async function appendBundleCards(result, patterns, warehouse, language, risk, config, semanticDescriptors = []) {
  const ordering = { keywordIds: new Set(), ranks: new Map() };
  if (config.bundleCartEnabled !== true || result.products.length >= cardLimit && !semanticDescriptors.length) return ordering;
  await requireBundleCatalogStore();
  const search = field => ({ $and: patterns.map(regex => ({ [field]: regex })) });
  const definitions = await ManualBundle.find({ origin: { $in: ["manual", "ai"] }, status: "published", $or: [search("name_en"), search("name_ar")] })
    .select("_id origin aiEvidenceJson status revision name_en name_ar components pricePiastres").sort({ _id: 1 }).limit(candidateLimit).maxTimeMS(5000).lean();
  let semanticDefinitions = [];
  const bundleIds = [...new Set(semanticDescriptors.filter(row => row.kind === "bundle").map(row => row.sourceId))];
  if (bundleIds.length) {
    try {
      semanticDefinitions = await ManualBundle.find({ _id: { $in: bundleIds }, origin: { $in: ["manual", "ai"] }, status: "published" })
        .select("_id origin aiEvidenceJson status revision name_en name_ar desc_en desc_ar components pricePiastres").maxTimeMS(5000).lean();
    } catch { semanticDefinitions = []; }
  }
  const semanticById = new Map(semanticDescriptors.filter(row => row.kind === "bundle").map(row => [row.sourceId, row]));
  const ranks = new Map(semanticDescriptors.filter(row => row.kind === "bundle").map(row => [row.sourceId, semanticDescriptors.indexOf(row)]));
  semanticDefinitions.sort((a, b) => ranks.get(String(a._id)) - ranks.get(String(b._id)));
  const keywordBundleIds = new Set(definitions.map(row => String(row._id).toLowerCase()));
  const allDefinitions = [...definitions, ...semanticDefinitions.filter(row => !definitions.some(keyword => String(keyword._id) === String(row._id)))];
  const ids = [...new Set(allDefinitions.flatMap(row => row.components.map(component => String(component.productId))))].map(objectId);
  const products = ids.length ? await ProductModel.find({ _id: { $in: ids }, isActive: true, ...buildInStockFilter(String(warehouse._id)) })
    .select(select + " variants.images").maxTimeMS(5000).lean() : [];
  let added = 0;
  for (const bundle of allDefinitions) {
    const semantic = keywordBundleIds.has(String(bundle._id).toLowerCase()) ? null : semanticById.get(String(bundle._id).toLowerCase());
    if (semantic) {
      const projected = bundleCatalogOffer(bundle, products);
      if (!projected || projected._id !== semantic._id || projected.textHash !== semantic.textHash || !projected.warehouseIds.includes(String(warehouse._id))) continue;
    }
    let card;
    try { card = buildBundleProductCard({ bundle, warehouse, products, lang: language }); }
    catch (error) { if (/^BUNDLE_/.test(error.code)) continue; throw error; }
    if (!card) continue;
    if (["known", "unknown"].includes(risk) && card.components.some(component =>
      classifyCatalogProduct(products.find(row => String(row._id) === component.productId), config.catalogClassification) !== "nonfood")) {
      result.withheldCount++; continue;
    }
    result.products.push({ ...card, priceDisplay: "exact" });
    const id = String(bundle._id);
    if (keywordBundleIds.has(id)) ordering.keywordIds.add(id); else ordering.ranks.set(id, ranks.get(id));
    added++;
    if (semanticDescriptors.length ? added >= cardLimit : result.products.length === cardLimit) break;
  }
  return ordering;
}

// Internal read only: caller must authorize and bind pet/warning context, outside retryable financial transactions.
export async function readAssistantCatalog(input, config, { semanticCandidates, signal } = {}) {
  requireEnabled(config); fields(input, ["query", "warehouseId", "language", "subject", "warnings", "filters"]);
  const query = text(input.query, 120);
  const filters = productFilters(input.filters);
  if (!["ar", "en"].includes(input.language)) reject("invalid_request");
  const risk = catalogDietaryRisk(input.subject, input.warnings);
  const requested = input.warehouseId === null ? null : String(objectId(input.warehouseId));
  const result = { status: "needs_location", requestedWarehouseId: requested, effectiveWarehouseId: null, rerouted: false,
    generatedAt: null, classificationVersion: config.catalogClassification?.version ?? null, dietaryRisk: risk,
    withheldCount: 0, products: [] };
  if (!requested) return result;
  const warehouse = await resolveEffectiveWarehouse(requested);
  const effective = String(warehouse.effectiveWarehouse._id);
  // FE supplies the resolved warehouse; a later routing change requires fresh app location context.
  if (effective !== requested) reject("catalog_warehouse_changed", 409);
  Object.assign(result, { effectiveWarehouseId: effective, rerouted: warehouse.rerouted });
  const semantic = config.catalogSemanticEnabled === true
    ? await semanticDocuments(semanticCandidates, signal, effective, query) : [];
  const patterns = searchTerms(query, input.subject).map((term) => ({ $regex: buildFlexibleSearchPattern(term), $options: "i" }));
  const search = (field) => ({ $and: patterns.map((regex) => ({ [field]: regex })) });
  const brands = await BrandModel.find({ $or: [search("name_en"), search("name_ar")] }).select("_id").limit(20).maxTimeMS(5000).lean();
  const filter = { isActive: true, type: { $in: ["SIMPLE", "VARIANT"] }, $or: [search("name_en"), search("name_ar"), search("tags"),
    search("variants.options.name"), search("variants.options.value"),
    ...(brands.length ? [{ brand: { $in: brands.map((brand) => brand._id) } }] : [])] };
  const stock = buildInStockFilter(effective);
  const identifierFilters = filters?.options.some(option => ["brand", "sku"].includes(attributeName(option.name)));
  const read = (condition, limit) => {
    const rows = findProducts({ $and: [filter, condition] }, { limit, sort: { _id: 1 }, select: select + (identifierFilters ? " sku variants.sku" : ""), lean: true });
    if (identifierFilters) rows.populate("brand", "_id name_en name_ar");
    return rows.maxTimeMS(5000);
  };
  const keywordCandidates = await read(stock, candidateLimit);
  const semanticRows = signal?.aborted ? new Map() : await semanticProducts(semantic, effective);
  const candidates = [...keywordCandidates];
  const candidateIds = new Set(candidates.map(row => String(row._id)));
  for (const [sourceId, match] of semanticRows) {
    if (candidateIds.has(String(match.product._id))) continue;
    const product = match.product.type === "VARIANT"
      ? { ...match.product, variants: match.product.variants.filter(row => match.variants.has(String(row._id).toLowerCase())) }
      : match.product;
    candidates.push(product); candidateIds.add(String(product._id));
  }
  candidates.length = Math.min(candidates.length, candidateLimit);
  const permitted = candidates.filter((product) => {
    const classification = classifyCatalogProduct(product, config.catalogClassification);
    return !["known", "unknown"].includes(risk) || classification === "nonfood";
  });
  result.withheldCount = candidates.length - permitted.length;
  const promotions = await findActivePromotionsForProducts(filters ? permitted : permitted.slice(0, cardLimit), new Date());
  let selected = permitted.map((product) => ({ product, matching: null }));
  if (filters) {
    selected = permitted.map((product) => {
      const matching = matchProductOffers(product, filters, effective, promotions.get(String(product._id)) ?? null);
      matching.matches = matching.matches.filter((offer) => offer.inStock);
      return { product, matching };
    });
    result.unverifiedOfferCount = selected.reduce((sum, row) => sum + row.matching.unverifiedCount, 0);
    selected = selected.filter((row) => row.matching.matches.length);
  }
  const stockedHere = (offer) => Array.isArray(offer.warehouseStocks) && offer.warehouseStocks.some((entry) =>
    String(entry.warehouse) === effective && Number.isFinite(entry.quantity) && entry.quantity > 0);
  result.products = selected.slice(0, cardLimit).map(({ product, matching }) => {
    const localProduct = product.type === "VARIANT" ? { ...product, variants: (product.variants ?? []).filter(stockedHere) } : product;
    const dto = mapProductToCardDto(localProduct, { lang: input.language, promotion: promotions.get(String(product._id)) ?? null, warehouseId: effective });
    const offer = matching?.matches[0];
    return { id: String(dto.id), slug: dto.slug, name: dto.name, type: dto.type, image: dto.image,
      price: offer ? offer.price : dto.price, discountedPrice: offer ? offer.discountedPrice : dto.discountedPrice,
      inStock: offer ? offer.inStock : dto.inStock, hasVariants: dto.hasVariants,
      priceDisplay: offer || dto.type !== "VARIANT" ? "exact" : "from",
      ...(matching ? { matchingOffers: matching.matches.slice(0, 3), matchingOfferCount: matching.matches.length } : {}) };
  }).filter((card) => card.inStock);
  const keywordIds = new Set(keywordCandidates.map(row => String(row._id)));
  const fullKeywordCards = result.products.length === cardLimit && result.products.every(card => keywordIds.has(card.id));
  const bundleOrdering = !filters && !fullKeywordCards ? await appendBundleCards(result, patterns, warehouse.effectiveWarehouse, input.language, risk, config,
    signal?.aborted ? [] : semantic) : { keywordIds: new Set(), ranks: new Map() };
  if (semantic.length) {
    const priority = card => card.type === "BUNDLE" ? bundleOrdering.keywordIds.has(card.id) : keywordIds.has(card.id);
    const rank = card => card.type === "BUNDLE" ? bundleOrdering.ranks.get(card.id) : semanticRows.get(card.id)?.rank;
    result.products.sort((a, b) => Number(priority(b)) - Number(priority(a)) ||
      (priority(a) ? 0 : (rank(a) ?? Infinity) - (rank(b) ?? Infinity)));
    result.products = result.products.slice(0, cardLimit);
  }
  result.status = result.products.length ? "results" : result.withheldCount ? "food_review_required"
    : result.unverifiedOfferCount ? "needs_verified_filters" : "empty";
  result.generatedAt = new Date().toISOString();
  return result;
}
