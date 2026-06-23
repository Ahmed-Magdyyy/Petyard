/**
 * Escape special regex characters in a string to prevent ReDoS attacks.
 * Use this before passing user input to MongoDB $regex queries.
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex pattern that treats common separators (hyphens, underscores,
 * dots, forward slashes, apostrophes, and whitespace) as optional between
 * characters.
 *
 * This gives Shopify-like search behaviour where both "xs" and "x-s" match
 * a product named "X-S", "royal-canin" matches "Royal Canin", and
 * "cats white" matches "Cat's White".
 *
 * Steps:
 *  1. Strip separators from the query.
 *  2. Escape each remaining character for regex safety.
 *  3. Join them with a separator class so any single separator is optional.
 */
export function buildFlexibleSearchPattern(str) {
  const normalized = str.replace(/[-_./'’\s]/g, "");
  if (!normalized) return escapeRegex(str);
  const chars = [...normalized].map((c) => escapeRegex(c));
  return chars.join("[-_./'’\\s]?");
}
