import { fromPiastres } from '../../shared/utils/money.js';

function normalizeLang(lang) {
  return lang === 'ar' ? 'ar' : 'en';
}

function displayPrice(snapshot) {
  return typeof snapshot?.basePrice === 'number'
    ? snapshot.basePrice
    : fromPiastres(snapshot.unitPricePiastres);
}

function displayDiscountedPrice(snapshot) {
  return typeof snapshot?.discountedPrice === 'number'
    ? snapshot.discountedPrice
    : null;
}

function variantCandidate(snapshot) {
  return {
    variantId: snapshot.variantId,
    options: snapshot.variantOptions || [],
    productImageUrl: snapshot.productImageUrl || null,
    price: displayPrice(snapshot),
    discountedPrice: displayDiscountedPrice(snapshot),
    stockQuantity: snapshot.stockQuantity,
    stockRevision: snapshot.stockRevision,
  };
}

export function presentSubstitutionCandidateProduct(snapshots, lang) {
  const available = Array.isArray(snapshots) ? snapshots : [];
  if (available.length === 0) return null;

  const first = available[0];
  const localizedName =
    normalizeLang(lang) === 'ar'
      ? first.productName_ar
      : first.productName_en;
  const hasVariants = first.productType === 'VARIANT';

  if (!hasVariants) {
    return {
      product: first.product,
      productType: first.productType,
      name: localizedName,
      productImageUrl: first.productImageUrl || null,
      price: displayPrice(first),
      discountedPrice: displayDiscountedPrice(first),
      hasVariants: false,
      stockQuantity: first.stockQuantity,
      stockRevision: first.stockRevision,
      variants: [],
    };
  }

  const variants = available.map(variantCandidate);
  const price = Math.min(...variants.map((variant) => variant.price));
  const effectivePrices = variants.map(
    (variant) => variant.discountedPrice ?? variant.price,
  );
  const minimumEffectivePrice = Math.min(...effectivePrices);

  return {
    product: first.product,
    productType: first.productType,
    name: localizedName,
    productImageUrl: first.productImageUrl || null,
    price,
    discountedPrice:
      minimumEffectivePrice < price ? minimumEffectivePrice : null,
    hasVariants: true,
    variants,
  };
}
