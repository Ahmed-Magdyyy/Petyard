import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { OrderModel } from "./order.model.js";
import { CartModel } from "../cart/cart.model.js";
import { ProductModel } from "../product/product.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { CouponModel } from "../coupon/coupon.model.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import {
  orderStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
} from "../../shared/constants/enums.js";
import { deleteCacheKey } from "../../shared/utils/cache.js";
import {
  findActiveCouponByCodeService,
  computeCouponEffect,
} from "../coupon/coupon.service.js";
import { sendOrderStatusChangedNotification } from "../notification/notification.service.js";
import { dispatchNotification } from "../notification/notificationDispatcher.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import {
  calculateLoyaltyPointsForOrder,
  deductLoyaltyPointsOnReturnService,
} from "../loyalty/loyalty.service.js";
import { LoyaltyTransactionModel } from "../loyalty/loyaltyTransaction.model.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import {
  autoHideExpiredCollections,
  findActivePromotionForProduct,
} from "../collection/collection.promotion.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";
import {
  createPaymentIntention,
  getPublicKey,
} from "../payment/paymob.service.js";
import { getSavedCardTokenService } from "../payment/savedCard.service.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function normalizePaymentMethod(method) {
  if (!method) return paymentMethodEnum.COD;
  const v = String(method).trim().toLowerCase();
  if (v === paymentMethodEnum.CARD) return paymentMethodEnum.CARD;
  return paymentMethodEnum.COD;
}

function generateOrderNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePart = `${y}${m}${d}`;

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid confusing chars
  let random = "";
  for (let i = 0; i < 8; i += 1) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }

  return `PY-${datePart}-${random}`;
}

async function invalidateProductCaches(productIds) {
  const uniqueIds = [
    ...new Set(
      (productIds || []).map((id) => (id ? String(id) : null)).filter(Boolean),
    ),
  ];

  if (!uniqueIds.length) return;

  await Promise.all(
    uniqueIds.flatMap((id) => [
      deleteCacheKey(`product:${id}:en`),
      deleteCacheKey(`product:${id}:ar`),
    ]),
  );
}

const allowedStatusTransitions = {
  [orderStatusEnum.AWAITING_PAYMENT]: [
    orderStatusEnum.PENDING,
    orderStatusEnum.CANCELLED,
  ],
  [orderStatusEnum.PENDING]: [
    orderStatusEnum.ACCEPTED,
    orderStatusEnum.CANCELLED,
  ],
  [orderStatusEnum.ACCEPTED]: [
    orderStatusEnum.SHIPPED,
    orderStatusEnum.CANCELLED,
  ],
  [orderStatusEnum.SHIPPED]: [
    orderStatusEnum.DELIVERED,
    orderStatusEnum.CANCELLED,
  ],
  [orderStatusEnum.DELIVERED]: [],
  [orderStatusEnum.CANCELLED]: [],
};

function isValidStatusTransition(oldStatus, newStatus) {
  const next = allowedStatusTransitions[oldStatus];
  if (!Array.isArray(next)) return false;
  return next.includes(newStatus);
}

function mapCartItemToOrderItem(item) {
  const quantity =
    typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 0;
  const itemPrice =
    typeof item.itemPrice === "number" && item.itemPrice >= 0
      ? item.itemPrice
      : 0;

  const variantOptions = Array.isArray(item.variantOptionsSnapshot)
    ? item.variantOptionsSnapshot.map((o) => ({
        name: typeof o.name === "string" ? o.name : "",
        value: typeof o.value === "string" ? o.value : "",
      }))
    : [];

  return {
    product: item.product,
    productType: item.productType,
    productName: item.productName || "",
    productImageUrl: item.productImageUrl || null,
    variantId: item.variantId || undefined,
    variantOptions,
    quantity,
    baseEffectivePrice:
      typeof item.baseEffectivePrice === "number"
        ? item.baseEffectivePrice
        : null,
    promotion: item.promotion || null,
    promotionDiscountedPrice:
      typeof item.promotionDiscountedPrice === "number"
        ? item.promotionDiscountedPrice
        : null,
    itemPrice,
    lineTotal: quantity * itemPrice,
  };
}

async function buildOrderItemsWithPromotions({ session, cart, lang = "en" }) {
  await autoHideExpiredCollections();

  const items = Array.isArray(cart.items) ? cart.items : [];
  if (items.length === 0 || items.length < 1 || !items.length || !items) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  const products = await ProductModel.find({ _id: { $in: productIds } })
    .session(session)
    .select("_id type price discountedPrice subcategory brand variants images");

  const productById = new Map(products.map((p) => [String(p._id), p]));
  const promotionByProductId = new Map();
  const now = new Date();

  async function getPromotionForProduct(product) {
    const pid = product?._id ? String(product._id) : null;
    if (!pid) return null;
    if (promotionByProductId.has(pid)) {
      return promotionByProductId.get(pid);
    }
    const promotion = await findActivePromotionForProduct(
      {
        productId: product._id,
        subcategoryId: product.subcategory,
        brandId: product.brand,
      },
      now,
    );
    promotionByProductId.set(pid, promotion || null);
    return promotion || null;
  }

  let subtotal = 0;
  let hasPromotionalItems = false;

  const orderItems = [];

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) {
      throw new ApiError(
        lang === "en" ? "Product no longer exists" : "المنتج غير موجود",
        400,
      );
    }

    if (product.type !== item.productType) {
      throw new ApiError(
        lang === "en"
          ? "Product type mismatch for cart item"
          : "نوع المنتج غير صحيح",
        400,
      );
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "Cart item quantity must be greater than 0"
          : "العدد فى السلة يجب ان يكون اكبر من 0",
        400,
      );
    }

    const promotion = await getPromotionForProduct(product);
    const promoPercent =
      promotion && typeof promotion.discountPercent === "number"
        ? promotion.discountPercent
        : null;

    let basePrice = 0;
    let baseDiscounted = null;

    if (product.type === "SIMPLE") {
      basePrice = typeof product.price === "number" ? product.price : 0;
      baseDiscounted =
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : null;
    } else {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId),
      );
      if (!variant) {
        throw new ApiError(
          lang === "en"
            ? "Variant not found on this product"
            : "المتغير غير موجود فى هذا المنتج",
          404,
        );
      }
      basePrice = typeof variant.price === "number" ? variant.price : 0;
      baseDiscounted =
        typeof variant.discountedPrice === "number"
          ? variant.discountedPrice
          : null;
    }

    const pricing = computeFinalDiscountedPrice({
      price: basePrice,
      discountedPrice: baseDiscounted,
      promoPercent,
    });

    const baseEffectivePrice =
      typeof pricing.baseDiscountedPrice === "number"
        ? Math.min(pricing.basePrice, pricing.baseDiscountedPrice)
        : pricing.basePrice;

    const appliedPromotion = !!pricing.appliedPromotion;
    const promotionDiscountedPrice = appliedPromotion
      ? pricing.promoPrice
      : null;
    const itemPrice =
      typeof pricing.finalEffective === "number" ? pricing.finalEffective : 0;

    if (appliedPromotion) {
      hasPromotionalItems = true;
    }

    const lineTotal = quantity * itemPrice;
    subtotal += lineTotal;

    orderItems.push(
      mapCartItemToOrderItem({
        product: item.product,
        productType: item.productType,
        productName: item.productName || "",
        productImageUrl: item.productImageUrl || null,
        variantId: item.variantId || undefined,
        variantOptionsSnapshot: item.variantOptionsSnapshot,
        quantity,
        baseEffectivePrice,
        promotion: appliedPromotion ? promotion || null : null,
        promotionDiscountedPrice,
        itemPrice,
      }),
    );
  }

  return {
    orderItems,
    subtotal: typeof subtotal === "number" && subtotal > 0 ? subtotal : 0,
    hasPromotionalItems,
  };
}

