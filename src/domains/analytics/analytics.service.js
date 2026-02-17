import mongoose from "mongoose";
import { OrderModel } from "../order/order.model.js";
import { ServiceReservationModel } from "../serviceReservation/reservations/serviceReservation.model.js";
import { ReturnRequestModel } from "../return/return.model.js";
import { UserModel } from "../user/user.model.js";
import { ProductModel } from "../product/product.model.js";
import { PetModel } from "../pet/pet.model.js";
import { CouponModel } from "../coupon/coupon.model.js";
import { CartModel } from "../cart/cart.model.js";
import { ReviewModel } from "../review/review.model.js";
import { ServiceReviewModel } from "../serviceReservation/reviews/serviceReview.model.js";
import {
  orderStatusEnum,
  serviceReservationStatusEnum,
  returnStatusEnum,
  cartStatusEnum,
} from "../../shared/constants/enums.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_LABELS = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Build a `createdAt` filter from optional `from` / `to` query strings.
 * Returns an empty object for lifetime (no filter).
 */
function buildDateFilter(from, to, field = "createdAt") {
  if (!from || !to) return {};

  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);

  return { [field]: { $gte: start, $lte: end } };
}

/**
 * Build a scope filter for a given field (e.g. `warehouse`, `location`)
 * when the query param is a valid ObjectId.
 */
function buildScopeFilter(fieldName, value) {
  if (!value) return {};
  return { [fieldName]: new mongoose.Types.ObjectId(value) };
}

/**
 * Convert an array of `{ _id, count }` documents to a { key: count } map.
 */
function toKeyCountMap(docs) {
  const map = {};
  for (const { _id, count } of docs) {
    if (_id != null) map[_id] = count;
  }
  return map;
}

/**
 * Safely extract the first doc from an aggregation result,
 * returning `fallback` if empty.
 */
function firstOr(result, fallback = {}) {
  return result.length > 0 ? result[0] : fallback;
}

// ─── 1. Orders Overview ──────────────────────────────────────────────────────

export async function getOrdersOverviewService({ from, to, warehouse }) {
  const dateFilter = buildDateFilter(from, to);
  const scopeFilter = buildScopeFilter("warehouse", warehouse);
  const baseMatch = { ...dateFilter, ...scopeFilter };

  const revenueStatuses = [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED];

  const [kpis, statusDocs, paymentDocs] = await Promise.all([
    // KPIs — exclude cancelled / returned
    OrderModel.aggregate([
      { $match: { ...baseMatch, status: { $nin: revenueStatuses } } },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$total" },
          totalOrders: { $sum: 1 },
          avgOrderValue: { $avg: "$total" },
        },
      },
    ]),

    // Status breakdown — all statuses count
    OrderModel.aggregate([
      { $match: baseMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Sales by payment method — exclude cancelled / returned
    OrderModel.aggregate([
      { $match: { ...baseMatch, status: { $nin: revenueStatuses } } },
      { $group: { _id: "$paymentMethod", total: { $sum: "$total" } } },
    ]),
  ]);

  const kpi = firstOr(kpis, {
    totalSales: 0,
    totalOrders: 0,
    avgOrderValue: 0,
  });

  const salesByPaymentMethod = {};
  for (const { _id, total } of paymentDocs) {
    if (_id != null) salesByPaymentMethod[_id] = total;
  }

  return {
    totalSales: kpi.totalSales,
    totalOrders: kpi.totalOrders,
    avgOrderValue: Math.round((kpi.avgOrderValue || 0) * 100) / 100,
    salesByPaymentMethod,
    statusBreakdown: toKeyCountMap(statusDocs),
  };
}

// ─── 2. Top Products ─────────────────────────────────────────────────────────

export async function getTopProductsService({
  from,
  to,
  warehouse,
  limit = 5,
}) {
  const dateFilter = buildDateFilter(from, to);
  const scopeFilter = buildScopeFilter("warehouse", warehouse);
  const revenueStatuses = [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED];

  const topProducts = await OrderModel.aggregate([
    {
      $match: {
        ...dateFilter,
        ...scopeFilter,
        status: { $nin: revenueStatuses },
      },
    },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product",
        totalIncome: { $sum: "$items.lineTotal" },
        totalQuantitySold: { $sum: "$items.quantity" },
      },
    },
    { $sort: { totalIncome: -1, totalQuantitySold: -1 } },
    { $limit: Number(limit) },
    {
      $lookup: {
        from: "products",
        localField: "_id",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        productId: "$_id",
        name: { $ifNull: ["$product.name_en", "Deleted Product"] },
        imageUrl: {
          $ifNull: [{ $arrayElemAt: ["$product.images.url", 0] }, null],
        },
        totalQuantitySold: 1,
        totalIncome: 1,
      },
    },
  ]);

  return { topProducts };
}

