/**
 * Escape special regex characters in a string to prevent ReDoS attacks.
 * Use this before passing user input to MongoDB $regex queries.
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex pattern that treats common separators (hyphens, underscores,
 * dots, forward slashes) as optional between characters.
 *
 * This gives Shopify-like search behaviour where both "xs" and "x-s" match
 * a product named "X-S", and "royal-canin" matches "Royal Canin".
 *
 * Steps:
 *  1. Strip hyphens / underscores / dots / slashes from the query.
 *  2. Escape each remaining character for regex safety.
 *  3. Join them with `[-_./\s]?` so any single separator is optional.
 */
export function buildFlexibleSearchPattern(str) {
  const normalized = str.replace(/[-_./]/g, "");
  if (!normalized) return escapeRegex(str);
  const chars = [...normalized].map((c) => escapeRegex(c));
  return chars.join("[-_./\\s]?");
}
