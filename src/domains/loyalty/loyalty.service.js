import mongoose from "mongoose";
import { ApiError } from "../../shared/ApiError.js";
import { LoyaltySettingsModel } from "./loyaltySettings.model.js";
import { LoyaltyTransactionModel } from "./loyaltyTransaction.model.js";
import { UserModel } from "../user/user.model.js";
import { WalletTransactionModel } from "../wallet/walletTransaction.model.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";

export async function getLoyaltySettingsService() {
  let settings = await LoyaltySettingsModel.findOne();
  
  if (!settings) {
    settings = await LoyaltySettingsModel.create({
      pointsEarnRate: 1,
      pointsRedeemRate: 10,
      minPointsToRedeem: 500,
      isActive: true,
    });
  }
  
  return {
    pointsEarnRate: settings.pointsEarnRate,
    pointsRedeemRate: settings.pointsRedeemRate,
    minPointsToRedeem: settings.minPointsToRedeem,
    isActive: settings.isActive,
  };
}

export async function updateLoyaltySettingsService({
  pointsEarnRate,
  pointsRedeemRate,
  minPointsToRedeem,
  isActive,
}) {
  let settings = await LoyaltySettingsModel.findOne();
  
  if (!settings) {
    settings = await LoyaltySettingsModel.create({
      pointsEarnRate: pointsEarnRate ?? 1,
      pointsRedeemRate: pointsRedeemRate ?? 10,
      minPointsToRedeem: minPointsToRedeem ?? 500,
      isActive: isActive ?? true,
    });
  } else {
    if (typeof pointsEarnRate === "number" && pointsEarnRate >= 0) {
      settings.pointsEarnRate = pointsEarnRate;
    }
    if (typeof pointsRedeemRate === "number" && pointsRedeemRate >= 1) {
      settings.pointsRedeemRate = pointsRedeemRate;
    }
    if (typeof minPointsToRedeem === "number" && minPointsToRedeem >= 0) {
      settings.minPointsToRedeem = minPointsToRedeem;
    }
    if (typeof isActive === "boolean") {
      settings.isActive = isActive;
    }
    await settings.save();
  }
  
  return {
    pointsEarnRate: settings.pointsEarnRate,
    pointsRedeemRate: settings.pointsRedeemRate,
    minPointsToRedeem: settings.minPointsToRedeem,
    isActive: settings.isActive,
  };
}

export async function calculateLoyaltyPointsForOrder(amountPaid) {
  const settings = await getLoyaltySettingsService();
  
  if (!settings.isActive) {
    return 0;
  }
  
  const paid = Math.max(0, Number(amountPaid) || 0);
  const points = Math.floor(paid * settings.pointsEarnRate);
  
  return points;
}

export async function deductLoyaltyPointsOnReturnService({ userId, pointsToDeduct, session }) {
  if (!userId || !pointsToDeduct || pointsToDeduct <= 0) {
    return { pointsDeducted: 0, walletDeducted: 0 };
  }

  const settings = await getLoyaltySettingsService();
  const user = await UserModel.findById(userId).select("loyaltyPoints walletBalance").session(session);
  
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const currentPoints = Math.max(0, user.loyaltyPoints || 0);
  
  if (currentPoints >= pointsToDeduct) {
    // User has enough points, deduct all from points
    await UserModel.updateOne(
      { _id: userId },
      { $inc: { loyaltyPoints: -pointsToDeduct } },
      { session }
    );
    
    return { pointsDeducted: pointsToDeduct, walletDeducted: 0 };
  } else {
    // User doesn't have enough points, calculate deficit
    const pointsDeficit = pointsToDeduct - currentPoints;
    const walletDeduction = Math.floor(pointsDeficit / settings.pointsRedeemRate);
    
    // Deduct available points and wallet equivalent
    await UserModel.updateOne(
      { _id: userId },
      { 
        $inc: { 
          loyaltyPoints: -currentPoints,
          walletBalance: -walletDeduction 
        } 
      },
      { session }
    );
    
    return { pointsDeducted: currentPoints, walletDeducted: walletDeduction };
  }
}

export async function getLoyaltyTransactionsService({ userId, page = 1, limit = 20 }) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [transactions, totalCount] = await Promise.all([
    LoyaltyTransactionModel.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    LoyaltyTransactionModel.countDocuments({ user: userId }),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: transactions.length,
    data: transactions,
  };
}

export async function getLoyaltyTransactionsForAdminService({ userId, page = 1, limit = 20 }) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const user = await UserModel.findById(userId).select("_id");
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [transactions, totalCount] = await Promise.all([
    LoyaltyTransactionModel.find({ user: userId })
      .populate("user", "name phone email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    LoyaltyTransactionModel.countDocuments({ user: userId }),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: transactions.length,
    data: transactions,
  };
}

export async function redeemLoyaltyPointsService({ userId }) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const settings = await getLoyaltySettingsService();
  
  if (!settings.isActive) {
    throw new ApiError("Loyalty points system is currently disabled", 400);
  }

  const user = await UserModel.findById(userId).select("loyaltyPoints walletBalance");
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const currentPoints = typeof user.loyaltyPoints === "number" ? user.loyaltyPoints : 0;

  if (currentPoints < settings.minPointsToRedeem) {
    throw new ApiError(
      `Minimum ${settings.minPointsToRedeem} points required to redeem. You have ${currentPoints} points.`,
      400
    );
  }

  const walletCredit = Math.floor(currentPoints / settings.pointsRedeemRate);
  const pointsToDeduct = walletCredit * settings.pointsRedeemRate;

  if (walletCredit <= 0) {
    throw new ApiError("Insufficient points for redemption", 400);
  }

  const session = await mongoose.startSession();
  let updatedUser;

  try {
    await session.withTransaction(async () => {
      const updateResult = await UserModel.updateOne(
        {
          _id: userId,
          loyaltyPoints: { $gte: pointsToDeduct },
        },
        {
          $inc: {
            loyaltyPoints: -pointsToDeduct,
            walletBalance: walletCredit,
          },
        },
        { session }
      );

      if (updateResult.matchedCount === 0) {
        throw new ApiError(
          "Insufficient points or concurrent modification",
          400
        );
      }

      updatedUser = await UserModel.findById(userId)
        .select("loyaltyPoints walletBalance")
        .session(session);
      
      await WalletTransactionModel.create(
        [
          {
            user: userId,
            amount: walletCredit,
            type: "POINTS_REDEEM_CREDIT",
            referenceType: "LOYALTY_REDEMPTION",
            referenceId: userId,
            balanceAfter: updatedUser?.walletBalance ?? 0,
            description: `Redeemed ${pointsToDeduct} loyalty points for ${walletCredit} EGP`,
          },
        ],
        { session }
      );
      
      await LoyaltyTransactionModel.create(
        [
          {
            user: userId,
            points: -pointsToDeduct,
            type: "REDEEMED",
            referenceType: "REDEMPTION",
            referenceId: userId,
            balanceAfter: updatedUser?.loyaltyPoints ?? 0,
            description: `Redeemed ${pointsToDeduct} points for ${walletCredit} EGP wallet credit`,
          },
        ],
        { session }
      );
    });
  } finally {
    session.endSession();
  }

  return {
    pointsRedeemed: pointsToDeduct,
    walletCredited: walletCredit,
    remainingPoints: updatedUser?.loyaltyPoints || 0,
    newWalletBalance: updatedUser?.walletBalance || 0,
  };
}
