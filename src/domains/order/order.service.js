import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { ApiError } from "../../shared/utils/ApiError.js";
import { OrderModel } from "./order.model.js";
import { CartModel } from "../cart/cart.model.js";
import { ProductModel } from "../product/product.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { CouponModel } from "../coupon/coupon.model.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import {
  orderLineKindEnum,
  orderStatusEnum,
  orderSubstitutionStateEnum,
  inventoryAuditReasonEnum,
  orderPaymentAttemptStatusEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  FREE_SHIPPING_THRESHOLD,
  roles,
} from "../../shared/constants/enums.js";
import { fromPiastres, toPiastres } from "../../shared/utils/money.js";
import { assertSettlementInvariant } from "../settlement/settlement.service.js";
import { escapeRegex } from "../../shared/utils/escapeRegex.js";
import { invalidateProductCaches } from "../product/productCache.service.js";
import { processRestockSubscriptionsForProduct } from "../restockSubscription/restockSubscription.service.js";
import { validateAndApplyCoupon } from "../coupon/coupon.application.js";
import { sendOrderStatusChangedNotification, sendNewOrderNotificationToAdminsAndModerators } from "../notification/notification.service.js";
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
  refundTransaction,
} from "../payment/paymob.service.js";
import {
  getSavedCardTokenService,
  getUserSavedCardTokensService,
} from "../payment/savedCard.service.js";
import {
  deleteImage,
  validateImageFile,
  uploadImage,
  IMAGE_UPLOAD_PROFILES,
  IMAGE_VISIBILITY,
} from "../../shared/utils/imageUpload.js";
import { MAX_INSTAPAY_SCREENSHOTS } from "./order.instapay.js";

import { resolveEffectiveWarehouse } from '../warehouse/warehouse.fulfillment.js';
import { restoreFinalOrderInventory } from "../inventory/inventory.service.js";
import { selectFinalFulfilledOrderItems } from "./order.fulfillment.js";
import { shouldDeferCardLoyaltyUntilAcceptance } from "../substitution/substitution.loyalty.js";
import {
  cancelActiveSubstitutionForOrder,
  finalizeSubstitutionInstapayOnOrderAcceptance,
} from "../substitution/substitution.service.js";
import { OrderPaymentAttemptModel } from "../payment/orderPaymentAttempt.model.js";
import { createOrFindRefundOperation } from "../payment/substitutionPayment.service.js";

function processRestockedOrderProductsBestEffort(productIds, warehouseId) {
  const uniqueProductIds = [
    ...new Set((productIds || []).filter(Boolean).map(String)),
  ];
  if (!uniqueProductIds.length || !warehouseId) return;

  Promise.all(
    uniqueProductIds.map((productId) =>
      processRestockSubscriptionsForProduct({
        productId,
        warehouseIds: [String(warehouseId)],
      }),
    ),
  ).catch((error) =>
    console.error(
      "[Order] Failed to process restock subscriptions:",
      error?.message || error,
    ),
  );
}

export async function resolveOrderCartWarehouse(cart) {
  if (!cart?.warehouse) {
    throw new ApiError('Cart warehouse is not set', 400);
  }

  const { effectiveWarehouse } = await resolveEffectiveWarehouse(
    cart.warehouse,
  );
  cart.warehouse = effectiveWarehouse._id;
  return cart.warehouse;
}

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function generateCheckoutKey() {
  return randomUUID();
}

function normalizePaymentMethod(method) {
  if (!method) return paymentMethodEnum.COD;
  const v = String(method).trim().toLowerCase();
  if (v === paymentMethodEnum.CARD) return paymentMethodEnum.CARD;
  if (v === paymentMethodEnum.POS_ON_DELIVERY) return paymentMethodEnum.POS_ON_DELIVERY;
  if (v === paymentMethodEnum.INSTAPAY) return paymentMethodEnum.INSTAPAY;
  return paymentMethodEnum.COD;
}

async function cleanupUploadedInstapayScreenshots(uploadedImages) {
  await Promise.all(
    (Array.isArray(uploadedImages) ? uploadedImages : []).map((image) =>
      deleteImage(image),
    ),
  );
}

async function uploadInstapayScreenshotFiles(files, lang) {
  const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : [];

  if (normalizedFiles.length === 0) {
    throw new ApiError(
      lang === "en" ? "instapayScreenshot is required" : "صورة التحويل مطلوبة",
      400,
    );
  }
  if (normalizedFiles.length > MAX_INSTAPAY_SCREENSHOTS) {
    throw new ApiError(
      `A maximum of ${MAX_INSTAPAY_SCREENSHOTS} InstaPay screenshots is allowed`,
      400,
    );
  }

  // Validate every file before uploading any of them, avoiding partial writes
  // when one file is invalid.
  normalizedFiles.forEach((file) => validateImageFile(file));

  const uploadedImages = [];
  try {
    for (const file of normalizedFiles) {
      const uploadedImage = await uploadImage(file, {
        folder: "instapay_screenshots",
        visibility: IMAGE_VISIBILITY.PRIVATE,
        profile: IMAGE_UPLOAD_PROFILES.PROOF,
      });
      if (!uploadedImage?.url) {
        throw new ApiError("Failed to upload InstaPay screenshot", 502);
      }
      uploadedImages.push(uploadedImage);
    }
    return uploadedImages;
  } catch (error) {
    await cleanupUploadedInstapayScreenshots(uploadedImages);
    throw error;
  }
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
  [orderStatusEnum.DELIVERED]: [orderStatusEnum.RETURNED],
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
    lineId: randomUUID(),
    lineKind: orderLineKindEnum.ORIGINAL,
    product: item.product,
    productType: item.productType,
    productName: item.productName || "",
    productImageUrl: item.productImageUrl || null,
    variantId: item.variantId || undefined,
    variantOptions,
    quantity,
    fulfillmentQuantity: quantity,
    finalizedUnavailableQuantity: 0,
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
    itemPricePiastres: toPiastres(itemPrice),
    lineTotalPiastres: toPiastres(quantity * itemPrice),
  };
}

