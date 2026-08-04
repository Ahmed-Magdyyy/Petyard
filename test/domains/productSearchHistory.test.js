import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validationResult } from "express-validator";

import { ProductSearchHistoryModel } from "../../src/domains/product/productSearchHistory.model.js";
import {
  commitProductSearchService,
  getPopularProductSearchesService,
  getProductSearchHistoryService,
} from "../../src/domains/product/productSearchHistory.service.js";
import {
  commitProductSearchValidator,
  popularProductSearchesQueryValidator,
} from "../../src/domains/product/product.validators.js";

function mockHistoryStorage(t) {
  const documents = new Map();

  t.mock.method(
    ProductSearchHistoryModel,
    "findOneAndUpdate",
    (filter, pipeline) => ({
      lean: async () => {
        const userId = String(filter.user);
        const entry =
          pipeline[0].$set.entries.$let.in.$slice[0].$concatArrays[0][0];
        const current = documents.get(userId) || { user: filter.user, entries: [] };
        const entries = [
          entry,
          ...current.entries.filter(
            (existing) => existing.normalized !== entry.normalized,
          ),
        ].slice(0, 10);
        const updated = { ...current, entries };
        documents.set(userId, updated);
        return updated;
      },
    }),
  );

  t.mock.method(ProductSearchHistoryModel, "findOne", (filter) => ({
    select() {
      return this;
    },
    lean: async () => documents.get(String(filter.user)) || null,
  }));

  return documents;
}

test("committed history stays at ten unique terms and repeated terms move to the front", async (t) => {
  const documents = mockHistoryStorage(t);
  const userId = new mongoose.Types.ObjectId();

  for (let index = 0; index < 11; index += 1) {
    await commitProductSearchService({ userId, q: `Search ${index}` });
  }

  const afterEleven = documents.get(String(userId));
  assert.equal(afterEleven.entries.length, 10);
  assert.equal(afterEleven.entries[0].q, "Search 10");
  assert.equal(afterEleven.entries.at(-1).q, "Search 1");

  const recent = await commitProductSearchService({
    userId,
    q: "  SEARCH   5 ",
  });

  assert.equal(recent.length, 10);
  assert.equal(recent[0].q, "SEARCH 5");
  assert.equal(
    recent.filter((entry) => entry.q.toLocaleLowerCase() === "search 5").length,
    1,
  );
});

test("search history is isolated to the authenticated user", async (t) => {
  mockHistoryStorage(t);
  const firstUser = new mongoose.Types.ObjectId();
  const secondUser = new mongoose.Types.ObjectId();

  await commitProductSearchService({ userId: firstUser, q: "Royal Canin" });
  await commitProductSearchService({ userId: secondUser, q: "Cat Food" });

  const firstHistory = await getProductSearchHistoryService({ userId: firstUser });
  const secondHistory = await getProductSearchHistoryService({ userId: secondUser });
  assert.equal(firstHistory.length, 1);
  assert.equal(firstHistory[0].q, "Royal Canin");
  assert.ok(firstHistory[0].searchedAt);
  assert.equal(secondHistory.length, 1);
  assert.equal(secondHistory[0].q, "Cat Food");
  assert.ok(secondHistory[0].searchedAt);
});

test("popular searches aggregate distinct users, preserve ranking, and respect the limit", async (t) => {
  let receivedPipeline;
  t.mock.method(ProductSearchHistoryModel, "aggregate", (pipeline) => {
    receivedPipeline = pipeline;
    return [
      { q: "Royal Canin", userCount: 4, mostRecentAt: new Date() },
      { q: "Cat Food", userCount: 2, mostRecentAt: new Date() },
    ];
  });

  const result = await getPopularProductSearchesService({ limit: 2 });

  assert.deepEqual(result, [
    { q: "Royal Canin", userCount: 4 },
    { q: "Cat Food", userCount: 2 },
  ]);
  assert.deepEqual(receivedPipeline[2].$group.users, { $addToSet: "$user" });
  assert.deepEqual(receivedPipeline[4], { $match: { userCount: { $gte: 2 } } });
  assert.deepEqual(receivedPipeline[5], {
    $sort: { userCount: -1, mostRecentAt: -1, q: 1 },
  });
  assert.deepEqual(receivedPipeline[6], { $limit: 2 });
});

test("committed-search validators normalize whitespace and reject invalid terms and limits", async () => {
  const validRequest = { body: { q: "  Royal   Canin  " } };
  for (const validator of commitProductSearchValidator.slice(0, -1)) {
    await validator.run(validRequest);
  }
  assert.deepEqual(validationResult(validRequest).array(), []);
  assert.equal(validRequest.body.q, "Royal Canin");

  const shortRequest = { body: { q: " r " } };
  for (const validator of commitProductSearchValidator.slice(0, -1)) {
    await validator.run(shortRequest);
  }
  assert.equal(validationResult(shortRequest).array()[0].msg, "q must be at least 2 characters");

  const invalidLimitRequest = { query: { limit: "21" } };
  for (const validator of popularProductSearchesQueryValidator.slice(0, -1)) {
    await validator.run(invalidLimitRequest);
  }
  assert.equal(
    validationResult(invalidLimitRequest).array()[0].msg,
    "limit must be an integer between 1 and 20",
  );
});
