import { ApiError } from "../../shared/utils/ApiError.js";
import {
  findPopularSearches,
  findUserSearchHistory,
  upsertUserSearchHistory,
} from "./productSearchHistory.repository.js";

const MAX_SEARCH_LENGTH = 100;

export function normalizeCommittedSearchTerm(value) {
  if (typeof value !== "string") {
    throw new ApiError("q must be a string", 400);
  }

  const q = value.trim().replace(/\s+/gu, " ");
  if (Array.from(q).length < 2) {
    throw new ApiError("q must be at least 2 characters", 400);
  }
  if (Array.from(q).length > MAX_SEARCH_LENGTH) {
    throw new ApiError(`q must not exceed ${MAX_SEARCH_LENGTH} characters`, 400);
  }

  return { q, normalized: q.normalize("NFC").toLocaleLowerCase() };
}

function toSearchDto(entry) {
  return {
    q: entry.q,
    searchedAt: entry.searchedAt,
  };
}

function newestFirst(entries = []) {
  return [...entries]
    .sort((a, b) => new Date(b.searchedAt) - new Date(a.searchedAt))
    .slice(0, 10)
    .map(toSearchDto);
}

export async function commitProductSearchService({ userId, q }) {
  const normalizedTerm = normalizeCommittedSearchTerm(q);
  const history = await upsertUserSearchHistory(userId, {
    ...normalizedTerm,
    searchedAt: new Date(),
  });

  return newestFirst(history?.entries);
}

export async function getProductSearchHistoryService({ userId }) {
  const history = await findUserSearchHistory(userId);
  return newestFirst(history?.entries);
}

export async function getPopularProductSearchesService({ limit = 10 }) {
  const searches = await findPopularSearches(limit);
  return searches.map(({ q, userCount }) => ({ q, userCount }));
}