function mapCartDeliveryAddressToOrder(cart, user) {
  if (!cart.deliveryAddress) return undefined;

  const src = cart.deliveryAddress;

  return {
    userAddressId: src.userAddressId || undefined,
    label: src.label || undefined,
    name: src.name || (user && user.name) || undefined,
    governorate: src.governorate || undefined,
    area: src.area || undefined,
    phone: src.phone || (user && user.phone) || undefined,
    building: src.building || undefined,
    floor: src.floor || undefined,
    apartment: src.apartment || undefined,
    location: src.location
      ? {
          lat: src.location.lat,
          lng: src.location.lng,
        }
      : undefined,
    details: src.details || undefined,
  };
}

async function validateStockReadOnly({ session, cart, lang = "en" }) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  const products = await ProductModel.find({
    _id: { $in: productIds },
  }).session(session);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) {
      throw new ApiError(
        lang === "en" ? "Product no longer exists" : "المنتج غير موجود",
        400,
      );
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (quantity <= 0) continue;

    if (product.type === "SIMPLE") {
      const stocks = Array.isArray(product.warehouseStocks)
        ? product.warehouseStocks
        : [];
      const stock = stocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse),
      );
      if (
        !stock ||
        typeof stock.quantity !== "number" ||
        stock.quantity < quantity
      ) {
        throw new ApiError(
          lang === "en"
            ? `Insufficient stock for ${item.productName || "a product"}`
            : "المخزون غير كافٍ",
          400,
        );
      }
    } else {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId),
      );
      if (!variant) {
        throw new ApiError(
          lang === "en"
            ? "Variant not found on this product"
            : "المتغير غير موجود فى هذا المنتج",
          404,
        );
      }
      const vStocks = Array.isArray(variant.warehouseStocks)
        ? variant.warehouseStocks
        : [];
      const vStock = vStocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse),
      );
      if (
        !vStock ||
        typeof vStock.quantity !== "number" ||
        vStock.quantity < quantity
      ) {
        throw new ApiError(
          lang === "en"
            ? `Insufficient stock for ${item.productName || "a product"}`
            : "المخزون غير كافٍ",
          400,
        );
      }
    }
  }
}

async function ensureSufficientStockAndDecrement({
  session,
  cart,
  lang = "en",
}) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  const products = await ProductModel.find({
    _id: { $in: productIds },
  }).session(session);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) {
      throw new ApiError(
        lang === "en" ? "Product no longer exists" : "المنتج غير موجود",
        400,
      );
    }

    if (product.type !== item.productType) {
      throw new ApiError(
        lang === "en"
          ? "Product type mismatch for cart item"
          : "نوع المنتج غير صحيح",
        400,
      );
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "Cart item quantity must be greater than 0"
          : "العدد فى السلة يجب ان يكون اكبر من 0",
        400,
      );
    }

    if (product.type === "SIMPLE") {
      const stocks = Array.isArray(product.warehouseStocks)
        ? product.warehouseStocks
        : [];
      const stock = stocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse),
      );
      if (!stock || typeof stock.quantity !== "number") {
        throw new ApiError(
          lang === "en"
            ? "This product is not available in the selected warehouse"
            : "المنتج غير موجود فى هذا المخزن",
          400,
        );
      }
      if (stock.quantity < quantity) {
        throw new ApiError(
          lang === "en"
            ? `Requested quantity exceeds available stock (${stock.quantity})`
            : `الكمية المطلوبة تتجاوز عدد المخزون المتاح ${stock.quantity}`,
          400,
        );
      }
      stock.quantity -= quantity;
    } else {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId),
      );
      if (!variant) {
        throw new ApiError(
          lang === "en"
            ? "Variant not found on this product"
            : "المتغير غير موجود فى هذا المنتج",
          404,
        );
      }

      const vStocks = Array.isArray(variant.warehouseStocks)
        ? variant.warehouseStocks
        : [];
      const vStock = vStocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse),
      );

      if (!vStock || typeof vStock.quantity !== "number") {
        throw new ApiError(
          lang === "en"
            ? "This product variant is not available in the selected warehouse"
            : "المتغير غير موجود فى هذا المخزن",
          400,
        );
      }
      if (vStock.quantity < quantity) {
        throw new ApiError(
          lang === "en"
            ? `Requested quantity exceeds available stock (${vStock.quantity})`
            : `الكمية المطلوبة تتجاوز عدد المخزون المتاح ${vStock.quantity}`,
          400,
        );
      }
      vStock.quantity -= quantity;
    }
  }

  // Persist updated products
  for (const product of products) {
    await product.save({ session, validateBeforeSave: false });
  }
}

async function rebindOrdersLocalization(ordersOrOrder, lang = "en") {
  if (!ordersOrOrder) return ordersOrOrder;

  const orders = Array.isArray(ordersOrOrder) ? ordersOrOrder : [ordersOrOrder];
  if (!orders.length) return ordersOrOrder;

  const normalizedLang = normalizeLang(lang);

  const allItems = [];

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items) {
      if (!item.product) continue;
      allItems.push({
        order,
        item,
        productId: String(item.product),
      });
    }
  }

  if (!allItems.length) {
    return ordersOrOrder;
  }

  const productIds = [...new Set(allItems.map((entry) => entry.productId))];

  const products = await ProductModel.find({
    _id: { $in: productIds },
  });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const entry of allItems) {
    const product = productById.get(entry.productId);
    if (!product) continue;

    const localizedName = pickLocalizedField(product, "name", normalizedLang);
    entry.item.productName = localizedName;
  }

  return ordersOrOrder;
}

export async function restoreStockForOrder({ session, order }) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) {
    return;
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  if (!productIds.length) {
    return;
  }

  const products = await ProductModel.find({
    _id: { $in: productIds },
  }).session(session);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) {
      continue;
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (quantity <= 0) {
      continue;
    }

    if (product.type === "SIMPLE") {
      let stocks = product.warehouseStocks;
      if (!Array.isArray(stocks)) {
        stocks = [];
        product.warehouseStocks = stocks;
      }

      let stock = stocks.find(
        (ws) => String(ws.warehouse) === String(order.warehouse),
      );
      if (!stock) {
        stocks.push({
          warehouse: order.warehouse,
          quantity,
        });
      } else {
        stock.quantity += quantity;
      }
    } else {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId),
      );
      if (!variant) {
        continue;
      }

      let vStocks = variant.warehouseStocks;
      if (!Array.isArray(vStocks)) {
        vStocks = [];
        variant.warehouseStocks = vStocks;
      }

      let vStock = vStocks.find(
        (ws) => String(ws.warehouse) === String(order.warehouse),
      );
      if (!vStock) {
        vStocks.push({
          warehouse: order.warehouse,
          quantity,
        });
      } else {
        vStock.quantity += quantity;
      }
    }
  }

  for (const product of products) {
    await product.save({ session, validateBeforeSave: false });
  }
}

