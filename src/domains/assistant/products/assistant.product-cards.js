import { normalizeFixedBundleComponents } from "../../bundle/bundle.components.js";
import { reject } from "../shared/assistant.errors.js";
import { attributeName, attributeValue, packageWeightGrams } from "./assistant.product-attributes.js";

export const CATALOG_MAX_BYTES = 16384;
const statuses = ["results", "empty", "needs_subject", "needs_location", "food_review_required", "needs_verified_filters", "unavailable"];
const invalid = () => reject("invalid_catalog_snapshot", 503);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const string = (value, max) => typeof value === "string" && value.length <= max && value.trim() && !value.includes("\u0000");
const id = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const nullableId = (value) => value === null || id(value);
const money = (value) => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) &&
  Math.abs(Math.round(value * 100) / 100 - value) <= Number.EPSILON * Math.max(1, value) * 8;
const weight = (value) => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const subjectId = (value) => value === null || typeof value === "string" && /^(pet:[a-f\d]{24}|chat:[a-f\d-]{36})$/.test(value);

function safeImage(value) {
  if (value === null) return true;
  if (!string(value, 2048)) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function bundleCard(value) {
  if (!id(value.id) || value.slug !== null || !string(value.name, 2000) || !safeImage(value.image) ||
      !money(value.price) || value.price <= 0 || !money(value.discountedPrice) || value.discountedPrice <= 0 || value.discountedPrice > value.price ||
      value.inStock !== true || value.hasVariants !== false || value.priceDisplay !== "exact" || !id(value.warehouseId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.components)) invalid();
  let normalized;
  try { normalized = normalizeFixedBundleComponents(value.components.map(row => ({ productId: row.productId, productType: row.productType, variantId: row.variantId, quantity: row.quantity }))); } catch { invalid(); }
  if (normalized.length !== value.components.length) invalid();
  const components = value.components.map(row => {
    if (!string(row.name, 2000) || !safeImage(row.image) || !Array.isArray(row.variantOptions) || row.variantOptions.length > 5 ||
        row.variantOptions.some(option => !object(option) || !string(option.name, 80) || !string(option.value, 80))) invalid();
    return { productId: row.productId, productType: row.productType, variantId: row.variantId, quantity: row.quantity,
      name: row.name, image: row.image, variantOptions: row.variantOptions.map(({ name, value }) => ({ name, value })) };
  });
  return { id: value.id, slug: null, name: value.name, type: "BUNDLE", image: value.image, price: value.price, discountedPrice: value.discountedPrice,
    inStock: true, hasVariants: false, priceDisplay: "exact", revision: value.revision, warehouseId: value.warehouseId, components };
}

function productCard(value) {
  if (object(value) && value.type === "BUNDLE") return bundleCard(value);
  if (!object(value) || !id(value.id) || !string(value.slug, 256) || !string(value.name, 2000) || !["SIMPLE", "VARIANT"].includes(value.type) ||
      !(value.image === null || string(value.image, 2048)) || !(value.price === null || money(value.price)) ||
      !(value.discountedPrice === null || money(value.discountedPrice) && value.price !== null && value.discountedPrice < value.price) ||
      typeof value.inStock !== "boolean" || typeof value.hasVariants !== "boolean" || !["from", "exact"].includes(value.priceDisplay)) invalid();
  if (value.image !== null) {
    let url; try { url = new URL(value.image); } catch { invalid(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid();
  }
  const card = { id: value.id, slug: value.slug, name: value.name, type: value.type, image: value.image,
    price: value.price, discountedPrice: value.discountedPrice, inStock: value.inStock, hasVariants: value.hasVariants, priceDisplay: value.priceDisplay };
  if (value.matchingOffer !== undefined) {
    const offer = value.matchingOffer;
    if (!object(offer) || value.priceDisplay !== "exact" || !money(value.price) || !Number.isSafeInteger(value.matchingOfferCount) || value.matchingOfferCount < 1 ||
        (value.type === "SIMPLE" ? offer.variantId !== null : !id(offer.variantId)) || !(offer.packageWeightGrams === null || weight(offer.packageWeightGrams)) ||
        !Array.isArray(offer.options) || offer.options.length > 5 || offer.options.some((entry) => !object(entry) || !string(entry.name, 80) || !string(entry.value, 80))) invalid();
    card.matchingOfferCount = value.matchingOfferCount;
    card.matchingOffer = { variantId: offer.variantId, packageWeightGrams: offer.packageWeightGrams,
      options: offer.options.map(({ name, value }) => ({ name, value })) };
  } else if (value.matchingOfferCount !== undefined) invalid();
  return card;
}

// Public allowlist shared by publication and history. Raw facts, warning text and internal bindings never leave this module.
export function catalogSnapshot(value) {
  if (!object(value) || value.version !== 1 || !statuses.includes(value.status) || !subjectId(value.subjectId) ||
      !(value.subjectName === null || string(value.subjectName, 80)) || !nullableId(value.requestedWarehouseId) || !nullableId(value.effectiveWarehouseId) ||
      typeof value.rerouted !== "boolean" || value.rerouted !== (value.effectiveWarehouseId !== null && value.effectiveWarehouseId !== value.requestedWarehouseId) ||
      !string(value.generatedAt, 40) || !Number.isFinite(Date.parse(value.generatedAt)) || value.dataMode !== "snapshot" || value.currency !== "EGP" || value.suitability !== "not_verified" ||
      !Array.isArray(value.notices) || value.notices.length > 3 || !Array.isArray(value.products) || value.products.length > 3 ||
      (value.status === "results" ? !value.products.length || !id(value.requestedWarehouseId) || !id(value.effectiveWarehouseId) : value.products.length !== 0)) invalid();
  const notices = value.notices.map((entry) => {
    if (!object(entry) || !["snapshot", "suitability_not_verified", "partial_food_withheld"].includes(entry.code) || !string(entry.text, 500)) invalid();
    return { code: entry.code, text: entry.text };
  });
  const snapshot = { version: 1, status: value.status, subjectId: value.subjectId, subjectName: value.subjectName,
    requestedWarehouseId: value.requestedWarehouseId, effectiveWarehouseId: value.effectiveWarehouseId, rerouted: value.rerouted,
    generatedAt: value.generatedAt, dataMode: "snapshot", currency: "EGP", suitability: "not_verified", notices, products: value.products.map(productCard) };
  if (new Set(snapshot.products.map((product) => `${product.type === "BUNDLE" ? "bundle" : "product"}:${product.id}`)).size !== snapshot.products.length ||
      snapshot.products.some(product => product.type === "BUNDLE" && product.warehouseId !== snapshot.effectiveWarehouseId) ||
      snapshot.products.some((product, index) => product.inStock && snapshot.products.slice(0, index).some((previous) => !previous.inStock))) invalid();
  if (Buffer.byteLength(JSON.stringify(snapshot)) > CATALOG_MAX_BYTES) invalid();
  return snapshot;
}

export function storedCatalogDto(json) {
  if (typeof json !== "string" || Buffer.byteLength(json) > CATALOG_MAX_BYTES) return null;
  try { return catalogSnapshot(JSON.parse(json)); } catch { return null; }
}

const replies = {
  en: {
    results: "Here are matching products. Open product details to check current price, availability and options. These are not verified dietary recommendations.",
    empty: "No verified matches were found in this search. You can browse the store or change your request.",
    needs_subject: "Which pet do you mean? You can name or describe it without creating a profile.",
    needs_location: "Choose your delivery area in the app, then send your request again.",
    food_review_required: "I can't verify food suitability for this pet. Please consult a veterinarian; ordinary store browsing is still available.",
    needs_verified_filters: "The available product information does not verify all your requested attributes. I haven't relaxed your requirements.",
    unavailable: "Product search is unavailable right now. You can use the store directly. No purchase was made.",
    snapshot: "Prices and availability can change. Product details refresh them.", suitability_not_verified: "Matching does not confirm medical or dietary suitability.",
    partial_food_withheld: "Some foods or unclassified products were withheld because dietary suitability is unverified.",
  },
  ar: {
    results: "دي منتجات مطابقة للشروط. افتح تفاصيل المنتج علشان تتأكد من السعر والتوفر والاختيارات الحالية. دي مش توصية غذائية مؤكدة لحيوانك.",
    empty: "ملقيتش منتجات مؤكدة مطابقة في البحث ده. ممكن تتصفح المتجر أو تغيّر طلبك.",
    needs_subject: "تقصد أنهي حيوان؟ ممكن تقول اسمه أو توصفه من غير ما تعمل له ملف.",
    needs_location: "اختار منطقة التوصيل في التطبيق، وبعدها ابعت طلبك تاني.",
    food_review_required: "مش قادر أأكد مناسبة الأكل لحيوانك. الأفضل تسأل طبيب بيطري، ولسه ممكن تتصفح المتجر عادي.",
    needs_verified_filters: "بيانات المنتجات المتاحة مش بتأكد كل الشروط اللي طلبتها. مش هعرض نتيجة على إنها مطابقة من غير تأكيد.",
    unavailable: "البحث عن المنتجات مش متاح دلوقتي. ممكن تستخدم المتجر مباشرة. ما حصلش أي شراء.",
    snapshot: "السعر والتوفر ممكن يتغيروا. افتح تفاصيل المنتج للتحديث.", suitability_not_verified: "المطابقة مش تأكيد للمناسبة الطبية أو الغذائية.",
    partial_food_withheld: "بعض الأكل أو المنتجات غير المصنفة مخفية لأن المناسبة الغذائية مش مؤكدة.",
  },
};

const localizedReplies = (language) => replies[language === "arabizi" ? "ar" : language] ?? replies.en;

export function buildCatalogSnapshot(outcome, intent, context, subject, language, now = new Date()) {
  if (!object(outcome) || !statuses.includes(outcome.status) || !Array.isArray(outcome.products) || outcome.products.length > 3) invalid();
  const products = outcome.products.map((product) => {
    const { matchingOfferCount, matchingOffers, ...base } = product;
    const card = productCard(base);
    if (intent.constrained) {
      const offer = product.matchingOffers?.[0];
      if (!offer || !Array.isArray(offer.attributes) || offer.price !== product.price || offer.discountedPrice !== product.discountedPrice || offer.inStock !== product.inStock ||
          !money(offer.price) || !Number.isSafeInteger(offer.finalPriceMinor) || offer.finalPriceMinor !== Math.round((offer.discountedPrice ?? offer.price) * 100)) invalid();
      const mass = offer.attributes.find((entry) => entry.name === "weight")?.value ?? null;
      if (intent.filters.minimumPackageWeightGrams !== null && (!weight(mass) || mass < intent.filters.minimumPackageWeightGrams) ||
          intent.filters.maximumPriceMinor !== null && offer.finalPriceMinor > intent.filters.maximumPriceMinor) invalid();
      const options = intent.filters.options.map((option) => {
        let key = attributeName(option.name);
        if (key === "size" && packageWeightGrams(option.value) !== null) key = "weight";
        const expected = attributeValue(key, option.value);
        if (expected === null || !offer.attributes.some((entry) => entry.name === key && entry.value === expected)) invalid();
        return { name: key, value: String(expected) };
      });
      card.matchingOfferCount = product.matchingOfferCount;
      card.matchingOffer = { variantId: offer.variantId, packageWeightGrams: mass, options };
    }
    return card;
  });
  const localized = localizedReplies(language);
  return catalogSnapshot({ version: 1, status: outcome.status, subjectId: subject?.id ?? null, subjectName: string(subject?.name, 80) ? subject.name : null,
    requestedWarehouseId: context.warehouseId, effectiveWarehouseId: outcome.effectiveWarehouseId ?? null, rerouted: outcome.rerouted ?? false,
    generatedAt: outcome.generatedAt ?? now.toISOString(), dataMode: "snapshot", currency: "EGP", suitability: "not_verified", products,
    notices: (outcome.status === "results" ? ["snapshot", "suitability_not_verified", ...(outcome.withheldCount > 0 ? ["partial_food_withheld"] : [])] : [])
      .map((code) => ({ code, text: localized[code] })) });
}

export function renderCatalogResponse(snapshot, language) {
  return localizedReplies(language)[snapshot.status] ?? invalid();
}
