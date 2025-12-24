import { ApiError } from "../../shared/utils/ApiError.js";
import { WalletTransactionModel } from "./walletTransaction.model.js";
import { UserModel } from "../user/user.model.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";

export async function getWalletTransactionsService({ userId, page = 1, limit = 20 }) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [transactions, totalCount] = await Promise.all([
    WalletTransactionModel.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    WalletTransactionModel.countDocuments({ user: userId }),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: transactions.length,
    data: transactions,
  };
}

export async function getWalletTransactionsForAdminService({ userId, page = 1, limit = 20 }) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const user = await UserModel.findById(userId).select("_id");
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [transactions, totalCount] = await Promise.all([
    WalletTransactionModel.find({ user: userId })
      .populate("user", "name phone email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    WalletTransactionModel.countDocuments({ user: userId }),
  ]);

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: transactions.length,
    data: transactions,
  };
}