// ─── 3. Services Overview ────────────────────────────────────────────────────

export async function getServicesOverviewService({ from, to, location }) {
  const dateFilter = buildDateFilter(from, to);
  const scopeFilter = buildScopeFilter("location", location);
  const baseMatch = { ...dateFilter, ...scopeFilter };

  const [kpis, statusDocs, typeDocs] = await Promise.all([
    // KPIs — exclude cancelled
    ServiceReservationModel.aggregate([
      {
        $match: {
          ...baseMatch,
          status: { $ne: serviceReservationStatusEnum.CANCELLED },
        },
      },
      {
        $group: {
          _id: null,
          totalIncome: { $sum: "$servicePrice" },
          totalReservations: { $sum: 1 },
          avgReservationValue: { $avg: "$servicePrice" },
        },
      },
    ]),

    // Status breakdown — all statuses
    ServiceReservationModel.aggregate([
      { $match: baseMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Income by service type — exclude cancelled
    ServiceReservationModel.aggregate([
      {
        $match: {
          ...baseMatch,
          status: { $ne: serviceReservationStatusEnum.CANCELLED },
        },
      },
      { $group: { _id: "$serviceType", total: { $sum: "$servicePrice" } } },
    ]),
  ]);

  const kpi = firstOr(kpis, {
    totalIncome: 0,
    totalReservations: 0,
    avgReservationValue: 0,
  });

  const incomeByType = {};
  for (const { _id, total } of typeDocs) {
    if (_id != null) incomeByType[_id] = total;
  }

  return {
    totalIncome: kpi.totalIncome,
    totalReservations: kpi.totalReservations,
    avgReservationValue: Math.round((kpi.avgReservationValue || 0) * 100) / 100,
    incomeByType,
    statusBreakdown: toKeyCountMap(statusDocs),
  };
}

// ─── 4. Stats ────────────────────────────────────────────────────────────────

export async function getStatsService({ from, to }) {
  const dateFilter = buildDateFilter(from, to);
  const revenueStatuses = [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED];

  const [
    orderSalesResult,
    serviceIncomeResult,
    returnStatusDocs,
    returnAmountsResult,
    customerTotal,
    customerNew,
    productCounts,
    petTotal,
    petNew,
    activeCoupons,
    couponUsage,
    productReviewAgg,
    serviceReviewAgg,
    cartCounts,
  ] = await Promise.all([
    // Sales — order total
    OrderModel.aggregate([
      { $match: { ...dateFilter, status: { $nin: revenueStatuses } } },
      { $group: { _id: null, total: { $sum: "$total" } } },
    ]),

    // Sales — service income
    ServiceReservationModel.aggregate([
      {
        $match: {
          ...dateFilter,
          status: { $ne: serviceReservationStatusEnum.CANCELLED },
        },
      },
      { $group: { _id: null, total: { $sum: "$servicePrice" } } },
    ]),

    // Refunds — status breakdown
    ReturnRequestModel.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // Refunds — approved amounts
    ReturnRequestModel.aggregate([
      {
        $match: {
          ...dateFilter,
          status: returnStatusEnum.APPROVED,
        },
      },
      {
        $group: {
          _id: null,
          totalRefundAmount: { $sum: "$refundAmount" },
          totalWalletRefund: { $sum: "$walletRefund" },
        },
      },
    ]),

    // Customers — total active users
    UserModel.countDocuments({ role: "user", active: true }),

    // Customers — registered in period
    from && to
      ? UserModel.countDocuments({
          role: "user",
          ...buildDateFilter(from, to),
        })
      : Promise.resolve(null),

    // Products — total / active / inactive
    ProductModel.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ["$isActive", 1, 0] } },
          inactive: { $sum: { $cond: ["$isActive", 0, 1] } },
        },
      },
    ]),

    // Pets — total
    PetModel.countDocuments(),

    // Pets — registered in period
    from && to
      ? PetModel.countDocuments(buildDateFilter(from, to))
      : Promise.resolve(null),

    // Coupons — active now
    CouponModel.countDocuments({
      isActive: true,
      expiresAt: { $gte: new Date() },
    }),

    // Coupons — usage in period
    from && to
      ? CouponModel.aggregate([
          { $match: dateFilter },
          { $group: { _id: null, totalUsage: { $sum: "$usageCount" } } },
        ])
      : CouponModel.aggregate([
          { $group: { _id: null, totalUsage: { $sum: "$usageCount" } } },
        ]),

    // Reviews — product
    ReviewModel.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgRating: { $avg: "$rating" },
        },
      },
    ]),

    // Reviews — service
    ServiceReviewModel.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgRating: { $avg: "$rating" },
        },
      },
    ]),

    // Carts — active vs abandoned
    CartModel.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);

  // Assemble refunds
  const returnStatusMap = toKeyCountMap(returnStatusDocs);
  const returnAmounts = firstOr(returnAmountsResult, {
    totalRefundAmount: 0,
    totalWalletRefund: 0,
  });
  const totalReturnRequests = Object.values(returnStatusMap).reduce(
    (a, b) => a + b,
    0,
  );

  // Assemble products
  const prodAgg = firstOr(productCounts, {
    total: 0,
    active: 0,
    inactive: 0,
  });

  // Assemble reviews
  const prodReview = firstOr(productReviewAgg, { count: 0, avgRating: 0 });
  const svcReview = firstOr(serviceReviewAgg, { count: 0, avgRating: 0 });

  // Assemble carts
  const cartMap = toKeyCountMap(cartCounts);

  // Assemble coupon usage
  const couponUsageVal = firstOr(couponUsage, { totalUsage: 0 }).totalUsage;

  return {
    sales: {
      totalOrderSales: firstOr(orderSalesResult, { total: 0 }).total,
      totalServiceIncome: firstOr(serviceIncomeResult, { total: 0 }).total,
    },
    refunds: {
      totalReturnRequests,
      pending: returnStatusMap[returnStatusEnum.PENDING] || 0,
      approved: returnStatusMap[returnStatusEnum.APPROVED] || 0,
      rejected: returnStatusMap[returnStatusEnum.REJECTED] || 0,
      totalRefundAmount: returnAmounts.totalRefundAmount,
      totalWalletRefund: returnAmounts.totalWalletRefund,
    },
    customers: {
      total: customerTotal,
      ...(customerNew !== null && { registeredInPeriod: customerNew }),
    },
    products: {
      total: prodAgg.total,
      active: prodAgg.active,
      inactive: prodAgg.inactive,
    },
    pets: {
      total: petTotal,
      ...(petNew !== null && { registeredInPeriod: petNew }),
    },
    coupons: {
      active: activeCoupons,
      totalUsageInPeriod: couponUsageVal,
    },
    reviews: {
      productReviews: prodReview.count,
      serviceReviews: svcReview.count,
      avgProductRating: Math.round((prodReview.avgRating || 0) * 10) / 10,
      avgServiceRating: Math.round((svcReview.avgRating || 0) * 10) / 10,
    },
    carts: {
      active: cartMap[cartStatusEnum.ACTIVE] || 0,
      abandoned: cartMap[cartStatusEnum.ABANDONED] || 0,
    },
  };
}

