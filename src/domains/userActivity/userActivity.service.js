// src/domains/userActivity/userActivity.service.js
import mongoose from "mongoose";
import { UserModel } from "../user/user.model.js";
import { OrderModel } from "../order/order.model.js";
import { CartModel } from "../cart/cart.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import { LoyaltyTransactionModel } from "../loyalty/loyaltyTransaction.model.js";
import { ReturnRequestModel } from "../return/return.model.js";
import { ServiceReservationModel } from "../serviceReservation/reservations/serviceReservation.model.js";
import { PetModel } from "../pet/pet.model.js";
import { FavoriteModel } from "../favorite/favorite.model.js";
import { ReviewModel } from "../review/review.model.js";
import { AddressModel } from "../address/address.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  orderStatusEnum,
  cartStatusEnum,
  returnStatusEnum,
} from "../../shared/constants/enums.js";

const { ObjectId } = mongoose.Types;

// ─── Helper: safely cast to ObjectId ────────────────────────────────
function toObjectId(id) {
  return typeof id === "string" ? new ObjectId(id) : id;
}

// ─── Individual aggregation builders ────────────────────────────────
// Each returns a promise. All run concurrently via Promise.all.

function aggregateOrders(userId) {
  return OrderModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              totalSpent: {
                $sum: {
                  $cond: [
                    {
                      $not: {
                        $in: [
                          "$status",
                          [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED],
                        ],
                      },
                    },
                    "$total",
                    0,
                  ],
                },
              },
              avgOrderValue: {
                $avg: {
                  $cond: [
                    {
                      $not: {
                        $in: [
                          "$status",
                          [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED],
                        ],
                      },
                    },
                    "$total",
                    "$$REMOVE",
                  ],
                },
              },
              lastOrderAt: { $max: "$createdAt" },
              couponUsageCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$couponCode", null] },
                        { $ne: ["$couponCode", ""] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        statusBreakdown: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ],
        paymentMethodBreakdown: [
          { $group: { _id: "$paymentMethod", count: { $sum: 1 } } },
        ],
      },
    },
  ]).then(([result]) => {
    const stats = result.stats[0] || {
      totalOrders: 0,
      totalSpent: 0,
      avgOrderValue: 0,
      lastOrderAt: null,
      couponUsageCount: 0,
    };

    const statusBreakdown = {};
    for (const s of result.statusBreakdown) {
      statusBreakdown[s._id] = s.count;
    }

    const paymentMethodBreakdown = {};
    for (const p of result.paymentMethodBreakdown) {
      paymentMethodBreakdown[p._id] = p.count;
    }

    return {
      totalOrders: stats.totalOrders,
      totalSpent: Math.round((stats.totalSpent || 0) * 100) / 100,
      avgOrderValue: Math.round((stats.avgOrderValue || 0) * 100) / 100,
      lastOrderAt: stats.lastOrderAt,
      couponUsageCount: stats.couponUsageCount,
      statusBreakdown,
      paymentMethodBreakdown,
    };
  });
}

function aggregateReturns(userId) {
  return ReturnRequestModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalRequests: { $sum: 1 },
              totalRefundAmount: { $sum: "$refundAmount" },
            },
          },
        ],
        statusBreakdown: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ],
      },
    },
  ]).then(([result]) => {
    const stats = result.stats[0] || {
      totalRequests: 0,
      totalRefundAmount: 0,
    };

    const statusBreakdown = {};
    for (const s of result.statusBreakdown) {
      statusBreakdown[s._id] = s.count;
    }

    return {
      totalRequests: stats.totalRequests,
      totalRefundAmount:
        Math.round((stats.totalRefundAmount || 0) * 100) / 100,
      statusBreakdown,
    };
  });
}

function aggregateWallet(userId) {
  return WalletTransactionModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalCredited: {
          $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
        },
        totalDebited: {
          $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]).then((results) => {
    const stats = results[0] || {
      totalCredited: 0,
      totalDebited: 0,
      transactionCount: 0,
    };
    return {
      totalCredited: Math.round((stats.totalCredited || 0) * 100) / 100,
      totalDebited: Math.round(Math.abs(stats.totalDebited || 0) * 100) / 100,
      transactionCount: stats.transactionCount,
    };
  });
}

function aggregateLoyalty(userId) {
  return LoyaltyTransactionModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalEarned: {
          $sum: {
            $cond: [{ $eq: ["$type", "EARNED"] }, "$points", 0],
          },
        },
        totalRedeemed: {
          $sum: {
            $cond: [{ $eq: ["$type", "REDEEMED"] }, "$points", 0],
          },
        },
        totalDeducted: {
          $sum: {
            $cond: [{ $eq: ["$type", "DEDUCTED"] }, "$points", 0],
          },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]).then((results) => {
    const stats = results[0] || {
      totalEarned: 0,
      totalRedeemed: 0,
      totalDeducted: 0,
      transactionCount: 0,
    };
    return {
      totalEarned: stats.totalEarned,
      totalRedeemed: stats.totalRedeemed,
      totalDeducted: stats.totalDeducted,
      transactionCount: stats.transactionCount,
    };
  });
}