async function applyCouponIfAny({
  couponCode,
  userId,
  subtotal,
  shippingFee,
  lang = "en",
}) {
  if (!couponCode) {
    const total = subtotal + shippingFee;
    return {
      couponCode: null,
      discountAmount: 0,
      shippingDiscount: 0,
      totalDiscount: 0,
      total,
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

  const coupon = await findActiveCouponByCodeService(trimmedCode);

  const allowedUserIds = Array.isArray(coupon.allowedUserIds)
    ? coupon.allowedUserIds
    : [];

  if (allowedUserIds.length > 0) {
    if (!userId) {
      throw new ApiError(
        lang === "en"
          ? "This coupon is only available to specific users"
          : "هذا الكوبون متاح فقط لمستخدمين محددين",
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
        ? `This coupon can only be applied to orders up to ${coupon.maxOrderTotal}`
        : `هذا الكوبون يمكن تطبيقه فقط على الطلبات التي تصل إلى ${coupon.maxOrderTotal}`,
      400,
    );
  }

  if (
    typeof coupon.maxUsageTotal === "number" &&
    coupon.maxUsageTotal >= 0 &&
    typeof coupon.usageCount === "number" &&
    coupon.usageCount >= coupon.maxUsageTotal
  ) {
    throw new ApiError(
      lang === "en"
        ? "This coupon has reached its maximum usage limit"
        : "هذا الكوبون وصل إلى الحد الأقصى للاستخدام",
      400,
    );
  }

  if (userId && typeof coupon.maxUsagePerUser === "number") {
    if (coupon.maxUsagePerUser >= 0) {
      const userUsage = await OrderModel.countDocuments({
        user: userId,
        couponCode: coupon.code,
      });

      if (userUsage >= coupon.maxUsagePerUser) {
        throw new ApiError(
          lang === "en"
            ? "You have already used this coupon"
            : "لقد استخدمت هذا الكوبون بالفعل",
          400,
        );
      }
    }
  }

  const effect = computeCouponEffect(coupon, {
    orderSubtotal: subtotal,
    shippingFee,
  });

  return {
    couponCode: coupon.code,
    discountAmount: effect.discountAmount,
    shippingDiscount: effect.shippingDiscount,
    totalDiscount: effect.totalDiscount,
    total: effect.finalTotal,
  };
}

async function applyWalletIfUser({ session, userId, netSubtotal }) {
  if (!userId) {
    return { walletUsed: 0, finalSubtotal: netSubtotal };
  }

  if (netSubtotal <= 0) {
    return { walletUsed: 0, finalSubtotal: 0 };
  }

  const user = await UserModel.findById(userId)
    .session(session)
    .select("walletBalance");
  if (!user) {
    return { walletUsed: 0, finalSubtotal: netSubtotal };
  }

  const walletBalance =
    typeof user.walletBalance === "number" && user.walletBalance >= 0
      ? user.walletBalance
      : 0;

  const walletUsed = Math.min(walletBalance, netSubtotal);
  const finalSubtotal = netSubtotal - walletUsed;

  return { walletUsed, finalSubtotal };
}

async function processOrderCreationWithCart({
  session,
  cart,
  orderUserId,
  orderGuestId,
  couponCode,
  couponUserId,
  paymentMethod,
  notes,
  lang,
  addressUser,
  historyByUserId,
}) {
  const { orderItems, subtotal, hasPromotionalItems } =
    await buildOrderItemsWithPromotions({ session, cart, lang });

  if (cart.items.length === 0 || cart.items < 1) {
    throw new ApiError(lang === "en" ? "Cart is empty" : "السلة فارغة", 400);
  }

  if (!cart.warehouse) {
    throw new ApiError(
      lang === "en" ? "Cart warehouse is not set" : "لم يتم تحديد المخزن",
      400,
    );
  }

  if (subtotal <= 0) {
    throw new ApiError(
      lang === "en"
        ? "Cart total must be greater than 0"
        : "المجموع يجب أن يكون أكبر من 0",
      400,
    );
  }

  const warehouse = await WarehouseModel.findById(cart.warehouse).session(
    session,
  );
  if (!warehouse) {
    throw new ApiError(
      lang === "en"
        ? "Warehouse not found for this cart"
        : "المخزن غير موجود لهذا الطلب",
      404,
    );
  }

  const rawShipping = warehouse.defaultShippingPrice;
  const shippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

  if (couponCode && hasPromotionalItems) {
    throw new ApiError(
      lang === "en"
        ? "Coupons cannot be applied when the cart contains promotional items"
        : "لا يمكن تطبيق الكوبون عندما تحتوي السلة على عناصر ترويجية",
      400,
    );
  }

  const couponResult = await applyCouponIfAny({
    couponCode,
    userId: couponUserId,
    subtotal,
    shippingFee,
    lang,
  });

  const netSubtotal = Math.max(0, subtotal - couponResult.discountAmount);
  const netShipping = Math.max(0, shippingFee - couponResult.shippingDiscount);

  const walletResult = await applyWalletIfUser({
    session,
    userId: orderUserId,
    netSubtotal,
  });

  const finalTotal = walletResult.finalSubtotal + netShipping;

  const deliveryAddress = mapCartDeliveryAddressToOrder(cart, addressUser);
  if (!deliveryAddress) {
    throw new ApiError(
      lang === "en"
        ? "Delivery address is not set for this cart"
        : "لم يتم تحديد عنوان التوصيل لهذا الطلب",
      400,
    );
  }
  // Validate required address fields
  const requiredFields = [
    "name",
    "governorate",
    "phone",
    "building",
    "floor",
    "apartment",
    "details",
  ];
  const missingFields = requiredFields.filter((f) => !deliveryAddress[f]);
  if (missingFields.length > 0) {
    throw new ApiError(
      lang === "en"
        ? `Delivery address is missing required fields: ${missingFields.join(", ")}`
        : `عنوان التوصيل غير مكتمل البيانات برجاء اضافة: ${missingFields.join(", ")}`,
      400,
    );
  }
  if (
    !deliveryAddress.location ||
    typeof deliveryAddress.location.lat !== "number" ||
    typeof deliveryAddress.location.lng !== "number"
  ) {
    throw new ApiError(
      lang === "en"
        ? "Delivery address is missing location (lat, lng)"
        : "عنوان التوصيل ينقصه بيانات الموقع",
      400,
    );
  }

  const orderNumber = generateOrderNumber();
  const pm = normalizePaymentMethod(paymentMethod);
  const isCard = pm === paymentMethodEnum.CARD;

  // ── Stock: read-only check for card, decrement deferred to webhook ──
  if (isCard) {
    await validateStockReadOnly({ session, cart, lang });
  }

  const historyEntry = {
    at: new Date(),
    description: isCard ? "Order created — awaiting payment" : "Order created",
    byUserId: historyByUserId,
    visibleToUser: true,
  };

  const orderDoc = {
    user: orderUserId,
    guestId: orderGuestId,
    warehouse: cart.warehouse,
    orderNumber,
    currency: cart.currency || "EGP",
    deliveryAddress,
    items: orderItems,
    subtotal,
    shippingFee,
    discountAmount: couponResult.discountAmount,
    shippingDiscount: couponResult.shippingDiscount,
    totalDiscount: couponResult.totalDiscount,
    walletUsed: walletResult.walletUsed,
    total: finalTotal,
    couponCode: couponResult.couponCode,
    status: isCard ? orderStatusEnum.AWAITING_PAYMENT : orderStatusEnum.PENDING,
    paymentMethod: pm,
    paymentStatus: paymentStatusEnum.PENDING,
    sideEffectsCommitted: !isCard,
    history: [historyEntry],
    notes: notes || undefined,
  };

  // ── Card: create skeleton order only (no side effects) ──
  if (isCard) {
    const createdOrder = await OrderModel.create([orderDoc], { session }).then(
      (res) => res[0],
    );
    return createdOrder;
  }

  // ── COD: validate stock, apply all side effects immediately ──
  await ensureSufficientStockAndDecrement({ session, cart, lang });

  const createdOrder = await OrderModel.create([orderDoc], { session }).then(
    (res) => res[0],
  );

  if (walletResult.walletUsed > 0 && orderUserId) {
    const updateResult = await UserModel.updateOne(
      {
        _id: orderUserId,
        walletBalance: { $gte: walletResult.walletUsed },
      },
      { $inc: { walletBalance: -walletResult.walletUsed } },
      { session },
    );

    if (updateResult.matchedCount === 0) {
      throw new ApiError(
        lang === "en" ? "Insufficient wallet balance" : "رصيد المحفظة غير كافٍ",
        400,
      );
    }

    const userAfterDebit = await UserModel.findById(orderUserId)
      .session(session)
      .select("walletBalance");

    await WalletTransactionModel.create(
      [
        {
          user: orderUserId,
          amount: -walletResult.walletUsed,
          type: "ORDER_DEBIT",
          referenceType: "ORDER",
          referenceId: createdOrder._id,
          balanceAfter: userAfterDebit?.walletBalance ?? 0,
        },
      ],
      { session },
    );
  }

  if (couponResult.couponCode) {
    await CouponModel.updateOne(
      { code: couponResult.couponCode },
      { $inc: { usageCount: 1 } },
      { session },
    );
  }

  cart.items = [];
  cart.totalCartPrice = 0;
  cart.lastActivityAt = new Date();
  cart.status = "ACTIVE";
  await cart.save({ session });

  return createdOrder;
}

// ─── Card Payment Initialization ────────────────────────────────────────────

async function initializeCardPayment(order, savedCardToken = null) {
  const user = order.user
    ? await UserModel.findById(order.user).select("name email phone")
    : null;

  const amountCents = Math.round(order.total * 100);

  // Paymob requires sum(item.amount) === total amount exactly.
  // Shipping, discounts, and wallet make per-item amounts diverge from the total,
  // so we send a single consolidated line item to guarantee the match.
  const items = [
    {
      name: `Order ${order.orderNumber}`,
      amountCents,
      quantity: 1,
    },
  ];

  const billingData = {
    firstName:
      user?.name?.split(" ")[0] || order.deliveryAddress?.name || "N/A",
    lastName: user?.name?.split(" ").slice(1).join(" ") || "",
    email: user?.email || "na@na.com",
    phone: order.deliveryAddress?.phone || user?.phone || "N/A",
  };

  const intention = await createPaymentIntention({
    merchantOrderId: order.orderNumber,
    amountCents,
    currency: order.currency || "EGP",
    billingData,
    items,
    savedCardToken,
  });

  // Persist Paymob reference on the order (non-transactional, safe)
  await OrderModel.updateOne(
    { _id: order._id },
    { paymobOrderId: intention.paymobOrderId || null },
  );

  return {
    clientSecret: intention.clientSecret,
    publicKey: getPublicKey(),
  };
}

// ─── Order Creation ─────────────────────────────────────────────────────────

export async function createOrderForUserService({
  userId,
  couponCode,
  paymentMethod,
  notes,
  savedCardId,
  lang = "en",
}) {
  if (!userId) {
    throw new ApiError(
      lang === "en" ? "userId is required" : "معرف المستخدم مطلوب",
      400,
    );
  }

  const pm = normalizePaymentMethod(paymentMethod);

  // ── Card: check for concurrent pending payment ──
  if (pm === paymentMethodEnum.CARD) {
    const existingPending = await OrderModel.findOne({
      user: userId,
      status: orderStatusEnum.AWAITING_PAYMENT,
      sideEffectsCommitted: false,
    });
    if (existingPending) {
      const ageMs = Date.now() - existingPending.createdAt.getTime();
      const oneMinute = 60 * 1000;

      if (ageMs < oneMinute) {
        const remainingSec = Math.ceil((oneMinute - ageMs) / 1000);
        throw new ApiError(
          lang === "en"
            ? `You have a recent pending order. Please retry after ${remainingSec} seconds`
            : `لديك طلب معلق حديث. يرجى إعادة المحاولة بعد ${remainingSec} ثانية`,
          409,
        );
      }

      // Stale skeleton order — auto-cancel it so user can retry
      try {
        await failOrderPaymentService(existingPending._id);
        console.log(
          `[createOrder] Auto-cancelled stale skeleton order ${existingPending.orderNumber}`,
        );
      } catch (cancelErr) {
        console.error(
          `[createOrder] Failed to auto-cancel ${existingPending.orderNumber}:`,
          cancelErr.message,
        );
      }
    }
  }

  const session = await mongoose.startSession();
  let createdOrder = null;

  try {
    await session.withTransaction(async () => {
      const cart = await CartModel.findOne({ user: userId })
        .session(session)
        .populate("user", "name phone email");
      if (!cart) {
        throw new ApiError(
          lang === "en" ? "Cart not found" : "السلة غير موجودة",
          404,
        );
      }

      createdOrder = await processOrderCreationWithCart({
        session,
        cart,
        orderUserId: userId,
        orderGuestId: null,
        couponCode,
        couponUserId: userId,
        paymentMethod,
        notes,
        lang,
        addressUser: cart.user,
        historyByUserId: userId,
      });
    });
  } finally {
    session.endSession();
  }

  if (!createdOrder) return { order: null };

  // ── Card payment: initialize Paymob intention ──
  if (createdOrder.paymentMethod === paymentMethodEnum.CARD) {
    let savedCardToken = null;
    if (savedCardId) {
      savedCardToken = await getSavedCardTokenService(userId, savedCardId);
    }

    try {
      const payment = await initializeCardPayment(createdOrder, savedCardToken);
      return {
        order: createdOrder,
        action: "requires_payment",
        clientSecret: payment.clientSecret,
        publicKey: payment.publicKey,
      };
    } catch (err) {
      console.error("[Order] Card payment init failed:", err.message);
      // Skeleton order: no side effects to rollback, just cancel
      await OrderModel.updateOne(
        { _id: createdOrder._id },
        {
          status: orderStatusEnum.CANCELLED,
          paymentStatus: paymentStatusEnum.FAILED,
        },
      );
      throw new ApiError(
        lang === "en"
          ? "Payment initialization failed. Please try again."
          : "فشل تهيئة الدفع. يرجى المحاولة مرة أخرى.",
        502,
      );
    }
  }

  // ── COD: invalidate caches and send notification ──
  const productIds = Array.isArray(createdOrder.items)
    ? createdOrder.items.map((i) => i.product)
    : [];
  await invalidateProductCaches(productIds);

  sendOrderStatusChangedNotification(createdOrder).catch((err) =>
    console.error(
      "[Order] Failed to send order created notification:",
      err.message,
    ),
  );

  return { order: createdOrder };
}

export async function createOrderForGuestService({
  guestId,
  couponCode,
  paymentMethod,
  notes,
  lang = "en",
}) {
  if (!guestId) {
    throw new ApiError(
      lang === "en" ? "guestId is required" : "معرف الضيف مطلوب",
      400,
    );
  }

  const pm = normalizePaymentMethod(paymentMethod);

  // ── Card: check for concurrent pending payment ──
  if (pm === paymentMethodEnum.CARD) {
    const existingPending = await OrderModel.findOne({
      guestId,
      status: orderStatusEnum.AWAITING_PAYMENT,
      sideEffectsCommitted: false,
    });
    if (existingPending) {
      const ageMs = Date.now() - existingPending.createdAt.getTime();
      const twoMinutes = 2 * 60 * 1000;

      if (ageMs < twoMinutes) {
        throw new ApiError(
          lang === "en"
            ? "You already have a payment in progress"
            : "لديك عملية دفع قيد التنفيذ بالفعل",
          409,
        );
      }

      // Stale skeleton order — auto-cancel it so user can retry
      try {
        await failOrderPaymentService(existingPending._id);
        console.log(
          `[createOrder] Auto-cancelled stale guest skeleton order ${existingPending.orderNumber}`,
        );
      } catch (cancelErr) {
        console.error(
          `[createOrder] Failed to auto-cancel ${existingPending.orderNumber}:`,
          cancelErr.message,
        );
      }
    }
  }

  const session = await mongoose.startSession();
  let createdOrder = null;

  try {
    await session.withTransaction(async () => {
      const cart = await CartModel.findOne({ guestId })
        .session(session)
        .populate("user");

      if (!cart) {
        throw new ApiError(
          lang === "en" ? "Cart not found" : "السلة غير موجودة",
          404,
        );
      }

      createdOrder = await processOrderCreationWithCart({
        session,
        cart,
        orderUserId: null,
        orderGuestId: guestId,
        couponCode,
        couponUserId: null,
        paymentMethod,
        notes,
        lang,
        addressUser: null,
        historyByUserId: undefined,
      });
    });
  } finally {
    session.endSession();
  }

  if (!createdOrder) return { order: null };

  // ── Card payment: initialize Paymob intention (no saved cards for guests) ──
  if (createdOrder.paymentMethod === paymentMethodEnum.CARD) {
    try {
      const payment = await initializeCardPayment(createdOrder);
      return {
        order: createdOrder,
        action: "requires_payment",
        clientSecret: payment.clientSecret,
        publicKey: payment.publicKey,
      };
    } catch (err) {
      console.error("[Order] Guest card payment init failed:", err.message);
      await OrderModel.updateOne(
        { _id: createdOrder._id },
        {
          status: orderStatusEnum.CANCELLED,
          paymentStatus: paymentStatusEnum.FAILED,
        },
      );
      throw new ApiError(
        lang === "en"
          ? "Payment initialization failed. Please try again."
          : "فشل تهيئة الدفع. يرجى المحاولة مرة أخرى.",
        502,
      );
    }
  }

  // ── COD: invalidate caches ──
  const productIds = Array.isArray(createdOrder.items)
    ? createdOrder.items.map((i) => i.product)
    : [];
  await invalidateProductCaches(productIds);

  return { order: createdOrder };
}

export async function getMyOrdersService({ userId, page, limit, lang = "en" }) {
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (pageNum - 1) * limitNum;

  const filter = { user: userId };

  const totalCount = await OrderModel.countDocuments(filter);
  const orders = await OrderModel.find(filter)
    .select("-guestId -sideEffectsCommitted")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate({ path: "history.byUserId", select: "name role" })
    .lean();

  await rebindOrdersLocalization(orders, lang);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: orders.length,
    data: orders,
  };
}

export async function getMyOrderByIdService({ userId, orderId, lang = "en" }) {
  const order = await OrderModel.findById(orderId)
    .select("-guestId -sideEffectsCommitted")
    .populate({
      path: "history.byUserId",
      select: "role name",
    })
    .lean();
  if (!order || String(order.user) !== String(userId)) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }
  await rebindOrdersLocalization(order, lang);
  return order;
}

export async function getGuestOrdersService({
  guestId,
  page,
  limit,
  lang = "en",
}) {
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (pageNum - 1) * limitNum;

  const filter = { guestId };

  const totalCount = await OrderModel.countDocuments(filter);
  const orders = await OrderModel.find(filter)
    .select("-user -sideEffectsCommitted")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate({ path: "history.byUserId", select: "name role" })
    .lean();

  await rebindOrdersLocalization(orders, lang);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: orders.length,
    data: orders,
  };
}

