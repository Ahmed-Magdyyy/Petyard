import mongoose from "mongoose";
import { BrandModel } from "../brand/brand.model.js";
import { SubcategoryModel } from "../subcategory/subcategory.model.js";
import { SearchSuggestionModel } from "./searchSuggestion.model.js";
import {
  SEARCH_SUGGESTION_TARGET_MODELS,
  SEARCH_SUGGESTION_TYPES,
} from "./searchSuggestion.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  bumpCacheVersion,
  getCacheVersion,
  getOrSetCache,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";

const SEARCH_SUGGESTIONS_CACHE_VERSION_KEY = "search-suggestions:version";
const SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS = parseBoundedInt(
  process.env.SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS,
  5 * 60,
  5,
  60 * 60,
);
const SEARCH_SUGGESTIONS_ORDER = { position: 1, createdAt: 1, _id: 1 };
const SEARCH_SUGGESTIONS_LAST_ORDER = {
  position: -1,
  createdAt: -1,
  _id: -1,
};
const TARGET_SELECT = "_id slug name_en name_ar image";
const DEFAULT_PAGE_LIMIT = 10;
const MIN_PAGE_LIMIT = 5;
const MAX_PAGE_LIMIT = 100;

const targetModels = Object.freeze({
  [SEARCH_SUGGESTION_TYPES.BRAND]: BrandModel,
  [SEARCH_SUGGESTION_TYPES.SUBCATEGORY]: SubcategoryModel,
});

function normalizeLanguage(lang) {
  return lang === "ar" ? "ar" : "en";
}

function getId(value) {
  if (value && typeof value === "object" && value._id) return value._id;
  return value;
}

function toId(value) {
  return value == null ? null : String(value);
}

function canonicalObjectIdString(value) {
  return String(value).toLowerCase();
}

function assertObjectId(value, fieldName) {
  if (!mongoose.isObjectIdOrHexString(value)) {
    throw new ApiError(`${fieldName} must be a valid MongoDB ObjectId`, 400);
  }
}

function assertPosition(position) {
  if (
    position !== undefined &&
    (!Number.isInteger(position) || position < 0)
  ) {
    throw new ApiError("position must be a non-negative integer", 400);
  }
}

function getTargetModelName(targetType) {
  const targetModelName = SEARCH_SUGGESTION_TARGET_MODELS[targetType];
  if (!targetModelName) {
    throw new ApiError("targetType must be either brand or subcategory", 400);
  }
  return targetModelName;
}

async function resolveTarget(targetType, targetId) {
  const normalizedTargetId = getId(targetId);
  assertObjectId(normalizedTargetId, "targetId");

  const TargetModel = targetModels[targetType];
  getTargetModelName(targetType);
  const target = await TargetModel.findById(normalizedTargetId);
  if (!target) {
    throw new ApiError(
      `No ${targetType} found for this id: ${normalizedTargetId}`,
      404,
    );
  }

  return { target, targetId: normalizedTargetId };
}

function duplicateTargetError() {
  return new ApiError(
    "This target is already configured as a search suggestion",
    409,
  );
}

function mapDuplicateKeyError(error) {
  return error?.code === 11000 ? duplicateTargetError() : error;
}

function getPopulatedTarget(suggestion, targetOverride = null) {
  return targetOverride || suggestion?.targetId || null;
}

export function mapSearchSuggestionToPublicDto(
  suggestion,
  lang = "en",
  targetOverride = null,
) {
  const target = getPopulatedTarget(suggestion, targetOverride);
  if (!suggestion || !target?._id) return null;

  const normalizedLang = normalizeLanguage(lang);
  return {
    id: toId(suggestion._id),
    targetType: suggestion.targetType,
    position: Number.isInteger(suggestion.position) ? suggestion.position : 0,
    target: {
      id: toId(target._id),
      slug: target.slug,
      name: pickLocalizedField(target, "name", normalizedLang),
      image: target.image?.url || null,
    },
  };
}

