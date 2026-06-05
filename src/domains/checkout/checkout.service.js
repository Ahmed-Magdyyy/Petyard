import { ApiError } from "../../shared/utils/ApiError.js";
import { findCart } from "../cart/cart.repository.js";
import { getCartService } from "../cart/cart.service.js";
import { getWarehouseByIdService } from "../warehouse/warehouse.service.js";
import { validateAndApplyCoupon } from "../coupon/coupon.application.js";
import { ProductModel } from "../product/product.model.js";
import { UserModel } from "../user/user.model.js";
import { calculateLoyaltyPointsForOrder } from "../loyalty/loyalty.service.js";
import { FREE_SHIPPING_THRESHOLD } from "../../shared/constants/enums.js";

/**
 * Build the structures that validateAndApplyCoupon needs from cart items.
 * Fetches product brands in a single query.
 */
async function buildCouponContext(items) {
  const productIds = [
    ...new Set(
      items
        .map((it) => (it.productId ? String(it.productId) : null))
        .filter(Boolean),
    ),
  ];

  const products = await ProductModel.find({ _id: { $in: productIds } })
    .select("_id brand price discountedPrice variants")
    .lean();

  const productBrandMap = new Map(
    products.map((p) => [String(p._id), p.brand ? String(p.brand) : null]),
  );

  const productMap = new Map(
    products.map((p) => [String(p._id), p]),
  );

  const cartItems = items.map((it) => {
    const pid = it.productId ? String(it.productId) : null;
    const product = pid ? productMap.get(pid) : null;

    // Detect admin-set discounted price
    let hasAdminDiscount = false;
    if (product) {
      if (it.variantId) {
        const variant = Array.isArray(product.variants)
          ? product.variants.find((v) => String(v._id) === String(it.variantId))
          : null;
        if (
          variant &&
          typeof variant.discountedPrice === "number" &&
          variant.discountedPrice > 0 &&
          variant.discountedPrice < variant.price
        ) {
          hasAdminDiscount = true;
        }
      } else {
        if (
          typeof product.discountedPrice === "number" &&
          product.discountedPrice > 0 &&
          product.discountedPrice < product.price
        ) {
          hasAdminDiscount = true;
        }
      }
    }

    return {
      product: it.productId,
      lineTotal:
        typeof it.lineTotal === "number" && it.lineTotal > 0
          ? it.lineTotal
          : 0,
      hasDiscount: !!it.promotion || hasAdminDiscount,
    };
  });

  return { cartItems, productBrandMap };
}

/**
 * Build coupon summary object for API response.
 * Shape is identical to the old inline construction.
 */
function buildCouponSummary(couponDoc) {
  return {
    id: couponDoc._id,
    code: couponDoc.code,
    discountType: couponDoc.discountType || null,
    discountValue:
      typeof couponDoc.discountValue === "number"
        ? couponDoc.discountValue
        : null,
    maxDiscountAmount:
      typeof couponDoc.maxDiscountAmount === "number"
        ? couponDoc.maxDiscountAmount
        : null,
    freeShipping: !!couponDoc.freeShipping,
    minOrderTotal:
      typeof couponDoc.minOrderTotal === "number"
        ? couponDoc.minOrderTotal
        : null,
    maxOrderTotal:
      typeof couponDoc.maxOrderTotal === "number"
        ? couponDoc.maxOrderTotal
        : null,
  };
}