function nonNegativePiastres(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// A substitution credit is already value returned to the customer. On a later
// cancellation it must offset the original payment sources exactly once: first
// the wallet that was debited, then the card. Pending guest-card liabilities
// stay excluded because their durable refund operation will settle them.
export function deriveCancellationSettlementRefunds(
  settlement,
  { fallbackWalletUsed = 0 } = {},
) {
  if (!settlement) {
    return {
      walletRefundPiastres: nonNegativePiastres(toPiastres(fallbackWalletUsed)),
      cardRefundPiastres: null,
    };
  }

  const walletDebitedPiastres = nonNegativePiastres(
    settlement.walletDebitedPiastres,
  );
  let priorWalletCreditPiastres = nonNegativePiastres(
    settlement.walletCreditedPiastres,
  );
  const walletRefundPiastres = Math.max(
    0,
    walletDebitedPiastres - priorWalletCreditPiastres,
  );
  priorWalletCreditPiastres = Math.max(
    0,
    priorWalletCreditPiastres - walletDebitedPiastres,
  );

  return {
    walletRefundPiastres,
    cardRefundPiastres: Math.max(
      0,
      nonNegativePiastres(settlement.cardCapturedPiastres) -
        nonNegativePiastres(settlement.cardRefundedPiastres) -
        nonNegativePiastres(settlement.pendingRefundLiabilityPiastres) -
        priorWalletCreditPiastres,
    ),
  };
}

export function requiresManualGuestMultiCaptureRefund({
  order,
  paymentAttempts,
}) {
  return Boolean(
    !order?.user &&
      order?.guestId &&
      order?.paymentMethod === paymentMethodEnum.CARD &&
      order?.paymobTransactionId &&
      (paymentAttempts || []).some(
        (attempt) =>
          attempt?.successAccepted === true &&
          attempt?.status === orderPaymentAttemptStatusEnum.SUCCEEDED &&
          attempt?.paymobTransactionId,
      ),
  );
}

export function deriveGuestCardDirectRefundAmountPiastres(order) {
  const capturedOutstandingPiastres = order?.settlement
    ? deriveCancellationSettlementRefunds(order.settlement, {
        fallbackWalletUsed: order.walletUsed || 0,
      }).cardRefundPiastres
    : toPiastres(order?.total || 0);

  return order?.status === orderStatusEnum.RETURNED
    ? Math.min(
        capturedOutstandingPiastres,
        toPiastres(
          Math.max(
            0,
            (order.subtotal || 0) - (order.discountAmount || 0),
          ),
        ),
      )
    : capturedOutstandingPiastres;
}

export async function queueManualGuestMultiCaptureRefund({
  order,
  paymentAttempts,
  refundAmountPiastres,
  session = null,
  createRefundOperation = createOrFindRefundOperation,
}) {
  if (order?.multiCaptureRefundReconciliationOperation) return true;
  const anchor = (paymentAttempts || []).find(
    (attempt) => attempt?.substitutionRequest,
  );
  if (
    !anchor ||
    !Number.isSafeInteger(refundAmountPiastres) ||
    refundAmountPiastres <= 0
  ) {
    return false;
  }

  const result = await createRefundOperation({
    operationId:
      "guest-multi-capture-refund:" +
      order._id +
      ":" +
      order.status +
      ":" +
      refundAmountPiastres,
    orderId: order._id,
    substitutionRequestId: anchor.substitutionRequest,
    guestId: order.guestId,
    method: "manual",
    amountPiastres: refundAmountPiastres,
    currency: order.currency || "EGP",
    session,
  });

  const history = {
    at: new Date(),
    description:
      "Manual refund reconciliation required: original card payment and substitution top-up were captured separately; no aggregate provider refund was sent.",
    visibleToUser: false,
  };
  order.multiCaptureRefundReconciliationOperation = result.operation._id;
  order.paymentStatus = paymentStatusEnum.PAID;
  order.history = [...(order.history || []), history];
  return true;
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
    productById,
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
            ? `product ${item.productName} is out of stock`
            : `المنتج ${item.productName} غير متوفر في المخزون`,
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
            ? `product ${item.productName} is out of stock`
            : `المنتج ${item.productName} غير متوفر في المخزون`,
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
      stock.revision =
        Number.isInteger(stock.revision) && stock.revision >= 0
          ? stock.revision + 1
          : 1;
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
      vStock.revision =
        Number.isInteger(vStock.revision) && vStock.revision >= 0
          ? vStock.revision + 1
          : 1;
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

export async function restoreStockForOrder({
  session,
  order,
  actorUserId,
  reason = inventoryAuditReasonEnum.CANCEL_RESTORE,
}) {
  return restoreFinalOrderInventory({
    order,
    warehouseId: order.warehouse,
    operationId: `order-final-inventory-restore:${order._id}:${reason}`,
    actorUserId,
    reason,
    metadata: { source: "order_status_transition" },
    session,
  });
}

async function applyCouponIfAny({
  couponCode,
  userId,
  cartItems,
  productBrandMap,
  subtotal,
  shippingFee,
  lang = "en",
}) {
  return validateAndApplyCoupon({
    couponCode,
    userId,
    cartItems,
    productBrandMap,
    subtotal,
    shippingFee,
    lang,
  });
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
  instapayScreenshotUrls = [],
}) {
  await resolveOrderCartWarehouse(cart);

  const { orderItems, subtotal, hasPromotionalItems, productById } =
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
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
  // Free shipping for orders with items subtotal >= threshold
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : baseShippingFee;

  // Build coupon context from order items + product brand data
  const couponCartItems = orderItems.map((item) => {
    const product = productById.get(String(item.product));
    let hasAdminDiscount = false;
    let basePrice = 0;
    if (product) {
      if (item.variantId) {
        const variant = Array.isArray(product.variants)
          ? product.variants.find((v) => String(v._id) === String(item.variantId))
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
    const sellingBelowBase =
      basePrice > 0 && typeof item.itemPrice === "number" && item.itemPrice < basePrice;

    return {
      product: item.product,
      lineTotal: typeof item.lineTotal === "number" ? item.lineTotal : 0,
      hasDiscount: !!item.promotion || hasAdminDiscount || sellingBelowBase,
    };
  });

  const productBrandMap = new Map();
  for (const [pid, product] of productById) {
    productBrandMap.set(pid, product.brand ? String(product.brand) : null);
  }

  // Log brand map when coupon is present — helps diagnose brand exclusion issues
  if (couponCode) {
    const brandMapEntries = Object.fromEntries(productBrandMap);
    console.log(
      `[Order] Coupon "${couponCode}" — productBrandMap: ${JSON.stringify(brandMapEntries)}, ` +
      `couponCartItems: ${JSON.stringify(couponCartItems.map((ci) => ({ product: String(ci.product), hasDiscount: ci.hasDiscount, lineTotal: ci.lineTotal })))}`,
    );
  }

  const couponResult = await applyCouponIfAny({
    couponCode,
    userId: couponUserId,
    cartItems: couponCartItems,
    productBrandMap,
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
  const currentOrderValuePiastres = toPiastres(netSubtotal + netShipping);
  const amountAfterWalletPiastres = toPiastres(finalTotal);

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
    instapayScreenshot: instapayScreenshotUrls[0] || undefined,
    instapayScreenshots:
      instapayScreenshotUrls.length > 0 ? instapayScreenshotUrls : undefined,
    paymentStatus: paymentStatusEnum.PENDING,
    sideEffectsCommitted: !isCard,
    settlement: {
      schemaVersion: 1,
      revision: 0,
      currency: cart.currency || "EGP",
      currentMerchandiseGrossPiastres: toPiastres(subtotal),
      originalCouponDiscountPiastres: toPiastres(
        couponResult.discountAmount,
      ),
      preservedCouponDiscountPiastres: toPiastres(
        couponResult.discountAmount,
      ),
      lockedNetShippingPiastres: toPiastres(netShipping),
      currentOrderValuePiastres,
      walletDebitedPiastres: toPiastres(walletResult.walletUsed),
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 0,
      cardRefundedPiastres: 0,
      cardDuePiastres: isCard ? amountAfterWalletPiastres : 0,
      instapaySubmittedPiastres:
        pm === paymentMethodEnum.INSTAPAY ? amountAfterWalletPiastres : 0,
      instapayConfirmedPiastres: 0,
      deliveryDuePiastres:
        pm === paymentMethodEnum.COD ||
        pm === paymentMethodEnum.POS_ON_DELIVERY
          ? amountAfterWalletPiastres
          : 0,
      pendingRefundLiabilityPiastres: 0,
      migrationState: "native",
    },
    history: [historyEntry],
    notes: notes || undefined,
    ...(isCard && cart.checkoutKey ? { checkoutKey: cart.checkoutKey } : {}),
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

async function initializeCardPayment(order, cardTokens = []) {
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
    cardTokens,
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
  instapayScreenshotFiles = [],
  lang = "en",
}) {
  if (!userId) {
    throw new ApiError(
      lang === "en" ? "userId is required" : "معرف المستخدم مطلوب",
      400,
    );
  }

  const pm = normalizePaymentMethod(paymentMethod);

  let uploadedInstapayScreenshots = [];
  if (pm === paymentMethodEnum.INSTAPAY) {
    uploadedInstapayScreenshots = await uploadInstapayScreenshotFiles(
      instapayScreenshotFiles,
      lang,
    );
  }

  // ── Card: idempotency check via checkoutKey ──
  if (pm === paymentMethodEnum.CARD) {
    // Fetch cart to get checkoutKey (should always exist from getCart, fallback if not)
    const userCart = await CartModel.findOne({ user: userId });
    if (userCart && !userCart.checkoutKey) {
      userCart.checkoutKey = generateCheckoutKey();
      await userCart.save();
    }

    const checkoutKey = userCart?.checkoutKey;

    if (checkoutKey) {
      const existingPending = await OrderModel.findOne({
        checkoutKey,
        status: orderStatusEnum.AWAITING_PAYMENT,
      });

      if (existingPending) {
        const ageMs = Date.now() - existingPending.createdAt.getTime();
        const blockMs = 10 * 60 * 1000;

        if (ageMs < blockMs) {
          const remainingSec = Math.ceil((blockMs - ageMs) / 1000);
          throw new ApiError(
            lang === "en"
              ? `You have a payment in progress. Please retry after ${remainingSec} seconds`
              : `لديك عملية دفع قيد التنفيذ. يرجى إعادة المحاولة بعد ${remainingSec} ثانية`,
            409,
          );
        }

        // Stale (>15 min, no webhook arrived) — auto-cancel
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
  }

  let session;
  let createdOrder = null;

  try {
    session = await mongoose.startSession();
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
        instapayScreenshotUrls: uploadedInstapayScreenshots.map(
          (image) => image.url,
        ),
      });
    });
  } catch (error) {
    await cleanupUploadedInstapayScreenshots(uploadedInstapayScreenshots);
    throw error;
  } finally {
    session?.endSession();
  }

  if (!createdOrder) {
    await cleanupUploadedInstapayScreenshots(uploadedInstapayScreenshots);
    return { order: null };
  }

  // ── Card payment: initialize Paymob intention ──
  if (createdOrder.paymentMethod === paymentMethodEnum.CARD) {
    let cardTokens = [];
    if (userId) {
      cardTokens = await getUserSavedCardTokensService(userId);
    }

    try {
      const payment = await initializeCardPayment(createdOrder, cardTokens);
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


  sendNewOrderNotificationToAdminsAndModerators(createdOrder).catch((err) =>
    console.error(
      "[Order] Failed to send new order notification to admins/moderators:",
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
  instapayScreenshotFiles = [],
  lang = "en",
}) {
  if (!guestId) {
    throw new ApiError(
      lang === "en" ? "guestId is required" : "معرف الضيف مطلوب",
      400,
    );
  }

  const pm = normalizePaymentMethod(paymentMethod);

  let uploadedInstapayScreenshots = [];
  if (pm === paymentMethodEnum.INSTAPAY) {
    uploadedInstapayScreenshots = await uploadInstapayScreenshotFiles(
      instapayScreenshotFiles,
      lang,
    );
  }

  // ── Card: idempotency check via checkoutKey ──
  if (pm === paymentMethodEnum.CARD) {
    // Fetch cart to get checkoutKey (should always exist from getCart, fallback if not)
    const guestCart = await CartModel.findOne({ guestId });
    if (guestCart && !guestCart.checkoutKey) {
      guestCart.checkoutKey = generateCheckoutKey();
      await guestCart.save();
    }

    const checkoutKey = guestCart?.checkoutKey;

    if (checkoutKey) {
      const existingPending = await OrderModel.findOne({
        checkoutKey,
        status: orderStatusEnum.AWAITING_PAYMENT,
      });

      if (existingPending) {
        const ageMs = Date.now() - existingPending.createdAt.getTime();
        const blockMs = 10 * 60 * 1000;

        if (ageMs < blockMs) {
          const remainingSec = Math.ceil((blockMs - ageMs) / 1000);
          throw new ApiError(
            lang === "en"
              ? `You have a payment in progress. Please retry after ${remainingSec} seconds`
              : `لديك عملية دفع قيد التنفيذ. يرجى إعادة المحاولة بعد ${remainingSec} ثانية`,
            409,
          );
        }

        // Stale (>15 min, no webhook arrived) — auto-cancel
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
  }

  let session;
  let createdOrder = null;

  try {
    session = await mongoose.startSession();
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
        instapayScreenshotUrls: uploadedInstapayScreenshots.map(
          (image) => image.url,
        ),
      });
    });
  } catch (error) {
    await cleanupUploadedInstapayScreenshots(uploadedInstapayScreenshots);
    throw error;
  } finally {
    session?.endSession();
  }

  if (!createdOrder) {
    await cleanupUploadedInstapayScreenshots(uploadedInstapayScreenshots);
    return { order: null };
  }

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

  // ── COD: invalidate caches and send notifications ──
  const productIds = Array.isArray(createdOrder.items)
    ? createdOrder.items.map((i) => i.product)
    : [];
  await invalidateProductCaches(productIds);

  sendNewOrderNotificationToAdminsAndModerators(createdOrder).catch((err) =>
    console.error(
      "[Order] Failed to send new order notification to admins/moderators:",
      err.message,
    ),
  );

  return { order: createdOrder };
}

// ─── Reorder ────────────────────────────────────────────────────────────────

export async function reorderService({ userId, guestId, orderId, lang = "en" }) {
  const normalizedLang = normalizeLang(lang);

  // 1. Find the order and verify ownership
  const order = await OrderModel.findById(orderId).lean();
  if (!order) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }

  if (userId && String(order.user) !== String(userId)) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }

  if (guestId && order.guestId !== guestId) {
    throw new ApiError(
      lang === "en" ? "Order not found" : "الطلب غير موجود",
      404,
    );
  }

  // 2. Find the existing cart (do NOT create one)
  const identityFilter = userId ? { user: userId } : { guestId };
  const { findCart } = await import("../cart/cart.repository.js");
  const cart = await findCart(identityFilter);

  if (!cart) {
    throw new ApiError(
      lang === "en" ? "Cart not found" : "السلة غير موجودة",
      404,
    );
  }

  const warehouseId = cart.warehouse;
  if (!warehouseId) {
    throw new ApiError(
      lang === "en"
        ? "Cart has no warehouse assigned. Please set a delivery address first"
        : "السلة ليس لها مخزن محدد. يرجى تحديد عنوان التوصيل أولاً",
      400,
    );
  }

  // 3. Fetch all products from the order items
  const orderItems = selectFinalFulfilledOrderItems(order.items);
  if (!orderItems.length) {
    throw new ApiError(
      lang === "en"
        ? "This order has no items to reorder"
        : "هذا الطلب لا يحتوي على منتجات لإعادة الطلب",
      400,
    );
  }

  const productIds = [
    ...new Set(
      orderItems
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  const products = await ProductModel.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  // 4. Validate every order item (all-or-nothing)
  for (const item of orderItems) {
    const product = productById.get(String(item.product));
    const itemName = item.productName || "Unknown product";

    if (!product) {
      throw new ApiError(
        lang === "en"
          ? `Product ${itemName} no longer exists`
          : `المنتج ${itemName} لم يعد متوفراً`,
        400,
      );
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;

    if (product.type === "SIMPLE") {
      const stocks = Array.isArray(product.warehouseStocks)
        ? product.warehouseStocks
        : [];
      const stock = stocks.find(
        (ws) => String(ws.warehouse) === String(warehouseId),
      );

      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        throw new ApiError(
          lang === "en"
            ? `Product ${itemName} is out of stock`
            : `المنتج ${itemName} غير متوفر في المخزون`,
          400,
        );
      }

      if (quantity > stock.quantity) {
        throw new ApiError(
          lang === "en"
            ? `Requested quantity for ${itemName} exceeds available stock (${stock.quantity})`
            : `الكمية المطلوبة للمنتج ${itemName} تتجاوز المخزون المتاح (${stock.quantity})`,
          400,
        );
      }
    } else {
      // VARIANT
      const variants = Array.isArray(product.variants)
        ? product.variants
        : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId),
      );

      if (!variant) {
        throw new ApiError(
          lang === "en"
            ? `Variant not found for product ${itemName}`
            : `الإختيار غير موجود للمنتج ${itemName}`,
          400,
        );
      }

      const vStocks = Array.isArray(variant.warehouseStocks)
        ? variant.warehouseStocks
        : [];
      const vStock = vStocks.find(
        (ws) => String(ws.warehouse) === String(warehouseId),
      );

      if (
        !vStock ||
        typeof vStock.quantity !== "number" ||
        vStock.quantity <= 0
      ) {
        throw new ApiError(
          lang === "en"
            ? `Product ${itemName} is out of stock`
            : `المنتج ${itemName} غير متوفر في المخزون`,
          400,
        );
      }

      if (quantity > vStock.quantity) {
        throw new ApiError(
          lang === "en"
            ? `Requested quantity for ${itemName} exceeds available stock (${vStock.quantity})`
            : `الكمية المطلوبة للمنتج ${itemName} تتجاوز المخزون المتاح (${vStock.quantity})`,
          400,
        );
      }
    }
  }

  // 5. All validations passed — merge order items into cart
  const cartItems = Array.isArray(cart.items) ? cart.items : [];

  for (const orderItem of orderItems) {
    const product = productById.get(String(orderItem.product));
    if (!product) continue;

    const productName = pickLocalizedField(product, "name", normalizedLang);

    // Build the cart item key: productId + variantId
    const existingCartItem = cartItems.find((ci) => {
      if (!ci.product || String(ci.product) !== String(orderItem.product)) {
        return false;
      }
      if (product.type === "SIMPLE") {
        return !ci.variantId;
      }
      return (
        ci.variantId && String(ci.variantId) === String(orderItem.variantId)
      );
    });

    const orderQuantity =
      typeof orderItem.quantity === "number" && orderItem.quantity > 0
        ? orderItem.quantity
        : 1;

    if (existingCartItem) {
      // Order quantity always wins (overwrite)
      existingCartItem.quantity = orderQuantity;
      existingCartItem.productName = productName;
    } else {
      // Add new item to cart
      let productImageUrl = orderItem.productImageUrl || null;
      let variantOptionsSnapshot = [];

      if (product.type === "VARIANT" && orderItem.variantId) {
        const variant = (product.variants || []).find(
          (v) => String(v._id) === String(orderItem.variantId),
        );
        if (variant) {
          variantOptionsSnapshot = Array.isArray(variant.options)
            ? variant.options.map((o) => ({
                name: typeof o.name === "string" ? o.name : "",
                value: typeof o.value === "string" ? o.value : "",
              }))
            : [];

          if (Array.isArray(variant.images) && variant.images.length > 0) {
            const mainImg =
              variant.images.find((img) => img.isMain) || variant.images[0];
            productImageUrl = mainImg?.url || productImageUrl;
          }
        }
      }

      cart.items.push({
        product: orderItem.product,
        productType: product.type,
        productName,
        productImageUrl,
        variantId: orderItem.variantId || undefined,
        variantOptionsSnapshot,
        quantity: orderQuantity,
        itemPrice: 0, // Will be recalculated by rebindCartToWarehouse
      });
    }
  }

  // 6. Rebind to refresh prices, promotions, and persist
  const {
    rebindCartToWarehouse,
    mapCartToResponse,
  } = await import("../cart/cart.service.js");

  const refreshedCart = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCartToResponse(refreshedCart);
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
      totalOrders: 0,
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
    if (from) {
      // Append T00:00:00 so the date is parsed as local (Cairo) time, not UTC
      const fromStr = String(from).trim();
      filter.createdAt.$gte = fromStr.includes("T")
        ? new Date(fromStr)
        : new Date(fromStr + "T00:00:00");
    }
    if (to) {
      // Append T23:59:59.999 so the filter includes the entire end day in local time
      const toStr = String(to).trim();
      filter.createdAt.$lte = toStr.includes("T")
        ? new Date(toStr)
        : new Date(toStr + "T23:59:59.999");
    }
  }

  const extraFilter = buildRegexFilter(rest, []);
  Object.assign(filter, extraFilter);

  if (typeof q === "string" && q.trim()) {
    const regex = { $regex: escapeRegex(q.trim()), $options: "i" };

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

  // When no status filter is applied, also compute per-status counts
  // Uses countDocuments (not aggregate) so Mongoose auto-casts ObjectIds
  const includeStatusCounts = !status;
  const allStatuses = Object.values(orderStatusEnum).filter(
    (s) =>
      s !== orderStatusEnum.AWAITING_PAYMENT &&
      s !== orderStatusEnum.FAILED,
  );

  const promises = [
    OrderModel.countDocuments(filter),
    OrderModel.find(filter)
      .sort(sortOrder)
      .skip(skip)
      .limit(limitNum)
      .populate({ path: "user", select: "name phone" })
      .populate({ path: "warehouse", select: "name governorate address" })
      .populate({ path: "history.byUserId", select: "name role" })
      .lean(),
  ];

  if (includeStatusCounts) {
    for (const s of allStatuses) {
      promises.push(OrderModel.countDocuments({ ...filter, status: s }));
    }
  }

  const [totalCount, orders, ...statusCountResults] =
    await Promise.all(promises);

  await rebindOrdersLocalization(orders, lang);

  const response = {
    totalOrders: totalCount,
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: orders.length,
    data: orders,
  };

  if (includeStatusCounts) {
    const countsMap = {};
    allStatuses.forEach((s, i) => {
      countsMap[s] = statusCountResults[i];
    });
    response.statusCounts = countsMap;
  }

  return response;
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
  actorRole,
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

  // Only SUPER_ADMIN can cancel or return orders
  if (
    (newStatus === orderStatusEnum.CANCELLED ||
      newStatus === orderStatusEnum.RETURNED) &&
    actorRole !== roles.SUPER_ADMIN
  ) {
    throw new ApiError(
      lang === "en"
        ? "Only super admin can cancel or return orders"
        : "فقط المدير الأعلى يمكنه إلغاء أو إرجاع الطلبات",
      403,
    );
  }

  const session = await mongoose.startSession();
  let updated;
  let stockWasRestored = false;

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

      const blocksStatusProgression = [
        orderSubstitutionStateEnum.AWAITING_CUSTOMER,
        orderSubstitutionStateEnum.AWAITING_CARD_PAYMENT,
      ].includes(
        order.substitutionState || orderSubstitutionStateEnum.NONE,
      );
      if (blocksStatusProgression && newStatus !== orderStatusEnum.CANCELLED) {
        throw new ApiError(
          lang === "en"
            ? "This order is waiting for the customer to resolve a substitution"
            : "هذا الطلب في انتظار رد العميل على البدائل",
          409,
          [{ code: "SUBSTITUTION_ACTION_REQUIRED" }],
        );
      }

      const isCancelling =
        newStatus === orderStatusEnum.CANCELLED &&
        oldStatus !== orderStatusEnum.CANCELLED;

      const isReturning =
        newStatus === orderStatusEnum.RETURNED &&
        oldStatus === orderStatusEnum.DELIVERED;

      // Only restore stock/wallet if side effects were committed
      const shouldRestoreStock =
        (isCancelling || isReturning) && order.sideEffectsCommitted !== false;

      if (shouldRestoreStock) {
        await restoreStockForOrder({
          session,
          order,
          actorUserId,
          reason: isReturning
            ? inventoryAuditReasonEnum.RETURN_RESTORE
            : inventoryAuditReasonEnum.CANCEL_RESTORE,
        });
        stockWasRestored = true;
      }
      if (isCancelling) {
        await cancelActiveSubstitutionForOrder({
          order,
          actorUserId,
          session,
        });
      }

      const cancellationSettlementRefunds = isCancelling
        ? deriveCancellationSettlementRefunds(order.settlement, {
            fallbackWalletUsed: order.walletUsed || 0,
          })
        : null;

      // Cancellation: refund only the wallet amount still retained by the
      // order after any earlier substitution credit.
      const shouldRefundWalletUsed =
        isCancelling &&
        order.sideEffectsCommitted !== false &&
        order.user &&
        cancellationSettlementRefunds.walletRefundPiastres > 0;

      if (shouldRefundWalletUsed) {
        const walletRefund = fromPiastres(
          cancellationSettlementRefunds.walletRefundPiastres,
        );
        await UserModel.updateOne(
          { _id: order.user },
          { $inc: { walletBalance: walletRefund } },
          { session },
        );

        const userAfterRefund = await UserModel.findById(order.user)
          .session(session)
          .select("walletBalance");

        await WalletTransactionModel.create(
          [
            {
              user: order.user,
              amount: walletRefund,
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

      // Auto-mark pay-on-delivery methods as paid when delivered
      const payOnDeliveryMethods = [
        paymentMethodEnum.COD,
        paymentMethodEnum.POS_ON_DELIVERY,
      ];
      if (
        newStatus === orderStatusEnum.DELIVERED &&
        payOnDeliveryMethods.includes(order.paymentMethod) &&
        order.paymentStatus !== paymentStatusEnum.PAID
      ) {
        order.paymentStatus = paymentStatusEnum.PAID;
      }

      // Accepting an InstaPay order is staff's manual verification of its proof.
      const postPendingStatuses = [
        orderStatusEnum.ACCEPTED,
        orderStatusEnum.SHIPPED,
        orderStatusEnum.DELIVERED,
      ];
      if (
        postPendingStatuses.includes(newStatus) &&
        order.substitutionState ===
          orderSubstitutionStateEnum.INSTAPAY_SUBMITTED
      ) {
        await finalizeSubstitutionInstapayOnOrderAcceptance({
          order,
          actorUserId,
          session,
        });
      }

      // The additional substitution transfer is finalized first above. Any
      // remaining submitted InstaPay balance is the original order transfer.
      if (
        postPendingStatuses.includes(newStatus) &&
        order.paymentMethod === paymentMethodEnum.INSTAPAY &&
        order.paymentStatus !== paymentStatusEnum.PAID
      ) {
        const submittedPiastres =
          order.settlement?.instapaySubmittedPiastres || 0;
        if (submittedPiastres > 0) {
          order.settlement.instapaySubmittedPiastres = 0;
          order.settlement.instapayConfirmedPiastres =
            (order.settlement.instapayConfirmedPiastres || 0) +
            submittedPiastres;
          order.settlement.revision = (order.settlement.revision || 0) + 1;
          assertSettlementInvariant(order.settlement);
        }
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
      let walletDeductedForPoints = 0;
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

        walletDeductedForPoints = deductionResult.walletDeducted || 0;

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

        // Explicitly deduct the loyalty deficit from the wallet for cancellations
        // (Returns handle this by subtracting it from the wallet refund)
        if (isCancelling && walletDeductedForPoints > 0) {
          await UserModel.updateOne(
            { _id: order.user },
            { $inc: { walletBalance: -walletDeductedForPoints } },
            { session },
          );

          const userAfterDeduct = await UserModel.findById(order.user)
            .session(session)
            .select("walletBalance");

          await WalletTransactionModel.create(
            [
              {
                user: order.user,
                amount: -walletDeductedForPoints,
                type: "ORDER_DEBIT",
                referenceType: "ORDER",
                referenceId: order._id,
                balanceAfter: userAfterDeduct?.walletBalance ?? 0,
                note: `Loyalty points deficit recovery for cancelled order ${order.orderNumber}`,
              },
            ],
            { session },
          );
        }
      }

      // Cancellation: refund the payment-method portion (card only)
      // Card → wallet for users, Paymob refund for guests (handled after txn)
      // InstaPay → manual refund (admin contacts customer)
      // COD / POS → nothing to refund (not paid yet)
      const shouldRefundCardPayment =
        isCancelling &&
        order.sideEffectsCommitted !== false &&
        order.paymentStatus === paymentStatusEnum.PAID &&
        order.paymentMethod === paymentMethodEnum.CARD;

      if (shouldRefundCardPayment) {
        const isGuest = !order.user;
        // A prior registered substitution credit first offsets wallet money,
        // then any captured card money. Guest pending refund liabilities are
        // excluded because their queued operation settles them separately.
        const paymentPortion = order.settlement
          ? fromPiastres(
              cancellationSettlementRefunds.cardRefundPiastres,
            )
          : Math.max(
              0,
              typeof order.total === "number" ? order.total : 0,
            );

        if (!isGuest && paymentPortion > 0) {
          // Registered user: credit the card portion to wallet
          // The loyalty deficit was already deducted explicitly above for a
          // cancellation, so it must not be removed from the card refund too.
          const netRefund = paymentPortion;

          if (netRefund > 0) {
            await UserModel.updateOne(
              { _id: order.user },
              { $inc: { walletBalance: netRefund } },
              { session },
            );

            const userAfterPaymentRefund = await UserModel.findById(order.user)
              .session(session)
              .select("walletBalance");

            await WalletTransactionModel.create(
              [
                {
                  user: order.user,
                  amount: netRefund,
                  type: "ORDER_CARD_REFUND",
                  referenceType: "ORDER",
                  referenceId: order._id,
                  balanceAfter: userAfterPaymentRefund?.walletBalance ?? 0,
                  note: `Refund of card payment for cancelled order ${order.orderNumber}`,
                },
              ],
              { session },
            );
          }
        }

        // Mark as refunded for card payments
        order.paymentStatus = paymentStatusEnum.REFUNDED;
      }

      // Return: refund to wallet only for Card users
      // Card (user) → subtotal - discount → wallet
      // Card (guest) → Paymob refund (handled after txn)
      // COD / POS / InstaPay → manual refund (admin contacts customer)
      if (
        isReturning &&
        order.paymentMethod === paymentMethodEnum.CARD
      ) {
        if (order.user) {
          // Registered user: credit items value to wallet
          const subtotal =
            typeof order.subtotal === "number" ? order.subtotal : 0;
          const discountAmount =
            typeof order.discountAmount === "number" ? order.discountAmount : 0;
          const grossRefund = Math.max(0, subtotal - discountAmount);
          const refundToWallet = Math.max(
            0,
            grossRefund - walletDeductedForPoints,
          );

          if (refundToWallet > 0) {
            await UserModel.updateOne(
              { _id: order.user },
              { $inc: { walletBalance: refundToWallet } },
              { session },
            );

            const userAfterRefund = await UserModel.findById(order.user)
              .session(session)
              .select("walletBalance");

            await WalletTransactionModel.create(
              [
                {
                  user: order.user,
                  amount: refundToWallet,
                  type: "ORDER_REFUND",
                  referenceType: "ORDER",
                  referenceId: order._id,
                  balanceAfter: userAfterRefund?.walletBalance ?? 0,
                  note:
                    walletDeductedForPoints > 0
                      ? `Refund for returned order ${order.orderNumber} (${grossRefund} EGP - ${walletDeductedForPoints} EGP loyalty points recovery)`
                      : `Refund for returned order ${order.orderNumber}`,
                },
              ],
              { session },
            );
          }
        }

        // Mark as refunded for card payments (user + guest)
        order.paymentStatus = paymentStatusEnum.REFUNDED;
      }

      // A guest card order can have the original capture plus one successful
      // substitution top-up capture. Materialize the manual reconciliation in
      // this same transaction before committing the terminal order status.
      // This intentionally never sends their aggregate against the original
      // Paymob transaction.
      if (
        (isCancelling || isReturning) &&
        !order.user &&
        order.paymentMethod === paymentMethodEnum.CARD &&
        order.paymobTransactionId
      ) {
        const successfulSubstitutionCaptures =
          await OrderPaymentAttemptModel.find({
            order: order._id,
            successAccepted: true,
            status: orderPaymentAttemptStatusEnum.SUCCEEDED,
            paymobTransactionId: { $exists: true, $ne: "" },
          })
            .session(session)
            .select("substitutionRequest paymobTransactionId amountPiastres");
        if (
          requiresManualGuestMultiCaptureRefund({
            order,
            paymentAttempts: successfulSubstitutionCaptures,
          })
        ) {
          await queueManualGuestMultiCaptureRefund({
            order,
            paymentAttempts: successfulSubstitutionCaptures,
            refundAmountPiastres:
              deriveGuestCardDirectRefundAmountPiastres(order),
            session,
          });
        }
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

  // Invalidate product caches after stock restoration
  if (
    updated &&
    (updated.status === orderStatusEnum.CANCELLED ||
      updated.status === orderStatusEnum.RETURNED)
  ) {
    const productIds = (updated.items || []).map((i) => i.product);
    await invalidateProductCaches(productIds);

    if (stockWasRestored) {
      processRestockedOrderProductsBestEffort(productIds, updated.warehouse);
    }
  }

  const directRefundAmountPiastres =
    deriveGuestCardDirectRefundAmountPiastres(updated);
  const queuedManualMultiCaptureRefund = Boolean(
    updated?.multiCaptureRefundReconciliationOperation,
  );

  // Guest + card: refund one original capture via Paymob (external API, outside
  // the transaction). Feature orders with multiple captures take the durable
  // manual branch above instead.
  if (
    updated &&
    !queuedManualMultiCaptureRefund &&
    (updated.status === orderStatusEnum.CANCELLED ||
      updated.status === orderStatusEnum.RETURNED) &&
    !updated.user &&
    updated.paymentMethod === paymentMethodEnum.CARD &&
    updated.paymentStatus === paymentStatusEnum.REFUNDED &&
    updated.paymobTransactionId
  ) {
    // Cancelled = refund full total; Returned = refund items only (no shipping)
    const refundAmount = fromPiastres(directRefundAmountPiastres);

    if (refundAmount > 0) {
      const refundAmountCents = Math.round(refundAmount * 100);
      try {
        const result = await refundTransaction({
          transactionId: updated.paymobTransactionId,
          amountCents: refundAmountCents,
        });

        if (result.refundTransactionId) {
          await OrderModel.updateOne(
            { _id: updated._id },
            { paymobRefundTransactionId: result.refundTransactionId },
          );
        }

        console.log(
          `[Order] Card refund successful for ${updated.status} order ${updated.orderNumber} (${refundAmount} EGP) — refund txn ${result.refundTransactionId}`,
        );
      } catch (err) {
        console.error(
          `[Order] Card refund FAILED for ${updated.status} order ${updated.orderNumber}:`,
          err.message,
        );
        // The status change is already committed. Admin must manually resolve.
      }
    }
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
    { session, returnDocument: "after", select: "loyaltyPoints" },
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
      if (freshOrder.settlement) {
        const capturedPiastres = freshOrder.settlement.cardDuePiastres || 0;
        freshOrder.settlement.cardDuePiastres = 0;
        freshOrder.settlement.cardCapturedPiastres =
          (freshOrder.settlement.cardCapturedPiastres || 0) +
          capturedPiastres;
        freshOrder.settlement.revision =
          (freshOrder.settlement.revision || 0) + 1;
        assertSettlementInvariant(freshOrder.settlement);
      }

      freshOrder.history = Array.isArray(freshOrder.history)
        ? freshOrder.history
        : [];
      freshOrder.history.push({
        at: new Date(),
        description: "Payment confirmed — Order is pending",
        visibleToUser: true,
      });

      // Feature-enabled card orders can still change while pending. Defer the
      // award until staff acceptance, after any substitution is final.
      if (!shouldDeferCardLoyaltyUntilAcceptance(freshOrder)) {
        await awardLoyaltyPointsForOrder(freshOrder, session);
      }

      await freshOrder.save({ session });
    });
  } finally {
    session.endSession();
  }

  // Invalidate product caches after stock decrement
  const productIds = (order.items || []).map((i) => i.product);
  await invalidateProductCaches(productIds);

  // Notify admins/moderators about the new order
  const updatedOrder = await OrderModel.findById(order._id);
  if (updatedOrder) {

    sendNewOrderNotificationToAdminsAndModerators(updatedOrder).catch((err) =>
      console.error(
        "[Order] Failed to send new order notification to admins/moderators:",
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

      // Rotate checkoutKey on cart so user can place new orders
      const cartFilter = order.user
        ? { user: order.user }
        : { guestId: order.guestId };
      await CartModel.updateOne(cartFilter, {
        $set: { checkoutKey: generateCheckoutKey() },
      });
    } catch (err) {
      // Side effects failed (stock exhausted, wallet insufficient, etc.)
      console.error(
        `[Order] commitOrderSideEffects failed for ${order.orderNumber}: ${err.message}`,
      );

      order.status = orderStatusEnum.FAILED;
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
            { returnDocument: "after" },
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
          notification: {
            title_en: "Order could not be completed",
            title_ar: "لم يتم إتمام الطلب",
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

  // Rotate checkoutKey on cart so user can place new orders
  const cartFilter = order.user
    ? { user: order.user }
    : { guestId: order.guestId };
  await CartModel.updateOne(cartFilter, {
    $set: { checkoutKey: generateCheckoutKey() },
  });


  sendNewOrderNotificationToAdminsAndModerators(order).catch((err) =>
    console.error(
      "[Order] Failed to send new order notification to admins/moderators:",
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
  let stockWasRestored = false;

  try {
    await session.withTransaction(async () => {
      const freshOrder = await OrderModel.findById(orderId).session(session);
      if (!freshOrder) return;
      if (freshOrder.status !== orderStatusEnum.AWAITING_PAYMENT) return;

      await restoreStockForOrder({ session, order: freshOrder });
      stockWasRestored = true;

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

    if (stockWasRestored) {
      processRestockedOrderProductsBestEffort(
        productIds,
        freshOrder.warehouse,
      );
    }
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
