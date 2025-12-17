import asyncHandler from "express-async-handler";
import { getWalletTransactionsService, getWalletTransactionsForAdminService } from "./wallet.service.js";

export const getWalletTransactions = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { page, limit } = req.query;

  const result = await getWalletTransactionsService({ userId, page, limit });

  res.status(200).json({ data: result });
});

export const getWalletTransactionsForAdmin = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { page, limit } = req.query;

  const result = await getWalletTransactionsForAdminService({ userId, page, limit });

  res.status(200).json({ data: result });
});
