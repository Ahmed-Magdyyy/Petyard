import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validationResult } from "express-validator";

import { ProductSearchHistoryModel } from "../../src/domains/product/productSearchHistory.model.js";
import {
  commitProductSearchService,
  getPopularProductSearchesService,
  getProductSearchHistoryService,
  removeProductSearchHistoryTermService,
} from "../../src/domains/product/productSearchHistory.service.js";
import {
  commitProductSearchValidator,
  popularProductSearchesQueryValidator,
} from "../../src/domains/product/product.validators.js";

function mockHistoryStorage(t) {
  const documents = new Map();

  const identityKey = (filter) =>
    filter.user ? `user:${String(filter.user)}` : `guest:${filter.guestId}`;

  t.mock.method(
    ProductSearchHistoryModel,
    "findOneAndUpdate",
    (filter, update) => ({
      select() {
        return this;
      },
      lean: async () => {
        const key = identityKey(filter);
        const current = documents.get(key) || { ...filter, entries: [] };
        let entries;

        if (Array.isArray(update)) {
          const entry =
            update[0].$set.entries.$let.in.$slice[0].$concatArrays[0][0];
          entries = [
            entry,
            ...current.entries.filter(
              (existing) => existing.normalized !== entry.normalized,
            ),
          ].slice(0, 10);
        } else {
          entries = current.entries.filter(
            (entry) => entry.normalized !== update.$pull.entries.normalized,
          );
        }

        const updated = { ...current, entries };
        documents.set(key, updated);
        return updated;
      },
    }),
  );

  t.mock.method(ProductSearchHistoryModel, "findOne", (filter) => ({
    select() {
      return this;
    },
    lean: async () => documents.get(identityKey(filter)) || null,
  }));

  return documents;
}

test("search-history upserts explicitly enable Mongoose pipeline updates", async (t) => {
  let receivedOptions;

  t.mock.method(
    ProductSearchHistoryModel,
    "findOneAndUpdate",
    (_filter, _pipeline, options) => {
      receivedOptions = options;
      return {
        lean: async () => ({ entries: [] }),
      };
    },
  );

  await commitProductSearchService({
    userId: new mongoose.Types.ObjectId(),
    q: "Royal Canin",
  });

  assert.equal(receivedOptions.updatePipeline, true);
  assert.equal(receivedOptions.upsert, true);
  assert.equal(receivedOptions.new, true);
});

test("committed history stays at ten unique terms and repeated terms move to the front", async (t) => {
  const documents = mockHistoryStorage(t);
  const userId = new mongoose.Types.ObjectId();

  for (let index = 0; index < 11; index += 1) {
    await commitProductSearchService({ userId, q: `Search ${index}` });
  }

  const afterEleven = documents.get(`user:${String(userId)}`);
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

test("guests can save, list, and remove only their own search terms", async (t) => {
  mockHistoryStorage(t);
  const guestId = "guest-search-history";
  const otherGuestId = "guest-search-history-other";

  await commitProductSearchService({ guestId, q: "Royal Canin" });
  await commitProductSearchService({ guestId, q: "Cat Food" });
  await commitProductSearchService({
    guestId: otherGuestId,
    q: "Royal Canin",
  });

  const remaining = await removeProductSearchHistoryTermService({
    guestId,
    q: "  ROYAL   CANIN ",
  });

  assert.deepEqual(remaining.map((entry) => entry.q), ["Cat Food"]);
  assert.deepEqual(
    (await getProductSearchHistoryService({ guestId })).map(
      (entry) => entry.q,
    ),
    ["Cat Food"],
  );
  assert.deepEqual(
    (await getProductSearchHistoryService({ guestId: otherGuestId })).map(
      (entry) => entry.q,
    ),
    ["Royal Canin"],
  );
});

test("search-history ownership and indexes support either one user or one guest", async () => {
  const userHistory = new ProductSearchHistoryModel({
    user: new mongoose.Types.ObjectId(),
    entries: [],
  });
  const guestHistory = new ProductSearchHistoryModel({
    guestId: " guest-search-owner ",
    entries: [],
  });

  await userHistory.validate();
  await guestHistory.validate();
  assert.equal(guestHistory.guestId, "guest-search-owner");

  await assert.rejects(
    new ProductSearchHistoryModel({ entries: [] }).validate(),
    /exactly one user or guest/i,
  );
  await assert.rejects(
    new ProductSearchHistoryModel({
      user: new mongoose.Types.ObjectId(),
      guestId: "guest-search-owner",
      entries: [],
    }).validate(),
    /exactly one user or guest/i,
  );

  const indexes = ProductSearchHistoryModel.schema.indexes();
  const userIndex = indexes.find(
    ([fields]) => fields.user === 1 && Object.keys(fields).length === 1,
  );
  const guestIndex = indexes.find(
    ([fields]) => fields.guestId === 1 && Object.keys(fields).length === 1,
  );

  assert.equal(userIndex[1].unique, true);
  assert.deepEqual(userIndex[1].partialFilterExpression, {
    user: { $type: "objectId" },
  });
  assert.equal(guestIndex[1].unique, true);
  assert.deepEqual(guestIndex[1].partialFilterExpression, {
    guestId: { $type: "string" },
  });
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
  assert.ok(receivedPipeline[2].$group.identities.$addToSet.$cond);
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
