// src/shared/utils/apiFeatures.js

// Build pagination info from query params
export function buildPagination({ page, limit }, defaultLimit = 10) {
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.max(Number(limit) || defaultLimit, 1);
  const skip = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, skip };
}

// Build sort object from query params
// Example: sort=-createdAt,name => { createdAt: -1, name: 1 }
export function buildSort({ sort }, defaultSort = "-createdAt") {
  const sortValue = sort || defaultSort;

  if (!sortValue) return undefined;

  const sortFields = String(sortValue)
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
// excludeKeys: keys that should be skipped here and handled specially in the caller (e.g. ['role']).
export function buildRegexFilter(query, excludeKeys = []) {
  const filter = {};

  Object.keys(query).forEach((key) => {
    if (excludeKeys.includes(key)) return;

    const value = query[key];

    if (typeof value === "string") {
      filter[key] = { $regex: value, $options: "i" };
    } else {
      filter[key] = value;
    }
  });

  return filter;
}
