const aliases = new Map([
  ["weight", "weight"], ["وزن", "weight"], ["الوزن", "weight"],
  ["package weight", "weight"], ["net weight", "weight"], ["وزن العبوة", "weight"], ["الوزن الصافي", "weight"],
  ["size", "size"], ["حجم", "size"], ["الحجم", "size"], ["مقاس", "size"], ["المقاس", "size"],
  ["color", "color"], ["colour", "color"], ["لون", "color"], ["اللون", "color"],
  ["flavor", "flavor"], ["flavour", "flavor"], ["نكهة", "flavor"], ["النكهة", "flavor"], ["طعم", "flavor"], ["الطعم", "flavor"],
  ["pieces", "pieces"], ["piece count", "pieces"], ["count", "pieces"], ["عدد القطع", "pieces"], ["عدد", "pieces"],
  ["scent", "scent"], ["رائحة", "scent"], ["الرائحة", "scent"],
  ["brand", "brand"], ["ماركة", "brand"], ["الماركة", "brand"], ["العلامة التجارية", "brand"],
  ["sku", "sku"], ["كود المنتج", "sku"],
]);

// Reviewed product/label pairs from the saved 2026-10-20 option inventory; never global title aliases.
const legacyNames = new Map([
  ["69c3f22634e2e2e70fe8a75a", ["alpha adult dog food with chicken", "weight"]],
  ["69b46fa00c9ac0a2214ee30c", ["birbo cat food chicken ,beef & fish", "weight"]],
  ["69b47cf00c9ac0a221550207", ["ciuffi salmon cat dry food", "weight"]],
  ["69b81a6b7b15b268715779f2", ["amna cat creamy treats with blueberry & chicken", "pieces"]],
  ["69b81d9d7b15b2687158b1e5", ["amna cat creamy treats with chicken & goat milk", "pieces"]],
  ["69b81e3b7b15b2687158f282", ["amna cat creamy treats with chicken & salmon", "pieces"]],
  ["69b81f4dc74ff194d2f58d7a", ["amna cat creamy treats with fish oil & salmon", "pieces"]],
  ["6ad6b59ceb45a87653b72bae", ["blue", "color"]],
  ["6a30251fb3969830981e723c", ["nunbell dog chew toy", "color"]],
  ["6a30262bb3969830981e78aa", ["nunbell dog chew toy", "color"]],
  ["6a12e650f1b561ed6cbed489", ["best pet gurme adult cat with different flavors", "flavor"]],
  ["69c71428e439a89ee5ad83f6", ["royal canin giant adult - dry food for giant active dogs. adult weight from 45 kg and over - over 18\\24 months", "weight"]],
]);
export const normalizeAttributeText = (value) => typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") : "";
export const attributeName = (value) => aliases.get(normalizeAttributeText(value)) ?? normalizeAttributeText(value);
const digits = (value) => value.replace(/[٠-٩۰-۹]/g, (char) => String(char.charCodeAt(0) - (char <= "٩" ? 0x660 : 0x6f0))).replace(/٫/g, ".");
const weightPattern = "([0-9]+(?:\\.[0-9]{1,6})?)\\s*(kilograms?|kgs?|kg|grams?|gms?|gm|g|كيلوجرامات|كيلوغرامات|كيلوجرام|كيلوغرام|كجم|كغ|كيلو|جرامات|غرامات|جرام|غرام|جم)";

export function packageWeightGrams(value) {
  const input = normalizeAttributeText(value);
  if (!input || input.length > 80) return null;
  const match = digits(input).match(new RegExp(`^${weightPattern}$`, "u"));
  if (!match) return null;
  const [whole, fraction = ""] = match[1].split(".");
  const scale = /^(?:k|كيلو|كجم|كغ)/u.test(match[2]) ? 1000n : 1n;
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * scale;
  if (numerator % denominator) return null;
  const result = Number(numerator / denominator);
  return Number.isSafeInteger(result) && result > 0 && result <= 1_000_000_000 ? result : null;
}

