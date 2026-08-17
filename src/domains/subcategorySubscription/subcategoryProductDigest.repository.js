import {
  SubcategoryProductDigestModel,
  subcategoryProductDigestStatus,
} from "./subcategoryProductDigest.model.js";

export async function queueDigestProduct({
  subcategoryId,
  productId,
  scheduledFor,
}) {
  const filter = { subcategory: subcategoryId, scheduledFor };
  const update = {
    $addToSet: { productIds: productId },
    $setOnInsert: { status: subcategoryProductDigestStatus.PENDING },
  };

  try {
    return await SubcategoryProductDigestModel.findOneAndUpdate(
      filter,
      update,
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    // Concurrent first products for the same subcategory/window may race on
    // the unique index. The winning digest is safe to update normally.
    if (error?.code === 11000) {
      return SubcategoryProductDigestModel.findOneAndUpdate(filter, update, {
        returnDocument: "after",
      }).lean();
    }
    throw error;
  }
}

export function recoverStaleDigestClaims({ before }) {
  return SubcategoryProductDigestModel.updateMany(
    {
      status: subcategoryProductDigestStatus.PROCESSING,
      claimedAt: { $lt: before },
    },
    {
      $set: {
        status: subcategoryProductDigestStatus.PENDING,
        claimToken: null,
        claimedAt: null,
      },
    },
  );
}

export function claimNextDueDigest({ now, claimToken, excludeDigestIds = [] }) {
  const filter = {
    status: subcategoryProductDigestStatus.PENDING,
    scheduledFor: { $lte: now },
  };
  if (excludeDigestIds.length) filter._id = { $nin: excludeDigestIds };

  return SubcategoryProductDigestModel.findOneAndUpdate(
    filter,
    {
      $set: {
        status: subcategoryProductDigestStatus.PROCESSING,
        claimToken,
        claimedAt: now,
        lastError: null,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { scheduledFor: 1, _id: 1 } },
  ).lean();
}

export function markDigestSent({ digestId, claimToken, sentAt }) {
  return SubcategoryProductDigestModel.updateOne(
    {
      _id: digestId,
      status: subcategoryProductDigestStatus.PROCESSING,
      claimToken,
    },
    {
      $set: {
        status: subcategoryProductDigestStatus.SENT,
        sentAt,
        claimToken: null,
        claimedAt: null,
        lastError: null,
      },
    },
  );
}

export function releaseDigestClaim({ digestId, claimToken, error }) {
  return SubcategoryProductDigestModel.updateOne(
    {
      _id: digestId,
      status: subcategoryProductDigestStatus.PROCESSING,
      claimToken,
    },
    {
      $set: {
        status: subcategoryProductDigestStatus.PENDING,
        claimToken: null,
        claimedAt: null,
        lastError: String(error?.message || error || "Unknown error").slice(
          0,
          1000,
        ),
      },
    },
  );
}

export function deleteDigestsForSubcategory(subcategoryId) {
  return SubcategoryProductDigestModel.deleteMany({
    subcategory: subcategoryId,
  });
}
