import { SubcategoryModel } from "./subcategory.model.js";

export function findSubcategoryById(id) {
  return SubcategoryModel.findById(id);
}
