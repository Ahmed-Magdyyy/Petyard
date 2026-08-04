import { ProductSearchHistoryModel } from "./productSearchHistory.model.js";

export async function upsertUserSearchHistory(userId, entry) {
  const now = entry.searchedAt;

  // A pipeline update keeps the operation atomic: concurrent commits cannot
  // create duplicate normalized terms or grow the embedded history past ten.
  const update = [
    {
      $set: {
        user: { $ifNull: ["$user", userId] },
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
    { user: userId },
    update,
    { upsert, new: true },
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

export function findUserSearchHistory(userId) {
  return ProductSearchHistoryModel.findOne({ user: userId })
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
        users: { $addToSet: "$user" },
        mostRecentAt: { $max: "$entries.searchedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        q: 1,
        userCount: { $size: "$users" },
        mostRecentAt: 1,
      },
    },
    { $match: { userCount: { $gte: 2 } } },
    { $sort: { userCount: -1, mostRecentAt: -1, q: 1 } },
    { $limit: limit },
    { $project: { q: 1, userCount: 1 } },
  ]);
}