function getWalletHistory(userId) {
  return WalletTransactionModel.find({ user: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .select("-_id amount type referenceType referenceId balanceAfter note createdAt")
    .lean();
}

function getLoyaltyHistory(userId, lang = "en") {
  return LoyaltyTransactionModel.find({ user: toObjectId(userId) })
    .sort({ createdAt: -1 })
    .select("-_id points type referenceType referenceId balanceAfter description_en description_ar createdAt")
    .lean()
    .then((transactions) =>
      transactions.map((t) => {
        const { description_en, description_ar, ...rest } = t;
        return {
          ...rest,
          description: lang === "ar" ? (description_ar || description_en) : (description_en || description_ar),
        };
      }),
    );
}

function getCartSummary(userId) {
  return CartModel.findOne({
    user: toObjectId(userId),
    status: cartStatusEnum.ACTIVE,
  })
    .select("items totalCartPrice lastActivityAt")
    .lean()
    .then((cart) => {
      if (!cart) {
        return {
          hasActiveCart: false,
          itemCount: 0,
          cartTotal: 0,
          lastActivityAt: null,
        };
      }
      const items = Array.isArray(cart.items) ? cart.items : [];
      return {
        hasActiveCart: true,
        itemCount: items.length,
        cartTotal: cart.totalCartPrice || 0,
        lastActivityAt: cart.lastActivityAt || null,
      };
    });
}

function aggregateServiceReservations(userId) {
  return ServiceReservationModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $facet: {
        stats: [
          {
            $group: {
              _id: null,
              totalBookings: { $sum: 1 },
              totalSpentOnServices: { $sum: "$servicePrice" },
              lastBookingAt: { $max: "$createdAt" },
            },
          },
        ],
        statusBreakdown: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ],
      },
    },
  ]).then(([result]) => {
    const stats = result.stats[0] || {
      totalBookings: 0,
      totalSpentOnServices: 0,
      lastBookingAt: null,
    };

    const statusBreakdown = {};
    for (const s of result.statusBreakdown) {
      statusBreakdown[s._id] = s.count;
    }

    return {
      totalBookings: stats.totalBookings,
      totalSpentOnServices:
        Math.round((stats.totalSpentOnServices || 0) * 100) / 100,
      lastBookingAt: stats.lastBookingAt,
      statusBreakdown,
    };
  });
}

function getPetsSummary(userId) {
  return PetModel.find({ petOwner: toObjectId(userId) })
    .select("name type breed")
    .lean()
    .then((pets) => ({
      total: pets.length,
      list: pets.map((p) => ({
        name: p.name,
        type: p.type,
        breed: p.breed || null,
      })),
    }));
}

function getFavoritesCount(userId) {
  return FavoriteModel.findOne({ user: toObjectId(userId) })
    .select("items")
    .lean()
    .then((fav) => ({
      totalItems: fav && Array.isArray(fav.items) ? fav.items.length : 0,
    }));
}

function aggregateReviews(userId) {
  return ReviewModel.aggregate([
    { $match: { user: toObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalReviews: { $sum: 1 },
        avgRatingGiven: { $avg: "$rating" },
      },
    },
  ]).then((results) => {
    const stats = results[0] || { totalReviews: 0, avgRatingGiven: 0 };
    return {
      totalReviews: stats.totalReviews,
      avgRatingGiven:
        Math.round((stats.avgRatingGiven || 0) * 100) / 100,
    };
  });
}

function getAddressCount(userId) {
  return AddressModel.countDocuments({ user: toObjectId(userId) }).then(
    (count) => ({ totalSaved: count }),
  );
}

// ─── Main service ───────────────────────────────────────────────────

export async function getUserActivityService(userId, lang = "en") {
  // First, fetch the user to verify existence and extract metadata
  const user = await UserModel.findById(userId)
    .select(
      "name email phone image role account_status signupProvider phoneVerified active createdAt authProviders walletBalance loyaltyPoints",
    )
    .lean();

  if (!user) {
    throw new ApiError(`No user found for this id: ${userId}`, 404);
  }

  // Run ALL aggregations in parallel for maximum performance
  const [
    orders,
    returns,
    walletAgg,
    loyaltyAgg,
    walletHistory,
    loyaltyHistory,
    cart,
    serviceReservations,
    pets,
    favorites,
    reviews,
    addresses,
  ] = await Promise.all([
    aggregateOrders(userId),
    aggregateReturns(userId),
    aggregateWallet(userId),
    aggregateLoyalty(userId),
    getWalletHistory(userId),
    getLoyaltyHistory(userId, lang),
    getCartSummary(userId),
    aggregateServiceReservations(userId),
    getPetsSummary(userId),
    getFavoritesCount(userId),
    aggregateReviews(userId),
    getAddressCount(userId),
  ]);

  return {
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      image: user.image,
      role: user.role,
      accountStatus: user.account_status,
      signupProvider: user.signupProvider,
      phoneVerified: user.phoneVerified,
      registeredAt: user.createdAt,
      active: user.active,
    },
    orders: {
      ...orders,
      totalRefunded: returns.totalRefundAmount,
    },
    wallet: {
      currentBalance: user.walletBalance || 0,
      ...walletAgg,
      history: walletHistory,
    },
    loyalty: {
      currentPoints: user.loyaltyPoints || 0,
      ...loyaltyAgg,
      history: loyaltyHistory,
    },
    cart,
    returns,
    serviceReservations,
    pets,
    favorites,
    reviews,
    addresses,
  };
}
