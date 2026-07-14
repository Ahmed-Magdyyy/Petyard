import asyncHandler from "express-async-handler";
import {
  adjustWalletBalanceForAdminService,
  getWalletTransactionsService,
  getWalletTransactionsForAdminService,
} from "./wallet.service.js";

export const getWalletTransactions = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { page, limit } = req.query;
  const lang = req.lang;

  const result = await getWalletTransactionsService({
    userId,
    page,
    limit,
    lang,
  });

  res.status(200).json({ data: result });
});

export const getWalletTransactionsForAdmin = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { page, limit } = req.query;
  const lang = req.lang;

  const result = await getWalletTransactionsForAdminService({
    userId,
    page,
    limit,
    lang,
  });

  res.status(200).json({ data: result });
});

export const adjustWalletBalanceForAdmin = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { amount, comment } = req.body;
  const adminId = req.user?._id;

  const result = await adjustWalletBalanceForAdminService({
    userId,
    adminId,
    amount,
    comment,
  });

  res.status(201).json({ data: result });
});
