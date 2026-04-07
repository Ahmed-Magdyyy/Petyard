/**
 * Escape special regex characters in a string to prevent ReDoS attacks.
 * Use this before passing user input to MongoDB $regex queries.
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