export async function getGuestOrderByIdService({
  guestId,
  orderId,
  lang = "en",
}) {
  const order = await OrderModel.findById(orderId)
    .select("-user -sideEffectsCommitted")
    .populate({
      path: "history.byUserId",
      select: "role name",
    })
    .lean();
  if (!order || order.guestId !== guestId) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }
  await rebindOrdersLocalization(order, lang);
  return order;
}

export async function listOrdersForAdminService(query = {}) {
  const {
    page,
    limit,
    sort,
    status,
    orderNumber,
    warehouse,
    user,
    guestId,
    from,
    to,
    q,
    warehouseScope,
    lang = "en",
    ...rest
  } = query;

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);
  const sortOrder = buildSort({ sort }, "-createdAt");

  const filter = {};

  const hasWarehouseScope = Array.isArray(warehouseScope);
  if (hasWarehouseScope && warehouseScope.length === 0) {
    return {
      totalPages: 1,
      page: pageNum,
      results: 0,
      data: [],
    };
  }

  if (status) {
    const v = String(status).trim().toLowerCase();
    if (Object.values(orderStatusEnum).includes(v)) {
      filter.status = v;
    }
  }

  if (orderNumber) {
    filter.orderNumber = orderNumber;
  }

  if (warehouse) {
    if (hasWarehouseScope) {
      const allowed = warehouseScope.some(
        (w) => String(w) === String(warehouse),
      );
      if (!allowed) {
        throw new ApiError(
          lang === "en"
            ? "You are not allowed to access this route"
            : "غير مسموح لك",
          403,
        );
      }
    }
    filter.warehouse = warehouse;
  } else if (hasWarehouseScope) {
    filter.warehouse = { $in: warehouseScope };
  }

  if (user) {
    filter.user = user;
  }

  if (guestId) {
    filter.guestId = guestId;
  }

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const extraFilter = buildRegexFilter(rest, []);
  Object.assign(filter, extraFilter);

  if (typeof q === "string" && q.trim()) {
    const regex = { $regex: q.trim(), $options: "i" };

    const orConditions = [
      { "items.productName": regex },
      { "deliveryAddress.name": regex },
      { "deliveryAddress.phone": regex },
      { "deliveryAddress.governorate": regex },
      { "deliveryAddress.area": regex },
      { orderNumber: regex },
      { couponCode: regex },
      { status: regex },
      { paymentMethod: regex },
      { paymentStatus: regex },
    ];

    const matchedUsers = await UserModel.find({
      $or: [{ name: regex }, { phone: regex }],
    })
      .select("_id")
      .lean();

    if (matchedUsers.length > 0) {
      orConditions.push({ user: { $in: matchedUsers.map((u) => u._id) } });
    }

    const matchedWarehouses = await WarehouseModel.find({ name: regex })
      .select("_id")
      .lean();

    if (matchedWarehouses.length > 0) {
      orConditions.push({
        warehouse: { $in: matchedWarehouses.map((w) => w._id) },
      });
    }

    if (filter.$or) {
      if (!filter.$and) filter.$and = [];
      filter.$and.push({ $or: filter.$or }, { $or: orConditions });
      delete filter.$or;
    } else {
      filter.$or = orConditions;
    }
  }

  const [totalCount, orders] = await Promise.all([
    OrderModel.countDocuments(filter),
    OrderModel.find(filter)
      .sort(sortOrder)
      .skip(skip)
      .limit(limitNum)
      .populate({ path: "user", select: "name phone" })
      .populate({ path: "warehouse", select: "name" })
      .populate({ path: "history.byUserId", select: "name role" })
      .lean(),
  ]);

  await rebindOrdersLocalization(orders, lang);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: orders.length,
    data: orders,
  };
}

