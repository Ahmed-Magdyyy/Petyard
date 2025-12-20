import { productTypeEnum } from "../constants/enums.js";

export function normalizeProductType(value) {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  return Object.values(productTypeEnum).includes(v) ? v : null;
}
