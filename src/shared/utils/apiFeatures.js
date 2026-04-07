import { escapeRegex } from "./escapeRegex.js";

// Build pagination info from query params
export function buildPagination({ page, limit }, defaultLimit = 10) {
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.max(Number(limit) || defaultLimit, 1);
  const skip = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, skip };
}

// Common sort aliases so consumers can use friendly names
const SORT_ALIASES = {
  upcoming: "startsAt",
  past: "-startsAt",
  newest: "-createdAt",
  oldest: "createdAt",
};

// Build sort object from query params
export function buildSort({ sort }, defaultSort = "-createdAt") {
  const raw = sort || defaultSort;

  if (!raw) return undefined;

  // Resolve alias if the entire value matches one
  const resolved = SORT_ALIASES[raw] || raw;

  const sortFields = String(resolved)
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

  if (!sortFields.length) return undefined;

  const sortObj = {};
  for (const field of sortFields) {
    if (field.startsWith("-")) {
      sortObj[field.substring(1)] = -1;
    } else {
      sortObj[field] = 1;
    }
  }

  return sortObj;
}

// Build a generic regex-based filter from query params.
export function buildRegexFilter(query, excludeKeys = []) {
  const filter = {};
  const excluded = new Set([...excludeKeys, "lang"]);

  Object.keys(query).forEach((key) => {
    if (excluded.has(key)) return;

    const value = query[key];

    if (typeof value === "string") {
      filter[key] = { $regex: escapeRegex(value), $options: "i" };
    } else {
      filter[key] = value;
    }
  });

  return filter;
}
