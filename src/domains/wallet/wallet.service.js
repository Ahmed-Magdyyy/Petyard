import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { WalletTransactionModel } from "./walletTransaction.model.js";
import { UserModel } from "../user/user.model.js";
import { buildPagination } from "../../shared/utils/apiFeatures.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { dispatchNotification } from "../notification/notificationDispatcher.js";
import { roles } from "../../shared/constants/enums.js";

function normalizeWalletAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new ApiError("amount must be a number", 400);
  }

  const roundedAmount = Math.round(amount * 100) / 100;
  if (roundedAmount === 0) {
    throw new ApiError("amount must be a non-zero number", 400);
  }

  return roundedAmount;
}

function normalizeComment(value) {
  const comment = typeof value === "string" ? value.trim() : "";
  if (!comment) {
    throw new ApiError("comment is required", 400);
  }

  if (comment.length > 500) {
    throw new ApiError("comment must be at most 500 characters", 400);
  }

  return comment;
}

function formatWalletAmount(amount) {
  const absoluteAmount = Math.abs(amount);
  return Number.isInteger(absoluteAmount)
    ? String(absoluteAmount)
    : absoluteAmount.toFixed(2);
}

function formatWalletTransaction(transaction, lang = "en") {
  const description =
    transaction.note ||
    pickLocalizedField(transaction, "description", lang) ||
    transaction.description ||
    "";

  return {
    ...transaction,
    description,
  };
}

function buildManualAdjustmentNotification({ amount, comment, transactionId }) {
  const isCredit = amount > 0;
  const displayAmount = formatWalletAmount(amount);

  return {
    userNotification: {
      title_en: isCredit ? "Wallet Balance Added" : "Wallet Balance Deducted",
      title_ar: isCredit ? "تمت إضافة رصيد للمحفظة" : "تم خصم رصيد من المحفظة",
      body_en: isCredit
        ? `${displayAmount} EGP has been added to your wallet. Reason: ${comment}`
        : `${displayAmount} EGP has been deducted from your wallet. Reason: ${comment}`,
      body_ar: isCredit
        ? `تمت إضافة ${displayAmount} جنيه إلى محفظتك. السبب: ${comment}`
        : `تم خصم ${displayAmount} جنيه من محفظتك. السبب: ${comment}`,
    },
    action: {
      type: "screen",
      screen: "WalletScreen",
      params: {},
    },
    source: {
      domain: "wallet",
      event: isCredit ? "admin_credit" : "admin_debit",
      referenceId: String(transactionId),
    },
  };
}

export async function getWalletTransactionsService({
  userId,
  page = 1,
  limit = 20,
  lang = "en",
}) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 20);

  const [transactions, totalCount] = await Promise.all([
    WalletTransactionModel.find({ user: userId })
      .select("-createdBy")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    WalletTransactionModel.countDocuments({ user: userId }),
  ]);

  const formattedData = transactions.map((transaction) =>
    formatWalletTransaction(transaction, lang),
  );

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: formattedData.length,
    data: formattedData,
  };
}

export async function getWalletTransactionsForAdminService({
  userId,
  page = 1,
  limit = 20,
  lang = "en",
}) {
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
      .populate("createdBy", "name role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    WalletTransactionModel.countDocuments({ user: userId }),
  ]);

  const formattedData = transactions.map((transaction) =>
    formatWalletTransaction(transaction, lang),
  );

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: formattedData.length,
    data: formattedData,
  };
}

export async function adjustWalletBalanceForAdminService({
  userId,
  adminId,
  amount,
  comment,
}) {
  if (!userId) {
    throw new ApiError("User ID is required", 400);
  }

  if (!adminId) {
    throw new ApiError("Admin ID is required", 400);
  }

  const adjustmentAmount = normalizeWalletAmount(amount);
  const adjustmentComment = normalizeComment(comment);
  const referenceId = new mongoose.Types.ObjectId();
  const session = await mongoose.startSession();

  let updatedUser;
  let transaction;

  try {
    await session.withTransaction(async () => {
      const targetUser = await UserModel.findById(userId)
        .session(session)
        .select("_id role walletBalance");

      if (!targetUser) {
        throw new ApiError("User not found", 404);
      }

      if (targetUser.role !== roles.USER) {
        throw new ApiError(
          "Wallet adjustments can only target user accounts",
          400,
        );
      }

      const updateFilter = { _id: userId, role: roles.USER };

      if (adjustmentAmount < 0) {
        updateFilter.walletBalance = { $gte: Math.abs(adjustmentAmount) };
      }

      updatedUser = await UserModel.findOneAndUpdate(
        updateFilter,
        { $inc: { walletBalance: adjustmentAmount } },
        { new: true, session },
      )
        .select("_id name phone email role walletBalance")
        .lean();

      if (!updatedUser) {
        throw new ApiError(
          "Insufficient wallet balance for this adjustment",
          400,
        );
      }

      const [createdTransaction] = await WalletTransactionModel.create(
        [
          {
            user: userId,
            amount: adjustmentAmount,
            type: "ADMIN_ADJUST",
            referenceType: "ADMIN",
            referenceId,
            balanceAfter: updatedUser.walletBalance ?? 0,
            note: adjustmentComment,
            description: adjustmentComment,
            description_en:
              adjustmentAmount > 0
                ? `Manual wallet credit: ${adjustmentComment}`
                : `Manual wallet debit: ${adjustmentComment}`,
            description_ar:
              adjustmentAmount > 0
                ? `إضافة رصيد يدوية: ${adjustmentComment}`
                : `خصم رصيد يدوي: ${adjustmentComment}`,
            createdBy: adminId,
          },
        ],
        { session },
      );

      transaction = createdTransaction.toObject();
    });
  } finally {
    session.endSession();
  }

  const { userNotification, action, source } = buildManualAdjustmentNotification({
    amount: adjustmentAmount,
    comment: adjustmentComment,
    transactionId: transaction._id,
  });

  let notification = null;
  try {
    notification = await dispatchNotification({
      userId,
      notification: userNotification,
      icon: "wallet",
      action,
      source,
      channels: { push: true, inApp: true },
    });
  } catch (err) {
    console.error(
      "[Wallet] Failed to dispatch manual wallet adjustment notification:",
      err.message,
    );
    notification = { success: false, error: err.message };
  }

  return {
    user: updatedUser,
    transaction: formatWalletTransaction(transaction),
    notification,
  };
}
