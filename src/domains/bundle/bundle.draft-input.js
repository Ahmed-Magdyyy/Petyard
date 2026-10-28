import { ApiError } from "../../shared/utils/ApiError.js";
import { toPiastres } from "../../shared/utils/money.js";
import { normalizeFixedBundleComponents } from "./bundle.components.js";

export const draftFields = Object.freeze(["name_en", "name_ar", "desc_en", "desc_ar", "price", "components"]);
export function bundleInputError(message, code = "BUNDLE_INVALID_REQUEST", status = 400) {
  const error = new ApiError(message, status); error.code = code; throw error;
}
export function bundleId(value) {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) bundleInputError("A valid bundle or warehouse ID is required");
  return value.toLowerCase();
}
export function bundleRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) bundleInputError("A valid expectedRevision is required");
  return value;
}
export function nextBundleRevision(value) {
  const revision = bundleRevision(value);
  if (revision === Number.MAX_SAFE_INTEGER) bundleInputError("Bundle revision is exhausted", "BUNDLE_REVISION_EXHAUSTED", 409);
  return revision;
}
export function exactBundleFields(value, allowed) {
  if (!value || value.constructor !== Object || Object.keys(value).some(key => !allowed.includes(key))) bundleInputError("Unexpected bundle request fields");
}
export function normalizeManualDraft(body, replacing = false) {
  exactBundleFields(body, replacing ? [...draftFields, "expectedRevision"] : draftFields);
  const values = {};
  for (const field of ["name_en", "name_ar", "desc_en", "desc_ar"]) {
    const value = body[field] === undefined ? "" : body[field];
    if (typeof value !== "string" || value.trim().length > (field.startsWith("name") ? 200 : 2000)) bundleInputError(`Invalid ${field}`);
    values[field] = value.trim();
  }
  if (!values.name_en) bundleInputError("English bundle name is required");
  const components = normalizeFixedBundleComponents(body.components);
  let pricePiastres;
  try { pricePiastres = toPiastres(body.price, "bundlePrice"); }
  catch { bundleInputError("Bundle price must be a non-negative EGP number"); }
  if (replacing) nextBundleRevision(body.expectedRevision);
  return { ...values, components, pricePiastres };
}
