import { ProductSearchHistoryModel } from "./productSearchHistory.model.js";

export function buildProductSearchHistoryIdentityFilter({ userId, guestId }) {
  if (userId) return { user: userId };

  const normalizedGuestId =
    typeof guestId === "string" ? guestId.trim() : "";
  if (normalizedGuestId) return { guestId: normalizedGuestId };

  throw new Error("Exactly one of userId or guestId is required");
}

export async function upsertSearchHistory(identity, entry) {
  const now = entry.searchedAt;
  const owner = buildProductSearchHistoryIdentityFilter(identity);
  const ownerField = owner.user ? "user" : "guestId";
  const ownerValue = owner[ownerField];

  // A pipeline update keeps the operation atomic: concurrent commits cannot
  // create duplicate normalized terms or grow the embedded history past ten.
  const update = [
    {
      $set: {
        [ownerField]: { $ifNull: [`$${ownerField}`, ownerValue] },
        entries: {
          $let: {
            vars: {
              entriesWithoutCurrentTerm: {
                $filter: {
                  input: { $ifNull: ["$entries", []] },
                  as: "entry",
                  cond: { $ne: ["$$entry.normalized", entry.normalized] },
                },
              },
            },
            in: {
              $slice: [
                {
                  $concatArrays: [
                    [entry],
                    "$$entriesWithoutCurrentTerm",
                  ],
                },
                10,
              ],
            },
          },
        },
        createdAt: { $ifNull: ["$createdAt", now] },
        updatedAt: now,
      },
    },
  ];

  const runUpdate = (upsert) => ProductSearchHistoryModel.findOneAndUpdate(
    owner,
    update,
    { upsert, new: true, updatePipeline: true },
  ).lean();

  try {
    return await runUpdate(true);
  } catch (error) {
    // Two first-ever commits for the same user can race on the unique index.
    // Once the competing insert wins, retrying as a normal atomic update is safe.
    if (error?.code === 11000) {
      return runUpdate(false);
    }
    throw error;
  }
}

export function findSearchHistory(identity) {
  return ProductSearchHistoryModel.findOne(
    buildProductSearchHistoryIdentityFilter(identity),
  )
    .select("entries")
    .lean();
}

export function removeSearchHistoryTerm(identity, normalized) {
  return ProductSearchHistoryModel.findOneAndUpdate(
    buildProductSearchHistoryIdentityFilter(identity),
    { $pull: { entries: { normalized } } },
    { new: true },
  )
    .select("entries")
    .lean();
}

export function findPopularSearches(limit) {
  return ProductSearchHistoryModel.aggregate([
    { $unwind: "$entries" },
    { $sort: { "entries.searchedAt": -1 } },
    {
      $group: {
        _id: "$entries.normalized",
        q: { $first: "$entries.q" },
        identities: {
          $addToSet: {
            $cond: [
              { $ne: [{ $ifNull: ["$user", null] }, null] },
              { $concat: ["user:", { $toString: "$user" }] },
              { $concat: ["guest:", "$guestId"] },
            ],
          },
        },
        mostRecentAt: { $max: "$entries.searchedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        q: 1,
        userCount: { $size: "$identities" },
        mostRecentAt: 1,
      },
    },
    { $match: { userCount: { $gte: 2 } } },
    { $sort: { userCount: -1, mostRecentAt: -1, q: 1 } },
    { $limit: limit },
    { $project: { q: 1, userCount: 1 } },
  ]);
}
