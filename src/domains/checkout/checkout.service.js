import { ApiError } from "../../shared/utils/ApiError.js";
import { findCart } from "../cart/cart.repository.js";
import { getCartService } from "../cart/cart.service.js";
import { getWarehouseByIdService } from "../warehouse/warehouse.service.js";
import { validateAndApplyCoupon } from "../coupon/coupon.application.js";
import { ProductModel } from "../product/product.model.js";
import { UserModel } from "../user/user.model.js";
import { calculateLoyaltyPointsForOrder } from "../loyalty/loyalty.service.js";
import { isPrimeLocation as qualifiesForPrime, selectShippingPrice } from "../warehouse/warehouse.delivery.js";
import { calculateCheckoutShipping, applyWalletToMerchandise } from "./checkout.calculations.js";
import { assertOrdinaryCart } from "../cart/cart.bundle-compatibility.js";

const hasSavedBundles = cart => cart?.bundles !== undefined && (!Array.isArray(cart.bundles) || cart.bundles.length > 0);
function checkoutWarehouse(cart, userId, selectedWarehouseId) {
  if (!hasSavedBundles(cart)) return cart.warehouse;
  if (!userId || process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") assertOrdinaryCart(cart);
  if (typeof selectedWarehouseId !== "string" || !/^[a-f\d]{24}$/i.test(selectedWarehouseId)) {
    throw new ApiError("The current selected warehouseId is required for bundle checkout pricing", 400);
  }
  return selectedWarehouseId;
}
function requireCurrentBundlePricing(cart) {
  if (cart.bundles?.length && cart.pricingStatus !== "ready") {
    throw new ApiError("Cart contents or the selected warehouse changed. Refresh the cart before checkout.", 409);
  }
}

export function validateCheckoutDeliveryAddress(addr, lang = "en") {
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
}

/**
 * Build the structures that validateAndApplyCoupon needs from cart items.
 * Fetches product brands in a single query.
 */
export async function buildCouponContext(items, { session } = {}) {
  const productIds = [
    ...new Set(
      items
        .map((it) => (it.productId ? String(it.productId) : null))
        .filter(Boolean),
    ),
  ];

  let query = ProductModel.find({ _id: { $in: productIds } })
    .select("_id brand price discountedPrice variants");
  if (session) query = query.session(session);
  const products = await query.lean();

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
    let basePrice = 0;
    if (product) {
      if (it.variantId) {
        const variant = Array.isArray(product.variants)
          ? product.variants.find((v) => String(v._id) === String(it.variantId))
          : null;
        if (variant) {
          basePrice = typeof variant.price === "number" ? variant.price : 0;
          if (
            typeof variant.discountedPrice === "number" &&
            variant.discountedPrice > 0 &&
            variant.discountedPrice < variant.price
          ) {
            hasAdminDiscount = true;
          }
        }
      } else {
        basePrice = typeof product.price === "number" ? product.price : 0;
        if (
          typeof product.discountedPrice === "number" &&
          product.discountedPrice > 0 &&
          product.discountedPrice < product.price
        ) {
          hasAdminDiscount = true;
        }
      }
    }

    // Catch-all: if the item is sold below its base price for ANY reason
    // (admin discount, collection promotion, or otherwise), flag it.
    const itemPrice = typeof it.itemPrice === "number" ? it.itemPrice : 0;
    const sellingBelowBase = basePrice > 0 && itemPrice > 0 && itemPrice < basePrice;

    return {
      product: it.productId,
      lineTotal:
        typeof it.lineTotal === "number" && it.lineTotal > 0
          ? it.lineTotal
          : 0,
      hasDiscount: !!it.promotion || hasAdminDiscount || sellingBelowBase,
    };
  });

  return { cartItems, productBrandMap };
}

/**
 * Build coupon summary object for API response.
 * Shape is identical to the old inline construction.
 */
export function buildCouponSummary(couponDoc) {
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
  warehouseId: selectedWarehouseId,
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

  const baseCart = await findCart(filter).select("_id warehouse bundles");

  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  let warehouseId = baseCart.warehouse;
  if (!warehouseId) {
    throw new ApiError("Cart warehouse is not set", 400);
  }
  warehouseId = checkoutWarehouse(baseCart, userId, selectedWarehouseId);

  const cart = await getCartService({
    userId: userId || null,
    guestId: guestId || null,
    warehouseId,
    lang,
  });

  warehouseId = cart.warehouseId;
  requireCurrentBundlePricing(cart);

  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length && !cart.bundles?.length) {
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
  const isPrimeLocation = cart.isPrimeLocation === true && qualifiesForPrime({
    zoneWarehouse: warehouse,
    effectiveWarehouse: warehouse,
    location: cart.deliveryAddress?.location,
  });
  const rawShipping = selectShippingPrice(warehouse, isPrimeLocation);
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
  const shippingFee = calculateCheckoutShipping(subtotal, baseShippingFee);

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
    isPrimeLocation,
    warehouseId,
    currency: cart.currency || "EGP",
    coupon: couponSummary,
    ...(cart.bundles?.length ? { checkoutSupported: cart.checkoutSupported === true } : {}),
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
  warehouseId: selectedWarehouseId,
  lang = "en",
}) {
  if (!userId && !guestId) {
    throw new ApiError("Either userId or guestId must be provided", 400);
  }

  const identityFilter = userId ? { user: userId } : { guestId };

  const baseCart = await findCart(identityFilter).select("_id warehouse items bundles");

  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  if (!baseCart.warehouse) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

  if (baseCart.items.length === 0 && !hasSavedBundles(baseCart)) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
  }

  let warehouseId = checkoutWarehouse(baseCart, userId, selectedWarehouseId);

  const cartResponse = await getCartService({
    userId: userId || null,
    guestId: guestId || null,
    warehouseId,
    lang,
  });

  warehouseId = cartResponse.warehouseId;
  requireCurrentBundlePricing(cartResponse);

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
  const isPrimeLocation = cartResponse.isPrimeLocation === true && qualifiesForPrime({
    zoneWarehouse: warehouse,
    effectiveWarehouse: warehouse,
    location: cartResponse.deliveryAddress?.location,
  });
  const rawShipping = selectShippingPrice(warehouse, isPrimeLocation);
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
  const shippingFee = calculateCheckoutShipping(subtotal, baseShippingFee);

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

      const wallet = applyWalletToMerchandise(netSubtotal, walletBalance);
      walletUsed = wallet.walletUsed;
      finalTotal =
        wallet.remainingSubtotal + (pricing.shippingFee - pricing.shippingDiscount);
    }

    // Calculate estimated loyalty points (awarded on delivery)
    // Points on items only (subtotal - discounts), excluding shipping
    estimatedLoyaltyPoints = await calculateLoyaltyPointsForOrder(netSubtotal);
  }

  // Validate delivery address completeness before returning summary
  const addr = cartResponse.deliveryAddress;
  validateCheckoutDeliveryAddress(addr, lang);

  return {
    cartId: cartResponse.id,
    isPrimeLocation,
    warehouseId: cartResponse.warehouseId,
    currency: cartResponse.currency || "EGP",
    deliveryAddress: addr,
    items: cartResponse.items,
    ...(cartResponse.bundles?.length ? { bundles: cartResponse.bundles, checkoutSupported: cartResponse.checkoutSupported === true } : {}),
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
