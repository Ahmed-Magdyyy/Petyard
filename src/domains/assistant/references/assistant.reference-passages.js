import { createHash } from "node:crypto";
import { reject } from "../shared/assistant.errors.js";
import { knowledgeBounds } from "../customer/assistant.knowledge.js";

export const referencePassageVersion = "petyard-reference-passages-v1";
const maxPassages = 10000;
const overlapBytes = 200;
const validText = (value, max) => typeof value === "string" && value.trim() && value.length <= max &&
  !value.includes("\u0000") && value.isWellFormed();

function windowEnd(text, start) {
  let end = start, bytes = 0;
  while (end < text.length) {
    const width = text.codePointAt(end) > 0xffff ? 2 : 1;
    const size = Buffer.byteLength(text.slice(end, end + width));
    if (bytes + size > knowledgeBounds.excerptBytes) break;
    bytes += size; end += width;
  }
  if (end === text.length) return end;
  const window = text.slice(start, end);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= window.length * 0.6) return start + paragraph + 2;
  const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "), window.lastIndexOf("\t"));
  return boundary >= window.length * 0.6 ? start + boundary + 1 : end;
}

function overlapStart(text, start, end) {
  let cursor = end, bytes = 0;
  while (cursor > start) {
    const last = text.charCodeAt(cursor - 1);
    const width = last >= 0xdc00 && last <= 0xdfff ? 2 : 1;
    const size = Buffer.byteLength(text.slice(cursor - width, cursor));
    if (bytes + size > overlapBytes) break;
    bytes += size; cursor -= width;
  }
  return cursor > start ? cursor : end;
}

// Preparation retains evidence and exact offsets; it does not infer case/species suitability or grant reviewed status.
export function prepareReferencePassages(reference, extracted, limits) {
  const sourceId = String(reference?._id);
  if (!/^[a-f\d]{24}$/iu.test(sourceId) || !/^[a-f\d]{64}$/iu.test(reference?.sha256 ?? "") ||
      extracted?.sha256 !== reference.sha256 || !validText(reference.title, 200) ||
      !Array.isArray(reference.species) || !reference.species.length || reference.species.length > 10 ||
      reference.species.some(value => !validText(value, 40))) reject("reference_preparation_invalid");
  if (!Number.isSafeInteger(limits?.maxTextBytes) || limits.maxTextBytes < 1 ||
      !Number.isSafeInteger(limits?.maxPages) || limits.maxPages < 1) reject("reference_configuration_required", 503);
  if (!Array.isArray(extracted.units) || !extracted.units.length || extracted.units.length > limits.maxPages) {
    reject("reference_preparation_invalid");
  }
  const passages = [];
  const locators = new Set();
  let inputBytes = 0, splitUnits = 0, textBytes = 0;
  for (let unitIndex = 0; unitIndex < extracted.units.length; unitIndex++) {
    const unit = extracted.units[unitIndex];
    if (!validText(unit?.locator, 160) || typeof unit.text !== "string" || !unit.text.isWellFormed() || unit.text.includes("\u0000")) {
      reject("reference_preparation_invalid");
    }
    if (locators.has(unit.locator)) reject("reference_preparation_invalid");
    locators.add(unit.locator);
    inputBytes += Buffer.byteLength(unit.text);
    if (inputBytes > limits.maxTextBytes) reject("reference_text_too_large", 413);
    let start = 0, ordinal = 0;
    while (start < unit.text.length) {
      const end = windowEnd(unit.text, start);
      const text = unit.text.slice(start, end);
      if (text.trim()) {
        if (passages.length >= maxPassages) reject("reference_too_many_passages", 413);
        const locator = `${unit.locator}, excerpt ${++ordinal}`;
        const id = createHash("sha256").update(JSON.stringify([referencePassageVersion, sourceId, reference.sha256, unitIndex, unit.locator, start, end, text])).digest("hex");
        passages.push({ id, locator, unitIndex, startOffset: start, endOffset: end, text });
        textBytes += Buffer.byteLength(text);
      }
      if (end === unit.text.length) break;
      start = overlapStart(unit.text, start, end);
    }
    if (ordinal > 1) splitUnits++;
  }
  if (!passages.length) reject("reference_no_readable_text");
  for (let index = 0; index < passages.length; index++) {
    passages[index].previousId = passages[index - 1]?.id ?? null;
    passages[index].nextId = passages[index + 1]?.id ?? null;
  }
  return { version: referencePassageVersion, sourceId, sourceVersion: reference.sha256, title: reference.title,
    species: [...reference.species], speciesScope: "source_declared", inputBytes, textBytes, passages,
    warnings: splitUnits ? [{ code: "reference_passage_context_review_required", count: splitUnits }] : [] };
}
