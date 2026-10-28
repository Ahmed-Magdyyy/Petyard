import { computeFinalDiscountedPrice } from "../../../shared/utils/pricing.js";
import { reject } from "../shared/assistant.errors.js";
import { attributeName, attributeValue, normalizeOfferAttributes, packageWeightGrams } from "./assistant.product-attributes.js";

export function productFilters(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["minimumPackageWeightGrams", "maximumPriceMinor", "options"].includes(key)) ||
      (value.minimumPackageWeightGrams !== null && (!Number.isSafeInteger(value.minimumPackageWeightGrams) || value.minimumPackageWeightGrams < 1 || value.minimumPackageWeightGrams > 1_000_000_000)) ||
      (value.maximumPriceMinor !== null && (!Number.isSafeInteger(value.maximumPriceMinor) || value.maximumPriceMinor < 0 || value.maximumPriceMinor > 100_000_000_000)) ||
      !Array.isArray(value.options) || value.options.length > 5 || value.options.some((option) => !option || typeof option !== "object" || Array.isArray(option) ||
        Object.keys(option).some((key) => !["name", "value", "sourceQuote"].includes(key)) ||
        typeof option.name !== "string" || !option.name.trim() || option.name.length > 80 ||
        typeof option.value !== "string" || !option.value.trim() || option.value.length > 80 ||
        (option.sourceQuote !== undefined && (typeof option.sourceQuote !== "string" || option.sourceQuote.length > 500)))) reject("invalid_product_filters");
  return value.minimumPackageWeightGrams === null && value.maximumPriceMinor === null && !value.options.length ? null : value;
}

function cents(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(result / 100 - value) <= Number.EPSILON * Math.max(1, value) * 8 ? result : null;
}

export function matchProductOffers(product, filters, warehouseId, promotion = null) {
  filters = productFilters(filters); if (!filters) reject("invalid_product_filters");
  if (!/^[a-f\d]{24}$/i.test(String(warehouseId))) reject("invalid_catalog_context");
  const variants = product.type === "VARIANT" ? (Array.isArray(product.variants) ? product.variants : []) : product.type === "SIMPLE" ? [null] : [];
  const matches = []; let unverifiedCount = 0;
  const idCounts = new Map();
  for (const variant of variants) if (variant?._id) {
    const id = String(variant._id); idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const variant of variants) {
    if (product.type === "VARIANT" && (!variant || !/^[a-f\d]{24}$/i.test(String(variant._id)) || idCounts.get(String(variant._id)) !== 1)) { unverifiedCount++; continue; }
    const source = variant ?? product;
    if (cents(source.price) === null || (source.discountedPrice != null && (cents(source.discountedPrice) === null || source.discountedPrice > source.price)) ||
        (promotion !== null && (!Number.isFinite(promotion.discountPercent) || promotion.discountPercent < 0 || promotion.discountPercent > 100))) { unverifiedCount++; continue; }
    const attributes = normalizeOfferAttributes(product, variant);
    const price = computeFinalDiscountedPrice({ price: source.price, discountedPrice: source.discountedPrice, promoPercent: promotion?.discountPercent });
    const finalMinor = cents(price.finalEffective);
    let unknown = finalMinor === null; let failed = false;
    if (filters.maximumPriceMinor !== null && finalMinor !== null && finalMinor > filters.maximumPriceMinor) failed = true;
    const weight = attributes.get("weight");
    if (filters.minimumPackageWeightGrams !== null) {
      if (weight?.state !== "known") unknown = true;
      else if (weight.value < filters.minimumPackageWeightGrams) failed = true;
    }
    for (const option of filters.options) {
      let key = attributeName(option.name);
      if (key === "size" && packageWeightGrams(option.value) !== null) key = "weight";
      const expected = attributeValue(key, option.value); const actual = attributes.get(key);
      if (key === "other") { unknown = true; continue; }
      if (["brand", "sku"].includes(key)) {
        const values = key === "brand" ? [product.brand?.name_en, product.brand?.name_ar] : [(variant ?? product).sku];
        const known = values.filter(value => typeof value === "string" && value.trim());
        if (expected === null || !known.length) unknown = true;
        else if (!known.some(value => attributeValue(key, value) === expected)) failed = true;
        else attributes.set(key, { state: "known", value: expected, sources: known.map(value => ({ field: key, value })) });
        continue;
      }
      if (expected === null || actual?.state !== "known") unknown = true;
      else if (actual.value !== expected) failed = true;
    }
    if (failed) continue;
    if (unknown) { unverifiedCount++; continue; }
    if (!Array.isArray(source.warehouseStocks) || source.warehouseStocks.some((stock) => !stock || !/^[a-f\d]{24}$/i.test(String(stock.warehouse)))) { unverifiedCount++; continue; }
    const stocks = source.warehouseStocks.filter((stock) => String(stock.warehouse) === String(warehouseId));
    const quantity = !stocks.length ? 0 : stocks.length === 1 && Number.isFinite(stocks[0].quantity) && stocks[0].quantity >= 0 ? stocks[0].quantity : null;
    if (quantity === null) { unverifiedCount++; continue; }
    matches.push({ variantId: variant ? String(variant._id) : null, price: price.basePrice, discountedPrice: price.final,
      finalPriceMinor: finalMinor, inStock: quantity > 0,
      attributes: [...attributes].filter(([, entry]) => entry.state === "known").map(([name, entry]) => ({ name, value: entry.value, sources: entry.sources })) });
  }
  matches.sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.finalPriceMinor - b.finalPriceMinor || (a.variantId ?? "").localeCompare(b.variantId ?? ""));
  return { matches, unverifiedCount };
}