export async function getOrderByIdForAdminService(
  orderId,
  lang = "en",
  warehouseScope,
) {
  const order = await OrderModel.findById(orderId)
    .populate({ path: "user", select: "name phone" })
    .populate({
      path: "warehouse",
      select: "name phone governorate location.coordinates address",
    })
    .populate({
      path: "history.byUserId",
      select: "name role",
    })
    .lean();
  if (!order) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }

  if (Array.isArray(warehouseScope)) {
    const allowed = warehouseScope.some(
      (w) => String(w) === String(order.warehouse),
    );
    if (!allowed) {
      throw new ApiError(
        lang === "en" ? "Order not found" : "الطلب غير موجود",
        404,
      );
    }
  }

  await rebindOrdersLocalization(order, lang);
  return order;
}

export async function updateOrderStatusService({
  orderId,
  newStatus,
  actorUserId,
  warehouseScope,
  lang = "en",
}) {
  const allowed = Object.values(orderStatusEnum);
  if (!allowed.includes(newStatus)) {
    throw new ApiError(
      lang === "en" ? "Invalid order status" : "حالة طلب غير صحيحة",
      400,
    );
  }

  const session = await mongoose.startSession();
  let updated;

  try {
    await session.withTransaction(async () => {
      const order = await OrderModel.findById(orderId).session(session);
      if (!order) {
        throw new ApiError(
          lang === "en" ? "Order not found" : "الطلب غير موجود",
          404,
        );
      }

      if (Array.isArray(warehouseScope)) {
        const allowedWarehouse = warehouseScope.some(
          (w) => String(w) === String(order.warehouse),
        );
        if (!allowedWarehouse) {
          throw new ApiError(
            lang === "en" ? "Order not found" : "الطلب غير موجود",
            404,
          );
        }
      }

      const oldStatus = order.status;
      if (oldStatus === newStatus) {
        updated = order;
        return;
      }

      if (!isValidStatusTransition(oldStatus, newStatus)) {
        throw new ApiError(
          lang === "en"
            ? `Invalid status transition from ${oldStatus} to ${newStatus}`
            : `لا يمكن تغيير حالة الطلب الى الحالة المطلوبة`,
          400,
        );
      }

      const isCancelling =
        newStatus === orderStatusEnum.CANCELLED &&
        oldStatus !== orderStatusEnum.CANCELLED;

      // Only restore stock/wallet if side effects were committed
      const shouldRestoreStock =
        isCancelling && order.sideEffectsCommitted !== false;

      if (shouldRestoreStock) {
        await restoreStockForOrder({ session, order });
      }

      const shouldRefundWallet =
        isCancelling &&
        order.sideEffectsCommitted !== false &&
        order.user &&
        typeof order.walletUsed === "number" &&
        order.walletUsed > 0;

      if (shouldRefundWallet) {
        await UserModel.updateOne(
          { _id: order.user },
          { $inc: { walletBalance: order.walletUsed } },
          { session },
        );

        const userAfterRefund = await UserModel.findById(order.user)
          .session(session)
          .select("walletBalance");

        await WalletTransactionModel.create(
          [
            {
              user: order.user,
              amount: order.walletUsed,
              type: "ORDER_REFUND",
              referenceType: "ORDER",
              referenceId: order._id,
              balanceAfter: userAfterRefund?.walletBalance ?? 0,
              note: `Refund for cancelled order ${order.orderNumber}`,
            },
          ],
          { session },
        );
      }

      order.status = newStatus;

      // Auto-mark COD payments as paid when delivered
      if (
        newStatus === orderStatusEnum.DELIVERED &&
        order.paymentMethod === paymentMethodEnum.COD &&
        order.paymentStatus !== paymentStatusEnum.PAID
      ) {
        order.paymentStatus = paymentStatusEnum.PAID;
      }

      // Award loyalty points when payment becomes PAID (unified for COD + Card)
      if (
        order.paymentStatus === paymentStatusEnum.PAID &&
        order.user &&
        !order.loyaltyPointsAwarded
      ) {
        await awardLoyaltyPointsForOrder(order, session);
      }

      // Deduct loyalty points if order is cancelled/returned after points were awarded
      if (
        (newStatus === orderStatusEnum.CANCELLED ||
          newStatus === orderStatusEnum.RETURNED) &&
        order.user &&
        order.loyaltyPointsAwarded > 0
      ) {
        const deductionResult = await deductLoyaltyPointsOnReturnService({
          userId: order.user,
          pointsToDeduct: order.loyaltyPointsAwarded,
          session,
        });

        const userAfterDeduction = await UserModel.findById(order.user)
          .select("loyaltyPoints")
          .session(session);

        await LoyaltyTransactionModel.create(
          [
            {
              user: order.user,
              points: -deductionResult.pointsDeducted,
              type: "DEDUCTED",
              referenceType: "ORDER",
              referenceId: order._id,
              balanceAfter: userAfterDeduction?.loyaltyPoints ?? 0,
              description_en:
                deductionResult.walletDeducted > 0
                  ? `Deducted ${deductionResult.pointsDeducted} points and ${deductionResult.walletDeducted} EGP from wallet for ${newStatus} order ${order.orderNumber}`
                  : `Deducted ${order.loyaltyPointsAwarded} points due to ${newStatus} order ${order.orderNumber}`,
              description_ar:
                deductionResult.walletDeducted > 0
                  ? `خصم ${deductionResult.pointsDeducted} نقطة و ${deductionResult.walletDeducted} جنيه من المحفظة للطلب ${order.orderNumber} ${newStatus}`
                  : `خصم ${order.loyaltyPointsAwarded} نقطة بسبب الطلب ${order.orderNumber} ${newStatus}`,
            },
          ],
          { session },
        );
      }

      order.history = Array.isArray(order.history) ? order.history : [];
      order.history.push({
        at: new Date(),
        description: `Status changed from ${oldStatus} to ${newStatus}`,
        byUserId: actorUserId || undefined,
        visibleToUser: true,
      });

      updated = await order.save({ session });
    });
  } finally {
    session.endSession();
  }

  if (updated) {
    // Fire-and-forget notification about the status change
    sendOrderStatusChangedNotification(updated).catch((err) =>
      console.error(
        "[Order] Failed to send status change notification:",
        err.message,
      ),
    );
  }

  return updated;
}

