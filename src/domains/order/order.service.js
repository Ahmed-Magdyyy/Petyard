import mongoose from "mongoose";
import { ApiError } from "../../shared/ApiError.js";
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
import { deleteCacheKey } from "../../shared/cache.js";
import {
  findActiveCouponByCodeService,
  computeCouponEffect,
} from "../coupon/coupon.service.js";
import { sendOrderStatusChangedNotification } from "../notification/notification.service.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { calculateLoyaltyPointsForOrder } from "../loyalty/loyalty.service.js";
import { LoyaltyTransactionModel } from "../loyalty/loyaltyTransaction.model.js";

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
    ...new Set((productIds || []).map((id) => (id ? String(id) : null)).filter(Boolean)),
  ];

  if (!uniqueIds.length) return;

  await Promise.all(
    uniqueIds.flatMap((id) => [
      deleteCacheKey(`product:${id}:en`),
      deleteCacheKey(`product:${id}:ar`),
    ])
  );
}

const allowedStatusTransitions = {
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
    itemPrice,
    lineTotal: quantity * itemPrice,
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
    location: src.location
      ? {
          lat: src.location.lat,
          lng: src.location.lng,
        }
      : undefined,
    details: src.details || undefined,
  };
}

async function ensureSufficientStockAndDecrement({ session, cart }) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError("Cart is empty", 400);
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean)
    ),
  ];

  const products = await ProductModel.find({
    _id: { $in: productIds },
  }).session(session);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) {
      throw new ApiError("Product no longer exists", 400);
    }

    if (product.type !== item.productType) {
      throw new ApiError("Product type mismatch for cart item", 400);
    }

    const quantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (quantity <= 0) {
      throw new ApiError("Cart item quantity must be greater than 0", 400);
    }

    if (product.type === "SIMPLE") {
      const stocks = Array.isArray(product.warehouseStocks)
        ? product.warehouseStocks
        : [];
      const stock = stocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse)
      );
      if (!stock || typeof stock.quantity !== "number") {
        throw new ApiError(
          "This product is not available in the selected warehouse",
          400
        );
      }
      if (stock.quantity < quantity) {
        throw new ApiError(
          `Requested quantity exceeds available stock (${stock.quantity})`,
          400
        );
      }
      stock.quantity -= quantity;
    } else {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find(
        (v) => String(v._id) === String(item.variantId)
      );
      if (!variant) {
        throw new ApiError("Variant not found on this product", 404);
      }

      const vStocks = Array.isArray(variant.warehouseStocks)
        ? variant.warehouseStocks
        : [];
      const vStock = vStocks.find(
        (ws) => String(ws.warehouse) === String(cart.warehouse)
      );

      if (!vStock || typeof vStock.quantity !== "number") {
        throw new ApiError(
          "This product variant is not available in the selected warehouse",
          400
        );
      }
      if (vStock.quantity < quantity) {
        throw new ApiError(
          `Requested quantity exceeds available stock (${vStock.quantity})`,
          400
        );
      }
      vStock.quantity -= quantity;
    }
  }

  // Persist updated products
  for (const product of products) {
    await product.save({ session });
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

  const productIds = [
    ...new Set(allItems.map((entry) => entry.productId)),
  ];

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

  await Promise.all(orders.map((order) => order.save()));

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
        .filter(Boolean)
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
        (ws) => String(ws.warehouse) === String(order.warehouse)
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
        (v) => String(v._id) === String(item.variantId)
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
        (ws) => String(ws.warehouse) === String(order.warehouse)
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
    await product.save({ session });
  }
}

