import {
  findActiveCouponByCodeService,
  computeCouponEffect,
} from "./coupon.service.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { OrderModel } from "../order/order.model.js";

/**
 * Shared coupon validation & pricing helper.
 *
 * Centralises every coupon rule that was previously duplicated in
 * checkout.service.js and order.service.js.
 *
 * @param {Object}  opts
 * @param {string}  opts.couponCode       – raw code from the request
 * @param {string|null} opts.userId       – authenticated user, or null for guests
 * @param {Array}   opts.cartItems        – [{ product: ObjectId, lineTotal: number, hasDiscount: boolean }]
 * @param {Map<string,string>} opts.productBrandMap – Map<productId, brandId>
 * @param {number}  opts.subtotal         – full cart / order subtotal
 * @param {number}  opts.shippingFee      – resolved shipping fee
 * @param {string}  [opts.lang="en"]
 *
 * @returns {Promise<{
 *   couponCode: string|null,
 *   discountAmount: number,
 *   shippingDiscount: number,
 *   totalDiscount: number,
 *   total: number,
 *   couponDoc: object|null,
 * }>}
 */
export async function validateAndApplyCoupon({
  couponCode,
  userId,
  cartItems,
  productBrandMap,
  subtotal,
  shippingFee,
  lang = "en",
}) {
  // ── No coupon provided – return zero-discount result ───────────────
  if (!couponCode) {
    const total = subtotal + shippingFee;
    return {
      couponCode: null,
      discountAmount: 0,
      shippingDiscount: 0,
      totalDiscount: 0,
      total,
      couponDoc: null,
    };
  }

  const trimmedCode =
    typeof couponCode === "string" && couponCode.trim()
      ? couponCode.trim()
      : null;

  if (!trimmedCode) {
    throw new ApiError(
      lang === "en" ? "couponCode is required" : "كود الكوبون مطلوب",
      400,
    );
  }

  // ── 1. Find active coupon ──────────────────────────────────────────
  const coupon = await findActiveCouponByCodeService(trimmedCode);

  // ── 2. Allowed users ───────────────────────────────────────────────
  const allowedUserIds = Array.isArray(coupon.allowedUserIds)
    ? coupon.allowedUserIds
    : [];

  if (allowedUserIds.length > 0) {
    if (!userId) {
      throw new ApiError(
        lang === "en"
          ? "This coupon is only available to specific users"
          : "هذا الكوبون متاح لمستخدمين محددين فقط",
        403,
      );
    }

    const isAllowed = allowedUserIds.some(
      (id) => String(id) === String(userId),
    );

    if (!isAllowed) {
      throw new ApiError(
        lang === "en"
          ? "This coupon is not valid for this user"
          : "هذا الكوبون غير صالح لهذا المستخدم",
        403,
      );
    }
  }

  // ── 3. Global usage limit ──────────────────────────────────────────
  if (
    typeof coupon.maxUsageTotal === "number" &&
    coupon.maxUsageTotal >= 0 &&
    typeof coupon.usageCount === "number" &&
    coupon.usageCount >= coupon.maxUsageTotal
  ) {
    throw new ApiError(
      lang === "en"
        ? "This coupon has reached its maximum usage limit"
        : "هذا الكوبون قد وصل إلى الحد الأقصى للاستخدام",
      400,
    );
  }

  // ── 4. Per-user usage limit ────────────────────────────────────────
  if (userId && typeof coupon.maxUsagePerUser === "number") {
    if (coupon.maxUsagePerUser >= 0) {
      const userUsage = await OrderModel.countDocuments({
        user: userId,
        couponCode: coupon.code,
      });

      if (userUsage >= coupon.maxUsagePerUser) {
        throw new ApiError(
          lang === "en"
            ? "You have already used this coupon the maximum number of times"
            : "لقد استخدمت هذا الكوبون بالفعل الحد الأقصى من المرات",
          400,
        );
      }
    }
  }

  // ── 5. Min / max order total (against FULL subtotal) ───────────────
  if (
    typeof coupon.minOrderTotal === "number" &&
    coupon.minOrderTotal > 0 &&
    subtotal < coupon.minOrderTotal
  ) {
    throw new ApiError(
      lang === "en"
        ? `This coupon requires a minimum order total of ${coupon.minOrderTotal}`
        : `هذا الكوبون يتطلب حد أدنى للطلب بقيمة ${coupon.minOrderTotal}`,
      400,
    );
  }

  if (
    typeof coupon.maxOrderTotal === "number" &&
    coupon.maxOrderTotal > 0 &&
    subtotal > coupon.maxOrderTotal
  ) {
    throw new ApiError(
      lang === "en"
        ? `This coupon can only be applied to orders up to ${coupon.maxOrderTotal} max`
        : `هذا الكوبون يمكن تطبيقه فقط على الطلبات التي تصل إلى ${coupon.maxOrderTotal} كحد أقصى`,
      400,
    );
  }

  // ── 6. Compute eligible subtotal ───────────────────────────────────
  const excludedBrandIds = Array.isArray(coupon.excludedBrandIds)
    ? new Set(coupon.excludedBrandIds.map((id) => String(id)))
    : new Set();

  const items = Array.isArray(cartItems) ? cartItems : [];

  // Track per-item eligibility for logging and guardrail verification
  const eligibilityLog = [];
  let eligibleSubtotal = 0;

  for (const item of items) {
    const productId = String(item.product);
    const itemBrandId = productBrandMap.get(productId) || null;

    // Item is ineligible if it already has any discount (manual or promotion)
    if (item.hasDiscount) {
      eligibilityLog.push({ productId, brandId: itemBrandId, lineTotal: item.lineTotal, reason: "has_discount" });
      continue;
    }

    // Item is ineligible if its product brand is in the coupon's excluded list
    if (excludedBrandIds.size > 0 && itemBrandId && excludedBrandIds.has(String(itemBrandId))) {
      eligibilityLog.push({ productId, brandId: itemBrandId, lineTotal: item.lineTotal, reason: "brand_excluded" });
      continue;
    }

    // Item is eligible
    const lineTotal =
      typeof item.lineTotal === "number" && item.lineTotal > 0
        ? item.lineTotal
        : 0;
    eligibleSubtotal += lineTotal;
    eligibilityLog.push({ productId, brandId: itemBrandId, lineTotal, reason: "eligible" });
  }

  // Log eligibility decisions when brand exclusions are active
  if (excludedBrandIds.size > 0) {
    console.log(
      `[Coupon] Brand exclusion audit for ${coupon.code}: ` +
      `excludedBrands=[${[...excludedBrandIds]}], ` +
      `eligibleSubtotal=${eligibleSubtotal}, fullSubtotal=${subtotal}, ` +
      `items=${JSON.stringify(eligibilityLog)}`,
    );
  }

  // If nothing is eligible for price discount AND coupon has a price discount, reject.
  // FreeShipping-only coupons still apply (shipping is order-level, not item-level).
  if (eligibleSubtotal <= 0 && coupon.discountType) {
    throw new ApiError(
      lang === "en"
        ? "This coupon is not valid for the items in your cart"
        : "هذا الكوبون غير صالح للمنتجات الموجودة في سلة التسوق",
      400,
    );
  }

  // ── Guardrail: re-verify no excluded-brand item leaked into eligibleSubtotal ──
  if (excludedBrandIds.size > 0 && eligibleSubtotal > 0 && coupon.discountType) {
    let verifiedEligible = 0;
    for (const entry of eligibilityLog) {
      if (entry.reason === "eligible") {
        // Double-check the brand is genuinely not excluded
        if (entry.brandId && excludedBrandIds.has(String(entry.brandId))) {
          console.error(
            `[Coupon] GUARDRAIL TRIGGERED: item ${entry.productId} with brand ${entry.brandId} ` +
            `leaked through brand exclusion for coupon ${coupon.code}. Zeroing discount.`,
          );
          verifiedEligible = 0;
          break;
        }
        verifiedEligible += entry.lineTotal || 0;
      }
    }
    eligibleSubtotal = verifiedEligible;

    // Re-check after guardrail correction
    if (eligibleSubtotal <= 0) {
      throw new ApiError(
        lang === "en"
          ? "This coupon is not valid for the items in your cart"
          : "هذا الكوبون غير صالح للمنتجات الموجودة في سلة التسوق",
        400,
      );
    }
  }

  // ── 7. Compute discount on eligible subtotal only ──────────────────
  const effect = computeCouponEffect(coupon, {
    orderSubtotal: eligibleSubtotal,
    shippingFee,
  });

  // ── 8. Build result with full subtotal in pricing ──────────────────
  // discountAmount is based on eligibleSubtotal, but the total is
  // computed from the full subtotal so the response stays consistent.
  const finalTotal =
    subtotal - effect.discountAmount + (shippingFee - effect.shippingDiscount);

  return {
    couponCode: coupon.code,
    discountAmount: effect.discountAmount,
    shippingDiscount: effect.shippingDiscount,
    totalDiscount: effect.totalDiscount,
    total: finalTotal,
    couponDoc: coupon,
  };
}