// ─── Shared: Award Loyalty Points on Payment ────────────────────────────────

async function awardLoyaltyPointsForOrder(order, session) {
  if (!order.user || order.loyaltyPointsAwarded) return;

  // Points on items only (subtotal - discounts), excluding shipping
  const itemsValue = Math.max(
    0,
    (order.subtotal || 0) - (order.discountAmount || 0),
  );
  const pointsToAward = await calculateLoyaltyPointsForOrder(itemsValue);

  if (pointsToAward <= 0) return;

  const userAfterPoints = await UserModel.findOneAndUpdate(
    { _id: order.user },
    { $inc: { loyaltyPoints: pointsToAward } },
    { session, new: true, select: "loyaltyPoints" },
  );

  order.loyaltyPointsAwarded = pointsToAward;

  await LoyaltyTransactionModel.create(
    [
      {
        user: order.user,
        points: pointsToAward,
        type: "EARNED",
        referenceType: "ORDER",
        referenceId: order._id,
        balanceAfter: userAfterPoints?.loyaltyPoints ?? pointsToAward,
        description_en: `Earned ${pointsToAward} points from order ${order.orderNumber}`,
        description_ar: `ربحت ${pointsToAward} نقطة من الطلب ${order.orderNumber}`,
      },
    ],
    { session },
  );

  // Fire-and-forget notification
  dispatchNotification({
    userId: order.user,
    notification: {
      title_en: "Points Earned!",
      title_ar: "لقد ربحت نقاط!",
      body_en: `You earned ${pointsToAward} loyalty points from your order.`,
      body_ar: `لقد ربحت ${pointsToAward} نقطة ولاء من طلبك.`,
    },
    icon: "loyalty",
    action: {
      type: "screen",
      screen: "LoyaltyScreen",
      params: {},
    },
    source: {
      domain: "loyalty",
      event: "points_earned",
      referenceId: String(order._id),
    },
    channels: { push: true, inApp: true },
  }).catch((err) =>
    console.error(
      "[Order] Failed to dispatch loyalty points notification:",
      err.message,
    ),
  );
}

