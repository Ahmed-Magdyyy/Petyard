import slugify from "slugify";

export function normalizeTag(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  const normalized = slugify(str, { lower: true, strict: true, trim: true });
  return typeof normalized === "string" ? normalized : "";
}

export function normalizeTagsInput(tags) {
  if (!tags) return [];

  if (Array.isArray(tags)) {
    return tags.map(normalizeTag).filter(Boolean);
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((t) => normalizeTag(t))
      .filter(Boolean);
  }

  return [];
}
