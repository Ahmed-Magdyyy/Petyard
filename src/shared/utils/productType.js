export function normalizeProductType(value) {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  if (v === "SIMPLE" || v === "VARIANT") {
    return v;
  }
  return null;
}
