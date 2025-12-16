import { ApiError } from "../../shared/ApiError.js";
import { findCart } from "../cart/cart.repository.js";
import { getWarehouseByIdService } from "../warehouse/warehouse.service.js";
import {
  findActiveCouponByCodeService,
  computeCouponEffect,
} from "../coupon/coupon.service.js";
import { getCartService } from "../cart/cart.service.js";
import { OrderModel } from "../order/order.model.js";
import { UserModel } from "../user/user.model.js";

export async function applyCouponAtCheckoutService({
  userId,
  guestId,
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
  const filter = userId ? { user: userId } : { guestId };

  const cart = await findCart(filter);

  if (!cart) {
    throw new ApiError("Cart not found", 404);
  }

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

  const warehouseId = cart.warehouse;
  if (!warehouseId) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

  const warehouse = await getWarehouseByIdService(warehouseId);
  const rawShipping = warehouse?.defaultShippingPrice;
  const shippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

  const coupon = await findActiveCouponByCodeService(trimmedCode);

  const allowedUserIds =
    Array.isArray(coupon.allowedUserIds) ? coupon.allowedUserIds : [];

  if (allowedUserIds.length > 0) {
    if (!userId) {
      throw new ApiError(
        "This coupon is only available to specific users",
        403
      );
    }

    const isAllowed = allowedUserIds.some(
      (id) => String(id) === String(userId)
    );

    if (!isAllowed) {
      throw new ApiError("This coupon is not valid for this user", 403);
    }
  }

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

  if (userId && typeof coupon.maxUsagePerUser === "number") {
    if (coupon.maxUsagePerUser >= 0) {
      const userUsage = await OrderModel.countDocuments({
        user: userId,
        couponCode: coupon.code,
      });

      if (userUsage >= coupon.maxUsagePerUser) {
        throw new ApiError(
          "You have already used this coupon the maximum number of times",
          400
        );
      }
    }
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
    cartId: cart._id,
    warehouseId,
    currency: cart.currency || "EGP",
    coupon: couponSummary,
    pricing: effect,
  };
}

export async function getCheckoutSummaryService({
  userId,
  guestId,
  couponCode,
  lang = "en",
}) {
  if (!userId && !guestId) {
    throw new ApiError("Either userId or guestId must be provided", 400);
  }

  const identityFilter = userId ? { user: userId } : { guestId };

  const baseCart = await findCart(identityFilter);

  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  if (!baseCart.warehouse) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

  const warehouseId = baseCart.warehouse;

  const cartResponse = await getCartService({
    userId: userId || null,
    guestId: guestId || null,
    warehouseId,
    lang,
  });

  const subtotal =
    typeof cartResponse.totalCartPrice === "number" &&
    cartResponse.totalCartPrice > 0
      ? cartResponse.totalCartPrice
      : 0;

  if (subtotal <= 0) {
    throw new ApiError("Cart total must be greater than 0", 400);
  }

  const trimmedCode =
    typeof couponCode === "string" && couponCode.trim()
      ? couponCode.trim()
      : null;

  let coupon = null;
  let pricing;

  if (trimmedCode) {
    const couponPreview = await applyCouponAtCheckoutService({
      userId: userId || null,
      guestId: guestId || null,
      couponCode: trimmedCode,
      lang,
    });

    const effect = couponPreview.pricing;

    coupon = couponPreview.coupon;

    pricing = {
      subtotal: effect.subtotal,
      shippingFee: effect.shippingBefore,
      discountAmount: effect.discountAmount,
      shippingDiscount: effect.shippingDiscount,
      totalDiscount: effect.totalDiscount,
      total: effect.finalTotal,
    };
  } else {
    const warehouse = await getWarehouseByIdService(warehouseId);
    const rawShipping = warehouse?.defaultShippingPrice;
    const shippingFee =
      typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

    pricing = {
      subtotal,
      shippingFee,
      discountAmount: 0,
      shippingDiscount: 0,
      totalDiscount: 0,
      total: subtotal + shippingFee,
    };
  }

  // Calculate wallet deduction for authenticated users
  let walletBalance = 0;
  let walletUsed = 0;
  let finalTotal = pricing.total;

  if (userId) {
    const user = await UserModel.findById(userId).select("walletBalance");
    if (user && typeof user.walletBalance === "number" && user.walletBalance > 0) {
      walletBalance = user.walletBalance;
      
      // Wallet applies only to items after discount (not shipping)
      const netSubtotal = Math.max(0, pricing.subtotal - pricing.discountAmount);
      walletUsed = Math.min(walletBalance, netSubtotal);
      
      // Final total = (netSubtotal - walletUsed) + shipping
      const remainingSubtotal = netSubtotal - walletUsed;
      finalTotal = remainingSubtotal + (pricing.shippingFee - pricing.shippingDiscount);
    }
  }

  return {
    cartId: cartResponse.id,
    warehouseId: cartResponse.warehouseId,
    currency: cartResponse.currency || "EGP",
    deliveryAddress: cartResponse.deliveryAddress,
    items: cartResponse.items,
    pricing: {
      ...pricing,
      walletBalance,
      walletUsed,
      finalTotal,
    },
    coupon,
  };
}