export function mapSearchSuggestionToAdminDto(
  suggestion,
  lang = "en",
  targetOverride = null,
) {
  const target = getPopulatedTarget(suggestion, targetOverride);
  const publicDto = mapSearchSuggestionToPublicDto(
    suggestion,
    lang,
    target,
  );
  if (!publicDto) return null;

  return {
    ...publicDto,
    target: {
      ...publicDto.target,
      name_en: target.name_en ?? null,
      name_ar: target.name_ar ?? null,
    },
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  };
}

function normalizeListPagination({
  page = 1,
  limit = DEFAULT_PAGE_LIMIT,
} = {}) {
  const pageNum = Number(page);
  const limitNum = Number(limit);

  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw new ApiError("page must be a positive integer", 400);
  }
  if (
    !Number.isInteger(limitNum) ||
    limitNum < MIN_PAGE_LIMIT ||
    limitNum > MAX_PAGE_LIMIT
  ) {
    throw new ApiError(
      `limit must be an integer between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}`,
      400,
    );
  }

  return { pageNum, limitNum };
}

function paginateSuggestions(suggestions, { pageNum, limitNum }) {
  const totalResults = suggestions.length;
  const skip = (pageNum - 1) * limitNum;
  const data = suggestions.slice(skip, skip + limitNum);

  return {
    totalResults,
    totalPages: Math.ceil(totalResults / limitNum) || 1,
    page: pageNum,
    limit: limitNum,
    results: data.length,
    data,
  };
}

async function findOrderedSuggestions() {
  return SearchSuggestionModel.find({})
    .sort(SEARCH_SUGGESTIONS_ORDER)
    .populate("targetId", TARGET_SELECT)
    .lean();
}

async function invalidateSearchSuggestionCaches() {
  await bumpCacheVersion(SEARCH_SUGGESTIONS_CACHE_VERSION_KEY);
}

export async function getSearchSuggestionsService({
  lang = "en",
  page = 1,
  limit = DEFAULT_PAGE_LIMIT,
} = {}) {
  const normalizedLang = normalizeLanguage(lang);
  const pagination = normalizeListPagination({ page, limit });
  const version = await getCacheVersion(SEARCH_SUGGESTIONS_CACHE_VERSION_KEY);

  return getOrSetCache(
    `search-suggestions:public:v2:${version}:${normalizedLang}:${pagination.pageNum}:${pagination.limitNum}`,
    SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS,
    async () => {
      const suggestions = await findOrderedSuggestions();
      const data = suggestions
        .map((suggestion) =>
          mapSearchSuggestionToPublicDto(suggestion, normalizedLang),
        )
        .filter(Boolean);
      return paginateSuggestions(data, pagination);
    },
  );
}

export async function getAdminSearchSuggestionsService({
  lang = "en",
  page = 1,
  limit = DEFAULT_PAGE_LIMIT,
} = {}) {
  const pagination = normalizeListPagination({ page, limit });
  const suggestions = await findOrderedSuggestions();
  const data = suggestions
    .map((suggestion) => mapSearchSuggestionToAdminDto(suggestion, lang))
    .filter(Boolean);
  return paginateSuggestions(data, pagination);
}

async function getNextPosition() {
  const lastSuggestion = await SearchSuggestionModel.findOne({})
    .sort(SEARCH_SUGGESTIONS_LAST_ORDER)
    .lean();
  const lastPosition = Number.isInteger(lastSuggestion?.position)
    ? lastSuggestion.position
    : -1;
  return lastPosition + 1;
}

async function ensureTargetIsNotConfigured({ targetModel, targetId, excludeId }) {
  const filter = { targetModel, targetId };
  if (excludeId) filter._id = { $ne: excludeId };

  const existing = await SearchSuggestionModel.findOne(filter);
  if (existing) throw duplicateTargetError();
}

export async function createSearchSuggestionService(
  payload = {},
  lang = "en",
) {
  const { targetType, targetId } = payload;
  const targetModel = getTargetModelName(targetType);
  const resolved = await resolveTarget(targetType, targetId);
  assertPosition(payload.position);

  await ensureTargetIsNotConfigured({
    targetModel,
    targetId: resolved.targetId,
  });

  const position =
    payload.position === undefined
      ? await getNextPosition()
      : payload.position;

  try {
    const suggestion = await SearchSuggestionModel.create({
      targetType,
      targetId: resolved.targetId,
      targetModel,
      position,
    });

    await invalidateSearchSuggestionCaches();
    return mapSearchSuggestionToAdminDto(suggestion, lang, resolved.target);
  } catch (error) {
    throw mapDuplicateKeyError(error);
  }
}

function assertNonEmptyUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("At least one editable field is required", 400);
  }

  const fields = Object.keys(payload);
  if (fields.length === 0) {
    throw new ApiError("At least one editable field is required", 400);
  }

  if (
    fields.some(
      (field) => !["targetType", "targetId", "position"].includes(field),
    )
  ) {
    throw new ApiError(
      "Only targetType, targetId, and position can be updated",
      400,
    );
  }
}

export async function updateSearchSuggestionService(
  id,
  payload = {},
  lang = "en",
) {
  assertObjectId(id, "id");
  assertNonEmptyUpdate(payload);
  assertPosition(payload.position);

  const suggestion = await SearchSuggestionModel.findById(id);
  if (!suggestion) {
    throw new ApiError(`No search suggestion found for this id: ${id}`, 404);
  }

  const targetType =
    payload.targetType === undefined
      ? suggestion.targetType
      : payload.targetType;
  const currentTargetId = getId(suggestion.targetId);
  const targetId =
    payload.targetId === undefined ? currentTargetId : getId(payload.targetId);
  const targetModel = getTargetModelName(targetType);
  const resolved = await resolveTarget(targetType, targetId);

  await ensureTargetIsNotConfigured({
    targetModel,
    targetId: resolved.targetId,
    excludeId: id,
  });

  suggestion.targetType = targetType;
  suggestion.targetId = resolved.targetId;
  suggestion.targetModel = targetModel;
  if (payload.position !== undefined) suggestion.position = payload.position;

  try {
    const updatedSuggestion = await suggestion.save();
    await invalidateSearchSuggestionCaches();
    return mapSearchSuggestionToAdminDto(
      updatedSuggestion,
      lang,
      resolved.target,
    );
  } catch (error) {
    throw mapDuplicateKeyError(error);
  }
}

export async function deleteSearchSuggestionService(id) {
  assertObjectId(id, "id");

  const suggestion = await SearchSuggestionModel.findById(id);
  if (!suggestion) {
    throw new ApiError(`No search suggestion found for this id: ${id}`, 404);
  }

  const result = await SearchSuggestionModel.deleteOne({ _id: id });
  if (result?.deletedCount === 0) {
    throw new ApiError(`No search suggestion found for this id: ${id}`, 404);
  }

  await invalidateSearchSuggestionCaches();
}

export async function updateSearchSuggestionPositionsService(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new ApiError("positions must be a non-empty array", 400);
  }
  if (positions.length > 500) {
    throw new ApiError("positions must contain at most 500 items", 400);
  }

  const ids = new Set();
  const canonicalIds = [];
  for (const item of positions) {
    assertObjectId(item?.id, "id");
    assertPosition(item?.position);
    const id = canonicalObjectIdString(item.id);
    if (ids.has(id)) {
      throw new ApiError("positions must not contain duplicate ids", 400);
    }
    ids.add(id);
    canonicalIds.push(id);
  }

  const existingCount = Number(
    await SearchSuggestionModel.countDocuments({ _id: { $in: canonicalIds } }),
  );
  if (existingCount !== canonicalIds.length) {
    throw new ApiError(
      `Some search suggestion IDs were not found. Expected ${canonicalIds.length}, matched ${existingCount}`,
      400,
    );
  }

  const operations = positions.map(({ position }, index) => ({
    updateOne: {
      filter: { _id: canonicalIds[index] },
      update: { $set: { position } },
    },
  }));

  const result = await SearchSuggestionModel.bulkWrite(operations, {
    ordered: false,
  });
  const matched = Number(result?.matchedCount ?? 0);
  const modified = Number(result?.modifiedCount ?? 0);

  if (matched !== positions.length) {
    await invalidateSearchSuggestionCaches();
    throw new ApiError(
      `Some search suggestion IDs were not found. Expected ${positions.length}, matched ${matched}`,
      400,
    );
  }

  await invalidateSearchSuggestionCaches();
  return {
    requested: positions.length,
    matched,
    modified,
  };
}
