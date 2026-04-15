import { SavedCardModel } from "./savedCard.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";

export async function getUserSavedCardsService(userId) {
  const cards = await SavedCardModel.find({ user: userId })
    .select("-paymobToken")
    .sort({ createdAt: -1 })
    .lean();

  return cards.map((card) => ({
    id: card._id,
    lastFour: card.lastFour,
    brand: card.brand,
    expiryMonth: card.expiryMonth || null,
    expiryYear: card.expiryYear || null,
    createdAt: card.createdAt,
  }));
}

export async function getSavedCardTokenService(userId, cardId) {
  const card = await SavedCardModel.findOne({ _id: cardId, user: userId });
  if (!card) {
    throw new ApiError("Saved card not found", 404);
  }
  return card.paymobToken;
}

export async function getUserSavedCardTokensService(userId) {
  const cards = await SavedCardModel.find({ user: userId }).select("paymobToken").lean();
  return cards.map(c => c.paymobToken).filter(Boolean);
}

export async function saveCardFromTransaction(userId, transactionData) {
  if (!transactionData.cardToken || !transactionData.sourceData?.pan) {
    return null;
  }

  const existing = await SavedCardModel.findOne({
    user: userId,
    paymobToken: transactionData.cardToken,
  });

  if (existing) return existing;

  return SavedCardModel.create({
    user: userId,
    paymobToken: transactionData.cardToken,
    lastFour: transactionData.sourceData.pan,
    brand: transactionData.sourceData.subType || "",
    expiryMonth: transactionData.expiryMonth || null,
    expiryYear: transactionData.expiryYear || null,
  });
}

export async function deleteUserSavedCardService(userId, cardId) {
  const card = await SavedCardModel.findOne({ _id: cardId, user: userId });
  if (!card) {
    throw new ApiError("Saved card not found", 404);
  }
  await SavedCardModel.deleteOne({ _id: cardId });
}