// ─── Payment Confirmation / Failure ─────────────────────────────────────────

// ─── Commit Side Effects (skeleton order → fully committed) ────────────────

async function commitOrderSideEffects(
  order,
  { paymobTransactionId, paymobOrderId },
) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Re-fetch inside transaction for consistency
      const freshOrder = await OrderModel.findById(order._id).session(session);
      if (!freshOrder || freshOrder.sideEffectsCommitted) return;

      // 1. Decrement stock
      await ensureSufficientStockAndDecrement({
        session,
        cart: {
          items: freshOrder.items,
          warehouse: freshOrder.warehouse,
        },
        lang: "en",
      });

      // 2. Deduct wallet (atomic $gte check)
      if (
        freshOrder.user &&
        typeof freshOrder.walletUsed === "number" &&
        freshOrder.walletUsed > 0
      ) {
        const updateResult = await UserModel.updateOne(
          {
            _id: freshOrder.user,
            walletBalance: { $gte: freshOrder.walletUsed },
          },
          { $inc: { walletBalance: -freshOrder.walletUsed } },
          { session },
        );

        if (updateResult.matchedCount === 0) {
          throw new ApiError("Insufficient wallet balance at commit time", 400);
        }

        const userAfterDebit = await UserModel.findById(freshOrder.user)
          .session(session)
          .select("walletBalance");

        await WalletTransactionModel.create(
          [
            {
              user: freshOrder.user,
              amount: -freshOrder.walletUsed,
              type: "ORDER_DEBIT",
              referenceType: "ORDER",
              referenceId: freshOrder._id,
              balanceAfter: userAfterDebit?.walletBalance ?? 0,
            },
          ],
          { session },
        );
      }

      // 3. Increment coupon usage
      if (freshOrder.couponCode) {
        await CouponModel.updateOne(
          { code: freshOrder.couponCode },
          { $inc: { usageCount: 1 } },
          { session },
        );
      }

      // 4. Clear cart
      const cartFilter = freshOrder.user
        ? { user: freshOrder.user }
        : { guestId: freshOrder.guestId };
      await CartModel.updateOne(
        cartFilter,
        {
          items: [],
          totalCartPrice: 0,
          lastActivityAt: new Date(),
          status: "ACTIVE",
        },
        { session },
      );

      // 5. Update order status
      freshOrder.sideEffectsCommitted = true;
      freshOrder.status = orderStatusEnum.PENDING;
      freshOrder.paymentStatus = paymentStatusEnum.PAID;
      freshOrder.paymobTransactionId = paymobTransactionId || undefined;
      if (paymobOrderId) freshOrder.paymobOrderId = paymobOrderId;

      freshOrder.history = Array.isArray(freshOrder.history)
        ? freshOrder.history
        : [];
      freshOrder.history.push({
        at: new Date(),
        description: "Payment confirmed — Order is pending",
        visibleToUser: true,
      });

      // 6. Award loyalty points (card payment confirmed = paid)
      await awardLoyaltyPointsForOrder(freshOrder, session);

      await freshOrder.save({ session });
    });
  } finally {
    session.endSession();
  }

  // Invalidate product caches after stock decrement
  const productIds = (order.items || []).map((i) => i.product);
  await invalidateProductCaches(productIds);

  // Notify user
  const updatedOrder = await OrderModel.findById(order._id);
  if (updatedOrder) {
    sendOrderStatusChangedNotification(updatedOrder).catch((err) =>
      console.error(
        "[Order] Failed to send payment confirmed notification:",
        err.message,
      ),
    );
  }
}