export function attributeValue(name, value) {
  const key = attributeName(name);
  if (key === "sku") return typeof value === "string" && value.trim() && value.trim().length <= 80 &&
    value.isWellFormed() && !value.includes("\u0000") ? value.trim() : null;
  const input = normalizeAttributeText(value);
  if (!input || input.length > 80) return null;
  if (key === "weight") return packageWeightGrams(input);
  if (key === "pieces") {
    const match = digits(input).match(/^([0-9]+)\s*(?:pcs?\.?|pieces?|قطع|قطعة)?$/u);
    if (!match) return null;
    const count = Number(match[1]); return Number.isSafeInteger(count) && count > 0 ? count : null;
  }
  return input;
}

function fact(values) {
  const usable = values.length && values.every((entry) => entry.value !== null);
  const unique = new Set(values.map((entry) => entry.value));
  return { state: usable && unique.size === 1 ? "known" : "unknown",
    value: usable && unique.size === 1 ? values[0].value : null, sources: values.map((entry) => entry.source) };
}

function titleFacts(product, ambiguousMass) {
  const values = new Map();
  const add = (key, value, field, raw) => {
    const current = values.get(key) ?? []; current.push({ value, source: { field, value: raw } }); values.set(key, current);
  };
  for (const field of ["name_en", "name_ar"]) {
    const title = product[field]; if (typeof title !== "string" || title.length > 2000) continue;
    // Parse the whole labelled clause so multipacks, ranges and doses cannot qualify by a partial match.
    const normalized = digits(normalizeAttributeText(title));
    const packageLabels = /(?:^|[^\p{L}\p{N}])(?:package weight|net weight|bag|pack|package|وزن العبوة|وزن الكيس|الوزن الصافي|كيس|عبوة)\s*[:=：]?\s*/gu;
    const multipack = /\d\s*[x×*]|[x×*]\s*\d|\d\s+(?:bags?\b|packs?\b|packages?\b|عبوة|عبوات|كيس|أكياس|اكياس)|\bmultipack\b/u.test(normalized);
    for (const match of normalized.matchAll(packageLabels)) {
      const raw = normalized.slice(match.index + match[0].length).trim();
      add("weight", multipack ? null : packageWeightGrams(raw), field, title);
    }
    const labels = /(?:^|[\s|;,،])(?:color|colour|flavou?r|size|pieces|لون|اللون|نكهة|النكهة|مقاس|المقاس|عدد القطع)\s*[:：]/giu;
    for (const match of title.matchAll(labels)) {
      const label = match[0].replace(/^[\s|;,،]+|\s*[:：]$/gu, "");
      const raw = title.slice(match.index + match[0].length).trim();
      const key = attributeName(label);
      add(key, attributeValue(key, raw), field, raw);
      if (key === "size" && packageWeightGrams(raw) !== null) add("weight", ambiguousMass ? null : packageWeightGrams(raw), field, raw);
    }
  }
  return values;
}

export function normalizeOfferAttributes(product, variant = null) {
  const values = new Map();
  const ambiguousMass = /\b(?:body|pet|dog|cat|adult|max(?:imum)?)\s+weight\b|\b(?:dose|dosage|simparica)\b|وزن\s*(?:الحيوان|الكلب|القط)|جرعة/u
    .test(normalizeAttributeText(`${product.name_en ?? ""} ${product.name_ar ?? ""}`));
  const title = titleFacts(product, ambiguousMass);
  if (variant) {
    const options = variant.options;
    if (!Array.isArray(options) || options.length > 100 || options.some((option) => !option ||
        typeof option.name !== "string" || !option.name.trim() || option.name.length > 2000 || typeof option.value !== "string")) return new Map();
    for (const option of options) {
      const literal = attributeName(option.name);
      const reviewed = legacyNames.get(String(product._id));
      const mapped = reviewed?.[0] === normalizeAttributeText(option.name) ? reviewed[1] : literal;
      const keys = new Set([literal, mapped]);
      if (mapped === "size" && packageWeightGrams(option.value) !== null) keys.add("weight");
      for (const key of keys) {
        const current = values.get(key) ?? [];
        current.push({ value: key === "weight" && ambiguousMass && mapped === literal ? null : attributeValue(key, option.value),
          source: { field: "variant.options", variantId: String(variant._id), name: option.name, value: option.value } });
        values.set(key, current);
      }
    }
    // Parent facts can expose a contradiction but never fill a missing attribute on an individual variant.
    for (const [key, entries] of title) if (values.has(key)) values.get(key).push(...entries);
  } else for (const [key, entries] of title) values.set(key, entries);
  return new Map([...values].map(([key, entries]) => [key, fact(entries)]));
}
