import { ApiError } from "../../shared/ApiError.js";
import { getCartService } from "../cart/cart.service.js";
import { getWarehouseByIdService } from "../warehouse/warehouse.service.js";
import {
  findActiveCouponByCodeService,
  computeCouponEffect,
} from "../coupon/coupon.service.js";

export async function applyCouponAtCheckoutService({
  userId,
  guestId,
  warehouseId,
  couponCode,
  lang = "en",
}) {
  if (!couponCode || typeof couponCode !== "string" || !couponCode.trim()) {
    throw new ApiError("couponCode is required", 400);
  }

  if (!userId && !guestId) {
    throw new ApiError("Either userId or guestId must be provided", 400);
  }

  const trimmedCode = couponCode.trim();

  const cart = await getCartService({
    userId: userId || null,
    guestId: guestId || null,
    warehouseId,
    lang,
  });

  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError("Cart is empty", 400);
  }

  const subtotal =
    typeof cart.totalCartPrice === "number" && cart.totalCartPrice > 0
      ? cart.totalCartPrice
      : 0;

  if (subtotal <= 0) {
    throw new ApiError("Cart total must be greater than 0", 400);
  }

  const warehouse = await getWarehouseByIdService(warehouseId);
  const rawShipping = warehouse?.defaultShippingPrice;
  const shippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

  const coupon = await findActiveCouponByCodeService(trimmedCode);

  if (
    typeof coupon.minOrderTotal === "number" &&
    coupon.minOrderTotal > 0 &&
    subtotal < coupon.minOrderTotal
  ) {
    throw new ApiError(
      `This coupon requires a minimum order total of ${coupon.minOrderTotal}`,
      400
    );
  }

  if (
    typeof coupon.maxOrderTotal === "number" &&
    coupon.maxOrderTotal > 0 &&
    subtotal > coupon.maxOrderTotal
  ) {
    throw new ApiError(
      `This coupon can only be applied to orders up to ${coupon.maxOrderTotal}`,
      400
    );
  }

  if (
    typeof coupon.maxUsageTotal === "number" &&
    coupon.maxUsageTotal >= 0 &&
    typeof coupon.usageCount === "number" &&
    coupon.usageCount >= coupon.maxUsageTotal
  ) {
    throw new ApiError("This coupon has reached its maximum usage limit", 400);
  }

  const effect = computeCouponEffect(coupon, {
    orderSubtotal: subtotal,
    shippingFee,
  });

  const couponSummary = {
    id: coupon._id,
    code: coupon.code,
    discountType: coupon.discountType || null,
    discountValue:
      typeof coupon.discountValue === "number" ? coupon.discountValue : null,
    maxDiscountAmount:
      typeof coupon.maxDiscountAmount === "number"
        ? coupon.maxDiscountAmount
        : null,
    freeShipping: !!coupon.freeShipping,
    minOrderTotal:
      typeof coupon.minOrderTotal === "number" ? coupon.minOrderTotal : null,
    maxOrderTotal:
      typeof coupon.maxOrderTotal === "number" ? coupon.maxOrderTotal : null,
  };

  return {
    cartId: cart.id,
    warehouseId: cart.warehouseId,
    currency: cart.currency || "EGP",
    coupon: couponSummary,
    pricing: effect,
  };
}