// ─── Payment Confirmation / Failure (dispatches skeleton vs legacy) ────────

export async function confirmOrderPaymentService({
  orderId,
  paymobTransactionId,
  paymobOrderId,
}) {
  const order = await OrderModel.findById(orderId);
  if (!order) return;

  // Idempotency: skip if already confirmed or no longer awaiting payment
  if (order.status !== orderStatusEnum.AWAITING_PAYMENT) return;
  if (order.paymentStatus === paymentStatusEnum.PAID) return;

  if (order.sideEffectsCommitted === false) {
    // New skeleton order flow: commit side effects now
    try {
      await commitOrderSideEffects(order, {
        paymobTransactionId,
        paymobOrderId,
      });
    } catch (err) {
      // Side effects failed (stock exhausted, wallet insufficient, etc.)
      console.error(
        `[Order] commitOrderSideEffects failed for ${order.orderNumber}: ${err.message}`,
      );

      order.status = orderStatusEnum.CANCELLED;
      order.paymentStatus = paymentStatusEnum.REFUNDED;
      order.history = Array.isArray(order.history) ? order.history : [];
      order.history.push({
        at: new Date(),
        description:
          "Payment received but order could not be fulfilled — refunded to wallet",
        visibleToUser: false,
      });

      if (order.user) {
        // order.save + wallet credit in parallel (both critical, independent)
        const [, updatedUser] = await Promise.all([
          order.save(),
          UserModel.findByIdAndUpdate(
            order.user,
            { $inc: { walletBalance: order.total } },
            { new: true },
          ),
        ]);

        await WalletTransactionModel.create({
          user: order.user,
          amount: order.total,
          type: "ORDER_REFUND",
          referenceType: "ORDER",
          referenceId: order._id,
          balanceAfter: updatedUser?.walletBalance ?? 0,
        });

        // Fire-and-forget notification
        dispatchNotification({
          userId: order.user,
          title: {
            title_en: "Order could not be completed",
            title_ar: "لم يتم إتمام الطلب",
          },
          body: {
            body_en: `An item in your order became unavailable. ${order.total} EGP has been added to your wallet.`,
            body_ar: `أحد المنتجات في طلبك أصبح غير متاح. تم إضافة ${order.total} جنيه إلى محفظتك.`,
          },
          icon: "wallet",
          action: {
            type: "screen",
            screen: "WalletScreen",
            params: {},
          },
          source: {
            domain: "order",
            event: "payment_refunded",
            referenceId: String(order._id),
          },
          channels: { push: true, inApp: true },
        }).catch((e) =>
          console.error("[Order] Refund notification failed:", e.message),
        );
      } else {
        // Guest order — no wallet, flag for manual Paymob refund
        order.history.push({
          at: new Date(),
          description: "Guest order — manual Paymob refund required",
          visibleToUser: false,
        });
        await order.save();
      }
    }
    return;
  }

  // Legacy flow: order already has side effects applied, just confirm payment
  order.status = orderStatusEnum.PENDING;
  order.paymentStatus = paymentStatusEnum.PAID;
  order.paymobTransactionId = paymobTransactionId || undefined;
  if (paymobOrderId) order.paymobOrderId = paymobOrderId;

  order.history = Array.isArray(order.history) ? order.history : [];
  order.history.push({
    at: new Date(),
    description: "Payment confirmed",
    visibleToUser: true,
  });

  await order.save();

  sendOrderStatusChangedNotification(order).catch((err) =>
    console.error(
      "[Order] Failed to send payment confirmed notification:",
      err.message,
    ),
  );
}

export async function failOrderPaymentService(orderId) {
  const order = await OrderModel.findById(orderId);
  if (!order) return;

  // Only fail orders that are still awaiting payment
  if (order.status !== orderStatusEnum.AWAITING_PAYMENT) return;

  if (order.sideEffectsCommitted === false) {
    // New skeleton order: nothing to rollback, just cancel
    order.status = orderStatusEnum.CANCELLED;
    order.paymentStatus = paymentStatusEnum.FAILED;

    order.history = Array.isArray(order.history) ? order.history : [];
    order.history.push({
      at: new Date(),
      description: "Payment failed — order cancelled",
      visibleToUser: true,
    });

    await order.save();
    return;
  }

  // Legacy flow: restore stock, wallet, coupon
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const freshOrder = await OrderModel.findById(orderId).session(session);
      if (!freshOrder) return;
      if (freshOrder.status !== orderStatusEnum.AWAITING_PAYMENT) return;

      await restoreStockForOrder({ session, order: freshOrder });

      if (
        freshOrder.user &&
        typeof freshOrder.walletUsed === "number" &&
        freshOrder.walletUsed > 0
      ) {
        await UserModel.updateOne(
          { _id: freshOrder.user },
          { $inc: { walletBalance: freshOrder.walletUsed } },
          { session },
        );

        const userAfterRefund = await UserModel.findById(freshOrder.user)
          .session(session)
          .select("walletBalance");

        await WalletTransactionModel.create(
          [
            {
              user: freshOrder.user,
              amount: freshOrder.walletUsed,
              type: "ORDER_REFUND",
              referenceType: "ORDER",
              referenceId: freshOrder._id,
              balanceAfter: userAfterRefund?.walletBalance ?? 0,
              note: `Payment failed - refund for order ${freshOrder.orderNumber}`,
            },
          ],
          { session },
        );
      }

      if (freshOrder.couponCode) {
        await CouponModel.updateOne(
          { code: freshOrder.couponCode, usageCount: { $gt: 0 } },
          { $inc: { usageCount: -1 } },
          { session },
        );
      }

      freshOrder.status = orderStatusEnum.CANCELLED;
      freshOrder.paymentStatus = paymentStatusEnum.FAILED;

      freshOrder.history = Array.isArray(freshOrder.history)
        ? freshOrder.history
        : [];
      freshOrder.history.push({
        at: new Date(),
        description: "Payment failed - order cancelled",
        visibleToUser: true,
      });

      await freshOrder.save({ session });
    });
  } finally {
    session.endSession();
  }

  const freshOrder = await OrderModel.findById(orderId).lean();
  if (freshOrder) {
    const productIds = (freshOrder.items || []).map((i) => i.product);
    await invalidateProductCaches(productIds);
  }
}

// ─── Abandoned Payment Cleanup ──────────────────────────────────────────────

export async function cancelAbandonedCardOrdersService(timeoutMinutes = 30) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const abandonedOrders = await OrderModel.find({
    status: orderStatusEnum.AWAITING_PAYMENT,
    paymentMethod: paymentMethodEnum.CARD,
    paymentStatus: paymentStatusEnum.PENDING,
    createdAt: { $lte: cutoff },
  }).select("_id orderNumber");

  let cancelledCount = 0;

  for (const order of abandonedOrders) {
    try {
      await failOrderPaymentService(order._id);
      cancelledCount++;
      console.log(`[AbandonedPayments] Cancelled order ${order.orderNumber}`);
    } catch (err) {
      console.error(
        `[AbandonedPayments] Failed to cancel order ${order.orderNumber}:`,
        err.message,
      );
    }
  }

  return { cancelledCount };
}