// ─── 5. Sales Chart ──────────────────────────────────────────────────────────

export async function getSalesChartService({ from, to, warehouse, location }) {
  const orderDateFilter = buildDateFilter(from, to);
  const orderScopeFilter = buildScopeFilter("warehouse", warehouse);

  const serviceDateFilter = buildDateFilter(from, to);
  const serviceScopeFilter = buildScopeFilter("location", location);

  const revenueStatuses = [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED];

  const [orderMonthly, serviceMonthly] = await Promise.all([
    OrderModel.aggregate([
      {
        $match: {
          ...orderDateFilter,
          ...orderScopeFilter,
          status: { $nin: revenueStatuses },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          orderSales: { $sum: "$total" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    ServiceReservationModel.aggregate([
      {
        $match: {
          ...serviceDateFilter,
          ...serviceScopeFilter,
          status: { $ne: serviceReservationStatusEnum.CANCELLED },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          serviceSales: { $sum: "$servicePrice" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
  ]);

  // Merge both streams into a unified chart keyed by year-month
  const chartMap = new Map();

  for (const doc of orderMonthly) {
    const key = `${doc._id.year}-${doc._id.month}`;
    chartMap.set(key, {
      label: MONTH_LABELS[doc._id.month],
      year: doc._id.year,
      month: doc._id.month,
      orderSales: doc.orderSales,
      serviceSales: 0,
    });
  }

  for (const doc of serviceMonthly) {
    const key = `${doc._id.year}-${doc._id.month}`;
    if (chartMap.has(key)) {
      chartMap.get(key).serviceSales = doc.serviceSales;
    } else {
      chartMap.set(key, {
        label: MONTH_LABELS[doc._id.month],
        year: doc._id.year,
        month: doc._id.month,
        orderSales: 0,
        serviceSales: doc.serviceSales,
      });
    }
  }

  // Sort by year, then month
  const chart = [...chartMap.values()].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  return { chart };
}
