import asyncHandler from "express-async-handler";
import {
  getLoyaltySettingsService,
  updateLoyaltySettingsService,
  redeemLoyaltyPointsService,
  getLoyaltyTransactionsService,
  getLoyaltyTransactionsForAdminService,
} from "./loyalty.service.js";

export const getLoyaltySettings = asyncHandler(async (req, res) => {
  const settings = await getLoyaltySettingsService();
  res.status(200).json({ data: settings });
});

export const updateLoyaltySettings = asyncHandler(async (req, res) => {
  const { pointsEarnRate, pointsRedeemRate, minPointsToRedeem, isActive } = req.body;

  const settings = await updateLoyaltySettingsService({
    pointsEarnRate,
    pointsRedeemRate,
    minPointsToRedeem,
    isActive,
  });

  res.status(200).json({ data: settings });
});

export const redeemLoyaltyPoints = asyncHandler(async (req, res) => {
  const userId = req.user?._id;

  const result = await redeemLoyaltyPointsService({ userId });

  res.status(200).json({ data: result });
});

export const getLoyaltyTransactions = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { page, limit } = req.query;

  const result = await getLoyaltyTransactionsService({ userId, page, limit });

  res.status(200).json({ data: result });
});

export const getLoyaltyTransactionsForAdmin = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { page, limit } = req.query;

  const result = await getLoyaltyTransactionsForAdminService({ userId, page, limit });

  res.status(200).json({ data: result });
});
