import { createHash } from "node:crypto";
import { reject } from "../shared/assistant.errors.js";
import { fields, objectId } from "../shared/assistant.validation.js";

// This is an internal model intent, not a product, price or executable domain action.
export function productSearchIntent(data, run, priorEvidence = []) {
  if (!["pet_care", "petyard", "health"].includes(data.scope)) return null;
  const search = data.productSearch;
  const filters = search;
  const evidence = [run.input, ...priorEvidence.filter(entry => new Date(entry.expiresAt) > new Date()).map(entry => entry.text)];
  const containsQuote = quote => evidence.some(input => input.includes(quote));
  const constrained = filters.minimumPackageWeightGrams !== null || filters.maximumPriceMinor !== null || filters.options.length > 0;
  if (search.action === "none") {
    if (search.query || constrained || filters.sourceQuote) reject("invalid_product_search", 503);
    return null;
  }
  if (!["general", "pet"].includes(search.action) || typeof search.query !== "string" ||
      !search.query.trim() || search.query !== search.query.trim() || search.query.length > 120 || search.query.includes("\u0000") ||
      (constrained ? !filters.sourceQuote.trim() || filters.sourceQuote.length > 500 || !containsQuote(filters.sourceQuote) : Boolean(filters.sourceQuote)) ||
      filters.options.some((option) => !option.name.trim() || option.name.length > 80 || !option.value.trim() || option.value.length > 80 ||
        !option.sourceQuote.trim() || option.sourceQuote.length > 500 || !containsQuote(option.sourceQuote) || !option.sourceQuote.includes(option.value))) {
    reject("invalid_product_search", 503);
  }
  return { query: search.query, subjectId: run.subjectId ?? null, needsSubject: search.action === "pet" && !run.subjectId,
    healthContext: data.scope === "health" || data.primaryTopic === "health_symptoms",
    filters: { minimumPackageWeightGrams: filters.minimumPackageWeightGrams, maximumPriceMinor: filters.maximumPriceMinor,
      options: structuredClone(filters.options) }, constrained };
}

export function productSearchContext(context, replyLanguage) {
  if (context === undefined) return { warehouseId: null, language: replyLanguage === "ar" ? "ar" : "en" };
  if (typeof context?.toObject === "function") context = context.toObject();
  fields(context, ["warehouseId", "language"]);
  if (!["ar", "en"].includes(context.language)) reject("invalid_request");
  return { warehouseId: context.warehouseId === null ? null : String(objectId(context.warehouseId)), language: context.language };
}

export function productSearchBinding(run, intent, context, warning) {
  return createHash("sha256").update(JSON.stringify({ owner: String(run.owner), run: String(run._id), attempt: run.attempt,
    contextVersion: run.contextVersion, subjectFingerprint: run.subjectFingerprint, configuration: run.config.signature,
    intent, context, warning: warning?.kind === "report" ? { subjectId: warning.subjectId, quote: warning.quote } : null })).digest("hex");
}
