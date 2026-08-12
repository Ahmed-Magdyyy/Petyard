import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validationResult } from "express-validator";

import { BrandModel } from "../../src/domains/brand/brand.model.js";
import { SubcategoryModel } from "../../src/domains/subcategory/subcategory.model.js";
import {
  SearchSuggestionModel,
  SEARCH_SUGGESTION_TYPES,
} from "../../src/domains/searchSuggestion/searchSuggestion.model.js";
import searchSuggestionRoutes from "../../src/domains/searchSuggestion/searchSuggestion.routes.js";
import {
  createSearchSuggestionValidator,
  listSearchSuggestionsQueryValidator,
  updateSearchSuggestionPositionsValidator,
  updateSearchSuggestionValidator,
} from "../../src/domains/searchSuggestion/searchSuggestion.validators.js";
import {
  createSearchSuggestionService,
  deleteSearchSuggestionService,
  getAdminSearchSuggestionsService,
  getSearchSuggestionsService,
  updateSearchSuggestionPositionsService,
  updateSearchSuggestionService,
} from "../../src/domains/searchSuggestion/searchSuggestion.service.js";

function queryResult(value) {
  const query = {
    sort() {
      return query;
    },
    populate() {
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

async function getValidationErrors(validators, req) {
  for (const validator of validators.slice(0, -1)) {
    await validator.run(req);
  }
  return validationResult(req).array();
}

function makeTarget(id, overrides = {}) {
  return {
    _id: id,
    slug: "target-slug",
    name_en: "Target",
    name_ar: "الهدف",
    image: { url: "https://cdn.example/target.jpg" },
    ...overrides,
  };
}

test("search suggestion model enforces targetType, target model, and position invariants", () => {
  const targetId = new mongoose.Types.ObjectId();
  const suggestion = new SearchSuggestionModel({
    targetType: SEARCH_SUGGESTION_TYPES.BRAND,
    targetId,
    targetModel: "Brand",
  });

  assert.equal(suggestion.position, 0);
  assert.equal(suggestion.validateSync(), undefined);

  suggestion.position = 1.5;
  assert.ok(suggestion.validateSync()?.errors.position);

  const mismatched = new SearchSuggestionModel({
    targetType: SEARCH_SUGGESTION_TYPES.BRAND,
    targetId,
    targetModel: "Subcategory",
  });
  assert.ok(mismatched.validateSync()?.errors.targetModel);

  const indexes = SearchSuggestionModel.schema.indexes();
  assert.ok(indexes.some(([fields]) => fields.position === 1));
  assert.ok(
    indexes.some(
      ([fields, options]) =>
        fields.targetModel === 1 && fields.targetId === 1 && options.unique,
    ),
  );
});

test("public suggestions are ordered, localized, explicitly serialized, and filter orphans", async (t) => {
  const firstId = new mongoose.Types.ObjectId();
  const secondId = new mongoose.Types.ObjectId();
  const firstTargetId = new mongoose.Types.ObjectId();
  const secondTargetId = new mongoose.Types.ObjectId();
  const suggestions = [
    {
      _id: firstId,
      targetType: "brand",
      position: 0,
      targetId: makeTarget(firstTargetId, {
        slug: "royal-canin",
        name_en: "Royal Canin",
        name_ar: "رويال كانين",
      }),
      targetModel: "Brand",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      __v: 3,
    },
    {
      _id: secondId,
      targetType: "subcategory",
      position: 2,
      targetId: makeTarget(secondTargetId, {
        slug: "cat-food",
        name_en: "Cat food",
        name_ar: "طعام القطط",
        image: null,
      }),
      targetModel: "Subcategory",
      createdAt: new Date("2026-01-03"),
      updatedAt: new Date("2026-01-04"),
    },
    {
      _id: new mongoose.Types.ObjectId(),
      targetType: "brand",
      position: 1,
      targetId: null,
      targetModel: "Brand",
    },
  ];

  let sortArgument;
  let populateArguments;
  t.mock.method(SearchSuggestionModel, "find", () => ({
    sort(value) {
      sortArgument = value;
      return this;
    },
    populate(...args) {
      populateArguments = args;
      return this;
    },
    lean: async () => suggestions,
  }));

  const publicResult = await getSearchSuggestionsService({
    lang: "ar",
    page: 1,
    limit: 5,
  });
  const adminResult = await getAdminSearchSuggestionsService({
    lang: "ar",
    page: 1,
    limit: 5,
  });
  const publicData = publicResult.data;
  const adminData = adminResult.data;

  assert.deepEqual(
    {
      totalResults: publicResult.totalResults,
      totalPages: publicResult.totalPages,
      page: publicResult.page,
      limit: publicResult.limit,
      results: publicResult.results,
    },
    { totalResults: 2, totalPages: 1, page: 1, limit: 5, results: 2 },
  );
  assert.deepEqual(
    {
      totalResults: adminResult.totalResults,
      totalPages: adminResult.totalPages,
      page: adminResult.page,
      limit: adminResult.limit,
      results: adminResult.results,
    },
    { totalResults: 2, totalPages: 1, page: 1, limit: 5, results: 2 },
  );
  assert.deepEqual(sortArgument, { position: 1, createdAt: 1, _id: 1 });
  assert.deepEqual(populateArguments, [
    "targetId",
    "_id slug name_en name_ar image",
  ]);
  assert.deepEqual(publicData, [
    {
      id: String(firstId),
      targetType: "brand",
      position: 0,
      target: {
        id: String(firstTargetId),
        slug: "royal-canin",
        name: "رويال كانين",
        image: "https://cdn.example/target.jpg",
      },
    },
    {
      id: String(secondId),
      targetType: "subcategory",
      position: 2,
      target: {
        id: String(secondTargetId),
        slug: "cat-food",
        name: "طعام القطط",
        image: null,
      },
    },
  ]);
  assert.equal(adminData[0].target.name_en, "Royal Canin");
  assert.equal(adminData[0].target.name_ar, "رويال كانين");
  assert.deepEqual(Object.keys(publicData[0]).sort(), [
    "id",
    "position",
    "target",
    "targetType",
  ]);
  assert.equal(publicData[0].targetModel, undefined);
});

test("create appends after the current maximum position and returns an admin DTO", async (t) => {
  const targetId = new mongoose.Types.ObjectId();
  const createdId = new mongoose.Types.ObjectId();
  const target = makeTarget(targetId, { slug: "brand-slug" });
  let createdPayload;

  t.mock.method(BrandModel, "findById", async () => target);
  t.mock.method(SearchSuggestionModel, "findOne", (filter) => {
    if (Object.keys(filter).length === 0) return queryResult({ position: 4 });
    return Promise.resolve(null);
  });
  t.mock.method(SearchSuggestionModel, "create", async (payload) => {
    createdPayload = payload;
    return {
      _id: createdId,
      ...payload,
      createdAt: new Date("2026-02-01"),
      updatedAt: new Date("2026-02-01"),
    };
  });

  const result = await createSearchSuggestionService(
    { targetType: "brand", targetId: String(targetId) },
    "en",
  );

  assert.deepEqual(createdPayload, {
    targetType: "brand",
    targetId: String(targetId),
    targetModel: "Brand",
    position: 5,
  });
  assert.equal(result.position, 5);
  assert.equal(result.target.name_en, "Target");
});

test("create rejects a missing target and duplicate targets, including duplicate-key races", async (t) => {
  const targetId = new mongoose.Types.ObjectId();

  t.mock.method(BrandModel, "findById", async () => null);
  await assert.rejects(
    () => createSearchSuggestionService({ targetType: "brand", targetId }),
    { statusCode: 404 },
  );

  const target = makeTarget(targetId);
  t.mock.method(BrandModel, "findById", async () => target);
  t.mock.method(SearchSuggestionModel, "findOne", async () => ({ _id: "existing" }));
  await assert.rejects(
    () => createSearchSuggestionService({ targetType: "brand", targetId }),
    { statusCode: 409 },
  );

  t.mock.method(SearchSuggestionModel, "findOne", (filter) => {
    if (Object.keys(filter).length === 0) return queryResult(null);
    return Promise.resolve(null);
  });
  t.mock.method(SearchSuggestionModel, "create", async () => {
    throw { code: 11000 };
  });
  await assert.rejects(
    () => createSearchSuggestionService({ targetType: "brand", targetId }),
    { statusCode: 409 },
  );
});

test("update resolves target and targetType changes and preserves omitted fields", async (t) => {
  const suggestionId = new mongoose.Types.ObjectId();
  const oldTargetId = new mongoose.Types.ObjectId();
  const newTargetId = new mongoose.Types.ObjectId();
  const subcategory = makeTarget(newTargetId, {
    slug: "new-subcategory",
    name_en: "New subcategory",
  });
  const suggestion = {
    _id: suggestionId,
    targetType: "brand",
    targetId: oldTargetId,
    targetModel: "Brand",
    position: 3,
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-01"),
    async save() {
      return this;
    },
  };

  t.mock.method(SearchSuggestionModel, "findById", async () => suggestion);
  t.mock.method(SubcategoryModel, "findById", async () => subcategory);
  t.mock.method(SearchSuggestionModel, "findOne", async (filter) => {
    assert.deepEqual(filter, {
      targetModel: "Subcategory",
      targetId: String(newTargetId),
      _id: { $ne: String(suggestionId) },
    });
    return null;
  });

  const result = await updateSearchSuggestionService(
    String(suggestionId),
    { targetType: "subcategory", targetId: String(newTargetId), position: 8 },
    "en",
  );

  assert.equal(suggestion.targetType, "subcategory");
  assert.equal(suggestion.targetModel, "Subcategory");
  assert.equal(String(suggestion.targetId), String(newTargetId));
  assert.equal(suggestion.position, 8);
  assert.equal(result.target.slug, "new-subcategory");
});

test("delete removes an existing suggestion and reports missing resources", async (t) => {
  const suggestionId = new mongoose.Types.ObjectId();
  let deletedFilter;
  t.mock.method(SearchSuggestionModel, "findById", async () => ({ _id: suggestionId }));
  t.mock.method(SearchSuggestionModel, "deleteOne", async (filter) => {
    deletedFilter = filter;
    return { deletedCount: 1 };
  });

  await deleteSearchSuggestionService(String(suggestionId));
  assert.deepEqual(deletedFilter, { _id: String(suggestionId) });

  t.mock.method(SearchSuggestionModel, "findById", async () => null);
  await assert.rejects(
    () => deleteSearchSuggestionService(String(suggestionId)),
    { statusCode: 404 },
  );
});

test("bulk reorder uses bulkWrite and rejects a partial match result", async (t) => {
  const firstId = new mongoose.Types.ObjectId();
  const secondId = new mongoose.Types.ObjectId();
  let bulkArguments;
  t.mock.method(SearchSuggestionModel, "countDocuments", async () => 2);
  t.mock.method(SearchSuggestionModel, "bulkWrite", async (...args) => {
    bulkArguments = args;
    return { matchedCount: 2, modifiedCount: 1 };
  });

  const result = await updateSearchSuggestionPositionsService([
    { id: String(firstId), position: 4 },
    { id: String(secondId), position: 9 },
  ]);

  assert.deepEqual(result, { requested: 2, matched: 2, modified: 1 });
  assert.deepEqual(bulkArguments, [
    [
      {
        updateOne: {
          filter: { _id: String(firstId) },
          update: { $set: { position: 4 } },
        },
      },
      {
        updateOne: {
          filter: { _id: String(secondId) },
          update: { $set: { position: 9 } },
        },
      },
    ],
    { ordered: false },
  ]);

  t.mock.method(SearchSuggestionModel, "bulkWrite", async () => ({
    matchedCount: 1,
    modifiedCount: 1,
  }));
  await assert.rejects(
    () =>
      updateSearchSuggestionPositionsService([
        { id: String(firstId), position: 4 },
        { id: String(secondId), position: 9 },
      ]),
    { statusCode: 400 },
  );
});

test("bulk reorder rejects unknown IDs before bulkWrite", async (t) => {
  const existingId = new mongoose.Types.ObjectId();
  const missingId = new mongoose.Types.ObjectId();
  let bulkWriteCalled = false;

  t.mock.method(SearchSuggestionModel, "countDocuments", async (filter) => {
    assert.deepEqual(filter, {
      _id: { $in: [String(existingId).toLowerCase(), String(missingId).toLowerCase()] },
    });
    return 1;
  });
  t.mock.method(SearchSuggestionModel, "bulkWrite", async () => {
    bulkWriteCalled = true;
    return { matchedCount: 1, modifiedCount: 1 };
  });

  await assert.rejects(
    () =>
      updateSearchSuggestionPositionsService([
        { id: String(existingId), position: 1 },
        { id: String(missingId), position: 2 },
      ]),
    { statusCode: 400 },
  );
  assert.equal(bulkWriteCalled, false);
});

test("bulk reorder rejects differently-cased duplicate ObjectId representations", async (t) => {
  const lowerCaseId = "abcdefabcdefabcdefabcdef";
  const upperCaseId = lowerCaseId.toUpperCase();
  let countDocumentsCalled = false;

  t.mock.method(SearchSuggestionModel, "countDocuments", async () => {
    countDocumentsCalled = true;
    return 2;
  });

  await assert.rejects(
    () =>
      updateSearchSuggestionPositionsService([
        { id: lowerCaseId, position: 1 },
        { id: upperCaseId, position: 2 },
      ]),
    { statusCode: 400 },
  );
  assert.equal(countDocumentsCalled, false);
});

test("validators enforce enums, object IDs, non-empty patches, array limits, and duplicate reorder IDs", async () => {
  const validId = new mongoose.Types.ObjectId().toString();

  const belowMinimumLimitErrors = await getValidationErrors(
    listSearchSuggestionsQueryValidator,
    { query: { page: "1", limit: "4" } },
  );
  assert.ok(
    belowMinimumLimitErrors.some((error) => error.path === "limit"),
  );

  const minimumLimitErrors = await getValidationErrors(
    listSearchSuggestionsQueryValidator,
    { query: { page: "1", limit: "5" } },
  );
  assert.equal(minimumLimitErrors.length, 0);
  await assert.rejects(
    () => getSearchSuggestionsService({ page: 1, limit: 4 }),
    { statusCode: 400 },
  );

  const createErrors = await getValidationErrors(
    createSearchSuggestionValidator,
  listSearchSuggestionsQueryValidator,
    { body: { targetType: "collection", targetId: "bad-id" } },
  );
  assert.ok(createErrors.some((error) => error.path === "targetType"));
  assert.ok(createErrors.some((error) => error.path === "targetId"));

  const emptyPatchErrors = await getValidationErrors(
    updateSearchSuggestionValidator,
    { params: { id: validId }, body: {} },
  );
  assert.ok(emptyPatchErrors.some((error) => error.location === "body"));

  const unknownPatchErrors = await getValidationErrors(
    updateSearchSuggestionValidator,
    { params: { id: validId }, body: { slug: "not-allowed" } },
  );
  assert.ok(unknownPatchErrors.some((error) => error.location === "body"));

  const tooManyPositionsErrors = await getValidationErrors(
    updateSearchSuggestionPositionsValidator,
    {
      body: {
        positions: Array.from({ length: 501 }, (_, index) => ({
          id: validId,
          position: index,
        })),
      },
    },
  );
  assert.ok(tooManyPositionsErrors.some((error) => error.path === "positions"));

  const duplicatePositionsErrors = await getValidationErrors(
    updateSearchSuggestionPositionsValidator,
    {
      body: {
        positions: [
          { id: "abcdefabcdefabcdefabcdef", position: 0 },
          { id: "ABCDEFABCDEFABCDEFABCDEF", position: 1 },
        ],
      },
    },
  );
  assert.ok(
    duplicatePositionsErrors.some((error) => error.path === "positions"),
  );
});

test("positions route matches the brand convention and remains admin protected", () => {
  const routeLayers = searchSuggestionRoutes.stack.filter((layer) => layer.route);
  const positionsIndex = routeLayers.findIndex(
    (layer) => layer.route.path === "/positions" && layer.route.methods.patch,
  );
  const idIndex = routeLayers.findIndex(
    (layer) => layer.route.path === "/admin/:id" && layer.route.methods.patch,
  );

  assert.ok(positionsIndex >= 0 && positionsIndex < idIndex);
  assert.ok(routeLayers[positionsIndex].route.stack.length >= 5);

  for (const layer of routeLayers.filter((candidate) =>
    String(candidate.route.path).startsWith("/admin"),
  )) {
    assert.ok(layer.route.stack.length >= 4);
  }
});
