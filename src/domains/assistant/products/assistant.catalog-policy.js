import { reject } from "../shared/assistant.errors.js";

const lists = ["foodCategoryIds", "nonFoodCategoryIds", "foodSubcategoryIds", "nonFoodSubcategoryIds"];
const id = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const referenceId = (value) => String(value?._id ?? value ?? "").toLowerCase();

export function validCatalogClassification(policy) {
  if (policy === undefined) return true;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
      Object.keys(policy).some((key) => !["version", ...lists].includes(key)) ||
      typeof policy.version !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(policy.version)) return false;
  if (!lists.every((key) => Array.isArray(policy[key]) && policy[key].length <= 1000 && policy[key].every(id) &&
      new Set(policy[key].map((value) => value.toLowerCase())).size === policy[key].length)) return false;
  return [["foodCategoryIds", "nonFoodCategoryIds"], ["foodSubcategoryIds", "nonFoodSubcategoryIds"]]
    .every(([food, nonfood]) => { const excluded = new Set(policy[nonfood].map((value) => value.toLowerCase()));
      return !policy[food].some((value) => excluded.has(value.toLowerCase())); });
}

export function classifyCatalogProduct(product, policy) {
  if (!validCatalogClassification(policy)) reject("invalid_catalog_classification", 503);
  const matches = (key, value) => Boolean(value) && (policy?.[key] ?? []).some((entry) => entry.toLowerCase() === value);
  const category = referenceId(product.category); const subcategory = referenceId(product.subcategory);
  // Food wins across category/subcategory rules; a broad nonfood rule cannot override a food match.
  if (matches("foodCategoryIds", category) || matches("foodSubcategoryIds", subcategory)) return "food";
  if (matches("nonFoodCategoryIds", category) || matches("nonFoodSubcategoryIds", subcategory)) return "nonfood";
  return "unknown";
}

export function catalogDietaryRisk(subject, warnings) {
  if (!Array.isArray(warnings)) reject("invalid_catalog_context", 503);
  if (subject === null) {
    if (warnings.length) reject("invalid_catalog_context", 503);
    return "general_browse";
  }
  if (!subject || typeof subject.id !== "string" || !/^(pet:[a-f\d]{24}|chat:[a-f\d-]{36})$/.test(subject.id) ||
      typeof subject.saved !== "boolean" || subject.saved !== subject.id.startsWith("pet:") ||
      warnings.some((warning) => !warning || warning.subjectId !== subject.id || warning.state !== "active" ||
        typeof warning.text !== "string" || !warning.text.trim())) reject("invalid_catalog_context", 503);
  if (warnings.length) return "known";
  const conditions = [subject.profile?.chronicConditions, subject.profile?.temporaryIssues];
  if (!subject.saved || conditions.some((value) => !Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) return "unknown";
  return conditions.some((value) => value.some((entry) => entry.trim())) ? "known" : "none_recorded";
}