export async function applyCouponAtCheckoutService({
  userId,
  guestId,
  couponCode,
  lang = "en",
}) {
  if (!couponCode || typeof couponCode !== "string" || !couponCode.trim()) {
    throw new ApiError(
      lang === "en" ? "couponCode is required" : "كود الكوبون مطلوب",
      400,
    );
  }

  if (!userId && !guestId) {
    throw new ApiError("Either userId or guestId must be provided", 400);
  }

  const filter = userId ? { user: userId } : { guestId };

  const baseCart = await findCart(filter).select("_id warehouse");

  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  const warehouseId = baseCart.warehouse;
  if (!warehouseId) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

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
    throw new ApiError(
      lang === "en"
        ? "Cart total must be greater than 0"
        : "إجمالي السلة يجب أن يكون أكبر من 0",
      400,
    );
  }

  const warehouse = await getWarehouseByIdService(warehouseId);
  const rawShipping = warehouse?.defaultShippingPrice;
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
  // Free shipping for orders with items subtotal >= threshold
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : baseShippingFee;

  // Build coupon context (product brands + cart items with promo flags)
  const { cartItems, productBrandMap } = await buildCouponContext(items);

  const couponResult = await validateAndApplyCoupon({
    couponCode,
    userId,
    cartItems,
    productBrandMap,
    subtotal,
    shippingFee,
    lang,
  });

  const couponSummary = buildCouponSummary(couponResult.couponDoc);

  return {
    cartId: cart.id,
    warehouseId,
    currency: cart.currency || "EGP",
    coupon: couponSummary,
    pricing: {
      subtotal,
      shippingBefore: shippingFee,
      discountAmount: couponResult.discountAmount,
      shippingDiscount: couponResult.shippingDiscount,
      shippingAfter: shippingFee - couponResult.shippingDiscount,
      totalDiscount: couponResult.totalDiscount,
      finalSubtotal: subtotal - couponResult.discountAmount,
      finalTotal: couponResult.total,
    },
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

  const baseCart = await findCart(identityFilter).select("_id warehouse items");

  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  if (!baseCart.warehouse) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

  if (baseCart.items.length === 0) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
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
    throw new ApiError(
      lang === "en"
        ? "Cart total must be greater than 0"
        : "إجمالي السلة يجب أن يكون أكبر من 0",
      400,
    );
  }

  const warehouse = await getWarehouseByIdService(warehouseId);
  const rawShipping = warehouse?.defaultShippingPrice;
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
  // Free shipping for orders with items subtotal >= threshold
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : baseShippingFee;

  const trimmedCode =
    typeof couponCode === "string" && couponCode.trim()
      ? couponCode.trim()
      : null;

  let coupon = null;
  let pricing;

  const items = Array.isArray(cartResponse.items) ? cartResponse.items : [];

  if (trimmedCode) {
    // Build coupon context (product brands + cart items with promo flags)
    const { cartItems, productBrandMap } = await buildCouponContext(items);

    const couponResult = await validateAndApplyCoupon({
      couponCode: trimmedCode,
      userId,
      cartItems,
      productBrandMap,
      subtotal,
      shippingFee,
      lang,
    });

    coupon = buildCouponSummary(couponResult.couponDoc);

    pricing = {
      subtotal,
      shippingFee,
      discountAmount: couponResult.discountAmount,
      shippingDiscount: couponResult.shippingDiscount,
      totalDiscount: couponResult.totalDiscount,
      total: couponResult.total,
    };
  } else {
    pricing = {
      subtotal,
      shippingFee,
      discountAmount: 0,
      shippingDiscount: 0,
      totalDiscount: 0,
      total: subtotal + shippingFee,
    };
  }

  // Calculate wallet deduction and loyalty points for authenticated users
  let walletBalance = 0;
  let walletUsed = 0;
  let finalTotal = pricing.total;
  let estimatedLoyaltyPoints = 0;

  if (userId) {
    // Calculate net subtotal for wallet and loyalty points
    const netSubtotal = Math.max(0, pricing.subtotal - pricing.discountAmount);

    const user = await UserModel.findById(userId).select("walletBalance");
    if (
      user &&
      typeof user.walletBalance === "number" &&
      user.walletBalance > 0
    ) {
      walletBalance = user.walletBalance;

      // Wallet applies only to items after discount (not shipping)
      walletUsed = Math.min(walletBalance, netSubtotal);

      // Final total = (netSubtotal - walletUsed) + shipping
      const remainingSubtotal = netSubtotal - walletUsed;
      finalTotal =
        remainingSubtotal + (pricing.shippingFee - pricing.shippingDiscount);
    }

    // Calculate estimated loyalty points (awarded on delivery)
    // Points on items only (subtotal - discounts), excluding shipping
    estimatedLoyaltyPoints = await calculateLoyaltyPointsForOrder(netSubtotal);
  }

  // Validate delivery address completeness before returning summary
  const addr = cartResponse.deliveryAddress;
  if (!addr) {
    throw new ApiError(
      lang === "en"
        ? "Delivery address is not set for this cart"
        : "لم يتم تعيين عنوان التوصيل لهذا السلة",
      400,
    );
  }
  const requiredFields = [
    "name",
    "governorate",
    "phone",
    "building",
    "floor",
    "apartment",
    "details",
  ];
  const missingFields = requiredFields.filter((f) => !addr[f]);
  if (missingFields.length > 0) {
    throw new ApiError(
      lang === "en"
        ? `Delivery address is missing required fields: ${missingFields.join(", ")}`
        : `عنوان التوصيل يفتقد الحقول المطلوبة: ${missingFields.join(", ")}`,
      400,
    );
  }
  if (
    !addr.location ||
    typeof addr.location.lat !== "number" ||
    typeof addr.location.lng !== "number"
  ) {
    throw new ApiError(
      lang === "en"
        ? "Delivery address is missing location (lat, lng)"
        : "عنوان التوصيل يفتقد الموقع",
      400,
    );
  }

  return {
    cartId: cartResponse.id,
    warehouseId: cartResponse.warehouseId,
    currency: cartResponse.currency || "EGP",
    deliveryAddress: addr,
    items: cartResponse.items,
    pricing: {
      ...pricing,
      walletBalance,
      walletUsed,
      finalTotal,
      loyaltyPoints: estimatedLoyaltyPoints,
    },
    coupon,
  };
}