async function applyCouponIfAny({ couponCode, userId, subtotal, shippingFee }) {
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
    throw new ApiError("couponCode is required", 400);
  }

  const coupon = await findActiveCouponByCodeService(trimmedCode);

  const allowedUserIds = Array.isArray(coupon.allowedUserIds)
    ? coupon.allowedUserIds
    : [];

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

  const user = await UserModel.findById(userId).session(session).select("walletBalance");
  if (!user) {
    return { walletUsed: 0, finalSubtotal: netSubtotal };
  }

  const walletBalance = typeof user.walletBalance === "number" && user.walletBalance >= 0
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
  const items = Array.isArray(cart.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError("Cart is empty", 400);
  }

  if (!cart.warehouse) {
    throw new ApiError("Cart warehouse is not set", 400);
  }

  const subtotal =
    typeof cart.totalCartPrice === "number" && cart.totalCartPrice > 0
      ? cart.totalCartPrice
      : 0;

  if (subtotal <= 0) {
    throw new ApiError("Cart total must be greater than 0", 400);
  }

  const warehouse = await WarehouseModel.findById(cart.warehouse).session(
    session
  );
  if (!warehouse) {
    throw new ApiError("Warehouse not found for this cart", 404);
  }

  const rawShipping = warehouse.defaultShippingPrice;
  const shippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

  const couponResult = await applyCouponIfAny({
    couponCode,
    userId: couponUserId,
    subtotal,
    shippingFee,
  });

  const netSubtotal = Math.max(0, subtotal - couponResult.discountAmount);
  const netShipping = Math.max(0, shippingFee - couponResult.shippingDiscount);

  const walletResult = await applyWalletIfUser({
    session,
    userId: orderUserId,
    netSubtotal,
  });

  const finalTotal = walletResult.finalSubtotal + netShipping;

  const orderItems = items.map(mapCartItemToOrderItem);

  const deliveryAddress = mapCartDeliveryAddressToOrder(cart, addressUser);
  if (!deliveryAddress) {
    throw new ApiError("Delivery address is not set for this cart", 400);
  }

  await ensureSufficientStockAndDecrement({ session, cart });

  const orderNumber = generateOrderNumber();

  const normalizedLang = normalizeLang(lang);
  const pm = normalizePaymentMethod(paymentMethod);
  void normalizedLang;

  const historyEntry = {
    at: new Date(),
    description: "Order created",
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
    status: orderStatusEnum.PENDING,
    paymentMethod: pm,
    paymentStatus: paymentStatusEnum.PENDING,
    history: [historyEntry],
    notes: notes || undefined,
  };

  const createdOrder = await OrderModel.create([orderDoc], { session }).then(
    (res) => res[0]
  );

  if (walletResult.walletUsed > 0 && orderUserId) {
    const updateResult = await UserModel.updateOne(
      {
        _id: orderUserId,
        walletBalance: { $gte: walletResult.walletUsed },
      },
      { $inc: { walletBalance: -walletResult.walletUsed } },
      { session }
    );

    if (updateResult.matchedCount === 0) {
      throw new ApiError(
        "Insufficient wallet balance or concurrent modification",
        400
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
      { session }
    );
  }

  if (couponResult.couponCode) {
    await CouponModel.updateOne(
      { code: couponResult.couponCode },
      { $inc: { usageCount: 1 } },
      { session }
    );
  }

  cart.items = [];
  cart.totalCartPrice = 0;
  cart.lastActivityAt = new Date();
  cart.status = "ACTIVE";
  await cart.save({ session });

  return createdOrder;
}

