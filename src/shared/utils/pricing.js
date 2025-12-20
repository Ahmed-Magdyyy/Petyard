export function roundMoney(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return value;
  return Math.round(value * 100) / 100;
}

export function applyPercentDiscount(amount, percent) {
  const amt = typeof amount === "number" ? amount : Number(amount);
  const pct = typeof percent === "number" ? percent : Number(percent);
  if (!Number.isFinite(amt) || !Number.isFinite(pct)) return amt;
  if (pct <= 0) return amt;
  if (pct >= 100) return 0;
  return roundMoney(amt * (1 - pct / 100));
}

// - Promotion is calculated on the base price
// - The final effective price is the minimum of:
//   - basePrice
//   - manual discountedPrice (if present)
//   - promo price (if promoPercent present)
// - `final` is only returned when it's strictly less than basePrice.
export function computeFinalDiscountedPrice({ price, discountedPrice, promoPercent }) {
  const basePrice = typeof price === "number" ? price : null;
  const baseDiscounted =
    typeof discountedPrice === "number" ? discountedPrice : null;

  if (basePrice == null) {
    return {
      basePrice: null,
      baseDiscountedPrice: baseDiscounted,
      promoPrice: null,
      final: null,
      finalEffective: null,
      appliedPromotion: false,
    };
  }

  const promoPrice =
    typeof promoPercent === "number"
      ? applyPercentDiscount(basePrice, promoPercent)
      : null;

  const candidates = [basePrice];
  if (typeof baseDiscounted === "number") {
    candidates.push(baseDiscounted);
  }
  if (typeof promoPrice === "number") {
    candidates.push(promoPrice);
  }

  const finalEffective = Math.min(...candidates);
  const finalDiscounted = finalEffective < basePrice ? finalEffective : null;

  const appliedPromotion =
    typeof promoPrice === "number" &&
    promoPrice === finalEffective &&
    promoPrice < basePrice &&
    (baseDiscounted == null || promoPrice <= baseDiscounted);

  return {
    basePrice,
    baseDiscountedPrice: baseDiscounted,
    promoPrice: typeof promoPrice === "number" ? promoPrice : null,
    final: finalDiscounted,
    finalEffective,
    appliedPromotion,
  };
}
