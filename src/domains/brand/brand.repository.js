import { BrandModel } from "./brand.model.js";

export function brandExists(filter = {}) {
  return BrandModel.exists(filter);
}