export async function createOrderForUserService({
  userId,
  couponCode,
  paymentMethod,
  notes,
  lang = "en",
}) {
  if (!userId) {
    throw new ApiError("userId is required", 400);
  }

  const session = await mongoose.startSession();
  let createdOrder = null;

  try {
    await session.withTransaction(async () => {
      const cart = await CartModel.findOne({ user: userId })
        .session(session)
        .populate("user");

      if (!cart) {
        throw new ApiError("Cart not found", 404);
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

  if (createdOrder) {
    const productIds = Array.isArray(createdOrder.items)
      ? createdOrder.items.map((i) => i.product)
      : [];

    await invalidateProductCaches(productIds);

    // Fire-and-forget notification; no need to await in the main flow
    void sendOrderStatusChangedNotification(createdOrder);
  }

  return createdOrder;
}

export async function createOrderForGuestService({
  guestId,
  couponCode,
  paymentMethod,
  notes,
  lang = "en",
}) {
  if (!guestId) {
    throw new ApiError("guestId is required", 400);
  }

  const session = await mongoose.startSession();
  let createdOrder = null;

  try {
    await session.withTransaction(async () => {
      const cart = await CartModel.findOne({ guestId })
        .session(session)
        .populate("user");

      if (!cart) {
        throw new ApiError("Cart not found", 404);
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

  if (createdOrder) {
    const productIds = Array.isArray(createdOrder.items)
      ? createdOrder.items.map((i) => i.product)
      : [];

    await invalidateProductCaches(productIds);
  }

  return createdOrder;
}

export async function getMyOrdersService({ userId, page, limit, lang = "en" }) {
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (pageNum - 1) * limitNum;

  const filter = { user: userId };

  const totalCount = await OrderModel.countDocuments(filter);
  const orders = await OrderModel.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate({path: "history.byUserId", select: "name role"})

  await rebindOrdersLocalization(orders, lang);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: orders.length,
    data: orders,
  };
}

export async function getMyOrderByIdService({ userId, orderId, lang = "en" }) {
  const order = await OrderModel.findById(orderId).populate({path: "history.byUserId", select: "role name"})
  if (!order || String(order.user) !== String(userId)) {
    throw new ApiError("Order not found", 404);
  }
  await rebindOrdersLocalization(order, lang);
  return order;
}

export async function listOrdersForAdminService(query = {}) {
  const {
    page = 1,
    limit = 20,
    status,
    orderNumber,
    warehouse,
    user,
    guestId,
    from,
    to,
    warehouseScope,
    lang = "en",
  } = query;

  const filter = {};

  const hasWarehouseScope = Array.isArray(warehouseScope);
  if (hasWarehouseScope && warehouseScope.length === 0) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    return {
      totalPages: 1,
      page: pageNum,
      results: 0,
      data: [],
    };
  }

  if (status) {
    const v = String(status).trim().toLowerCase();
    const allowed = Object.values(orderStatusEnum);
    if (allowed.includes(v)) {
      filter.status = v;
    }
  }

  if (orderNumber) {
    filter.orderNumber = orderNumber;
  }

  if (warehouse) {
    if (hasWarehouseScope) {
      const allowed = warehouseScope.some(
        (w) => String(w) === String(warehouse)
      );
      if (!allowed) {
        throw new ApiError("You are not allowed to access this route", 403);
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
      filter.createdAt.$gte = new Date(from);
    }
    if (to) {
      filter.createdAt.$lte = new Date(to);
    }
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (pageNum - 1) * limitNum;

  const totalCount = await OrderModel.countDocuments(filter);
  const orders = await OrderModel.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate({ path: "history.byUserId", select: "name role" });

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
  warehouseScope
) {
  const order = await OrderModel.findById(orderId).populate({
    path: "history.byUserId",
    select: "name role",
  });
  if (!order) {
    throw new ApiError("Order not found", 404);
  }

  if (Array.isArray(warehouseScope)) {
    const allowed = warehouseScope.some(
      (w) => String(w) === String(order.warehouse)
    );
    if (!allowed) {
      throw new ApiError("Order not found", 404);
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
}) {
  const allowed = Object.values(orderStatusEnum);
  if (!allowed.includes(newStatus)) {
    throw new ApiError("Invalid order status", 400);
  }

  const session = await mongoose.startSession();
  let updated;

  try {
    await session.withTransaction(async () => {
      const order = await OrderModel.findById(orderId).session(session);
      if (!order) {
        throw new ApiError("Order not found", 404);
      }

      if (Array.isArray(warehouseScope)) {
        const allowedWarehouse = warehouseScope.some(
          (w) => String(w) === String(order.warehouse)
        );
        if (!allowedWarehouse) {
          throw new ApiError("Order not found", 404);
        }
      }

      const oldStatus = order.status;
      if (oldStatus === newStatus) {
        updated = order;
        return;
      }

      if (!isValidStatusTransition(oldStatus, newStatus)) {
        throw new ApiError(
          `Invalid status transition from ${oldStatus} to ${newStatus}`,
          400
        );
      }

      const shouldRestoreStock =
        newStatus === orderStatusEnum.CANCELLED &&
        oldStatus !== orderStatusEnum.CANCELLED;

      if (shouldRestoreStock) {
        await restoreStockForOrder({ session, order });
      }

      const shouldRefundWallet =
        newStatus === orderStatusEnum.CANCELLED &&
        oldStatus !== orderStatusEnum.CANCELLED &&
        order.user &&
        typeof order.walletUsed === "number" &&
        order.walletUsed > 0;

      if (shouldRefundWallet) {
        await UserModel.updateOne(
          { _id: order.user },
          { $inc: { walletBalance: order.walletUsed } },
          { session }
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
          { session }
        );
      }

      order.status = newStatus;

      // Auto-mark COD payments as paid when delivered
      if (newStatus === orderStatusEnum.DELIVERED && 
          order.paymentMethod === paymentMethodEnum.COD && 
          order.paymentStatus !== paymentStatusEnum.PAID) {
        order.paymentStatus = paymentStatusEnum.PAID;
      }

      // Award loyalty points when order is delivered
      if (newStatus === orderStatusEnum.DELIVERED && order.user) {
        const amountPaid = Math.max(0, order.total || 0);
        const pointsToAward = await calculateLoyaltyPointsForOrder(amountPaid);
        
        if (pointsToAward > 0) {
          const userAfterPoints = await UserModel.findOneAndUpdate(
            { _id: order.user },
            { $inc: { loyaltyPoints: pointsToAward } },
            { session, new: true, select: "loyaltyPoints" }
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
                description: `Earned ${pointsToAward} points from order ${order.orderNumber}`,
              },
            ],
            { session }
          );
        }
      }

      // Deduct loyalty points if order is cancelled/returned after points were awarded
      if ((newStatus === orderStatusEnum.CANCELLED || newStatus === orderStatusEnum.RETURNED) && 
          order.user && 
          order.loyaltyPointsAwarded > 0) {
        const userAfterDeduction = await UserModel.findOneAndUpdate(
          { _id: order.user },
          { $inc: { loyaltyPoints: -order.loyaltyPointsAwarded } },
          { session, new: true, select: "loyaltyPoints" }
        );
        
        await LoyaltyTransactionModel.create(
          [
            {
              user: order.user,
              points: -order.loyaltyPointsAwarded,
              type: "DEDUCTED",
              referenceType: "ORDER",
              referenceId: order._id,
              balanceAfter: Math.max(0, userAfterDeduction?.loyaltyPoints ?? 0),
              description: `Deducted ${order.loyaltyPointsAwarded} points due to ${newStatus} order ${order.orderNumber}`,
            },
          ],
          { session }
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
    void sendOrderStatusChangedNotification(updated);
  }

  return updated;
}
