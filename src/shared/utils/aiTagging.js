import { getGeminiAI } from "../../config/gemini.js";
import { normalizeTag } from "./tagging.js";
import {
  petTypeTags,
  petLifeStageTags,
  knownBreedTagsByPetType,
} from "../constants/petTags.js";
import { ConditionModel } from "../../domains/condition/condition.model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_MODEL = "gemini-3.1-flash-lite";

/**
 * BASELINE condition slugs — the known conditions that should always be
 * recognised even if admin hasn't added them to the Condition collection yet.
 * New conditions added to the DB are auto-merged at runtime.
 *
 * Last synced with Condition collection: 2026-05-02
 */
const BASELINE_CONDITION_TAGS = Object.freeze([
  // chronic
  "diabetic", "early-renal-support", "hepatitis", "joint-care",
  "renal-support", "sterilised",
  // temporary
  "anxiety", "digestive-disease", "ear-infection", "fungal-disease",
  "hair-loss", "hairball", "immunity", "obesity", "oral-care",
  "pregnancy", "skin-allergy", "under-weight", "urinary-system-disorders",
]);

/** Descriptive tags — closed vocabulary for product categories & attributes. */
const DESCRIPTIVE_TAGS = Object.freeze([
  // food types
  "food", "dry", "wet", "treats", "raw", "freeze-dried",
  // grooming & hygiene
  "toy", "litter", "shampoo", "conditioner", "spray", "wipes",
  "brush", "comb",
  // supplements & health
  "supplement", "vitamins", "probiotics", "omega",
  // accessories
  "collar", "leash", "harness", "bed", "bowl", "feeder", "waterer",
  "carrier", "cage", "crate", "aquarium", "terrarium",
  // care categories
  "grooming", "dental", "training", "clothing", "diaper",
  // ingredients / protein
  "chicken", "beef", "salmon", "tuna", "lamb", "turkey", "fish",
  "duck", "rabbit-meat",
  // dietary attributes
  "grain-free", "hypoallergenic", "organic", "natural",
  // environment / size
  "indoor", "outdoor", "small-breed", "medium-breed", "large-breed",
  "giant-breed",
  // health-focused descriptors (NOT conditions — these describe product purpose)
  "urinary", "digestive", "joint", "skin-coat", "weight-management",
  "hairball-control", "immune-support",
  // pharmacy
  "dewormer", "flea", "tick", "anti-fungal", "ear-care", "eye-care",
  "wound-care", "pharmacy",
]);

// ---------------------------------------------------------------------------
// Static allowlist parts (everything except conditions, which are dynamic)
// ---------------------------------------------------------------------------

const ALL_BREED_TAGS = Object.values(knownBreedTagsByPetType).flat();

const STATIC_ALLOWED_TAGS = new Set([
  ...Object.values(petTypeTags),
  ...Object.values(petLifeStageTags),
  ...ALL_BREED_TAGS,
  ...DESCRIPTIVE_TAGS,
]);

// ---------------------------------------------------------------------------
// Dynamic condition loading (hybrid: baseline + DB)
// ---------------------------------------------------------------------------

let _cachedConditionSlugs = null;
let _cacheTimestamp = 0;
const CONDITION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns the full set of condition slugs: baseline ∪ DB conditions.
 * Cached for 1 hour. Falls back to baseline only on DB error.
 */
export async function getConditionTags() {
  const now = Date.now();
  if (_cachedConditionSlugs && now - _cacheTimestamp < CONDITION_CACHE_TTL_MS) {
    return _cachedConditionSlugs;
  }

  try {
    const dbConditions = await ConditionModel.find({})
      .select("slug")
      .lean();

    const dbSlugs = dbConditions
      .map((c) => c.slug)
      .filter(Boolean);

    // Merge: baseline ∪ DB (deduplicated)
    const merged = [...new Set([...BASELINE_CONDITION_TAGS, ...dbSlugs])];
    _cachedConditionSlugs = merged;
    _cacheTimestamp = now;

    return merged;
  } catch (err) {
    console.warn("[AI Tagging] Failed to load conditions from DB, using baseline:", err.message);
    return [...BASELINE_CONDITION_TAGS];
  }
}

/**
 * Builds the full dynamic allowlist: static tags + current condition tags.
 */
export async function getAllowedTags() {
  const conditionTags = await getConditionTags();
  return new Set([...STATIC_ALLOWED_TAGS, ...conditionTags]);
}

// ---------------------------------------------------------------------------
// Synonym mapping (Layer 1.5 — runs BEFORE the allowlist check)
// ---------------------------------------------------------------------------

/**
 * Maps common product-description wording → canonical DB condition slug.
 * If a product says "diabetes" but the DB slug is "diabetic", the AI might
 * output either form. This map corrects non-canonical variations so they
 * survive the allowlist check.
 *
 * Key = what Gemini might return (after normalizeTag).
 * Value = canonical DB slug.
 */
const SYNONYM_MAP = Object.freeze({
  // diabetic
  "diabetes": "diabetic",
  "diabetics": "diabetic",

  // hepatitis
  "hepatic": "hepatitis",
  "liver": "hepatitis",
  "liver-disease": "hepatitis",
  "liver-support": "hepatitis",

  // renal-support (replaces removed kidney-disease & renal slugs)
  "kidney": "renal-support",
  "kidney-disease": "renal-support",
  "renal": "renal-support",
  "renal-disease": "renal-support",

  // skin-allergy
  "allergy": "skin-allergy",
  "allergies": "skin-allergy",
  "skin-allergies": "skin-allergy",

  // sterilised (British spelling is the DB slug)
  "sterilized": "sterilised",
  "neutered": "sterilised",
  "spayed": "sterilised",

  // joint-care
  "joint-support": "joint-care",
  "joints": "joint-care",

  // oral-care
  "oral": "oral-care",
  "dental-care": "oral-care",

  // digestive-disease
  "digestion": "digestive-disease",
  "diarrhea": "digestive-disease",
  "diarrhoea": "digestive-disease",
  "gastrointestinal": "digestive-disease",

  // fungal-disease
  "ring-worm": "fungal-disease",
  "ringworm": "fungal-disease",
  "fungal": "fungal-disease",

  // ear-infection
  "ear": "ear-infection",

  // hair-loss
  "hair-fall": "hair-loss",
  "shedding": "hair-loss",

  // under-weight
  "underweight": "under-weight",

  // urinary-system-disorders
  "urinary-disorder": "urinary-system-disorders",
  "urinary-disorders": "urinary-system-disorders",
  "urinary-disease": "urinary-system-disorders",

  // obesity
  "overweight": "obesity",
  "obese": "obesity",

  // parasites (not a condition slug — map to descriptive if needed)
  "external-parasites": "flea",
  "internal-parasites": "dewormer",
});

/**
 * Applies synonym mapping to a list of tags.
 * Returns a new array with synonyms resolved to canonical slugs.
 */
function applySynonyms(tags) {
  const mapped = [];
  const corrections = [];

  for (const tag of tags) {
    const canonical = SYNONYM_MAP[tag];
    if (canonical) {
      mapped.push(canonical);
      corrections.push(`${tag} → ${canonical}`);
    } else {
      mapped.push(tag);
    }
  }

  if (corrections.length > 0) {
    console.log(
      `[AI Tagging] Synonym corrections: ${corrections.join(", ")}`
    );
  }

  return mapped;
}

// ---------------------------------------------------------------------------
// Post-validation filter (Layer 2 safety net)
// ---------------------------------------------------------------------------

/**
 * Applies synonym mapping, then strips any tag not in the master allowlist.
 * Guarantees 100% canonical output regardless of what Gemini returns.
 */
export async function validateAndFilterTags(rawTags) {
  // Step 1: Resolve synonyms → canonical slugs
  const synonymResolved = applySynonyms(rawTags);

  // Step 2: Filter against the dynamic allowlist
  const allowedTags = await getAllowedTags();
  const validated = [];
  const dropped = [];

  for (const tag of synonymResolved) {
    if (allowedTags.has(tag)) {
      validated.push(tag);
    } else {
      dropped.push(tag);
    }
  }

  if (dropped.length > 0) {
    console.warn(
      `[AI Tagging] Dropped non-canonical tags: ${dropped.join(", ")}`
    );
  }

  return [...new Set(validated)];
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the prompt and system instruction for Gemini.
 * Uses a CLOSED vocabulary — Gemini may ONLY pick from the provided lists.
 * Condition tags are loaded dynamically (baseline + DB).
 */
export async function buildTaggingPrompt({
  name_en,
  name_ar,
  desc_en,
  desc_ar,
  subcategoryName,
  categoryName,
  brandName,
}) {
  const petTypes = Object.values(petTypeTags);
  const lifeStages = Object.values(petLifeStageTags);
  const conditionTags = await getConditionTags();

  const breedLines = Object.entries(knownBreedTagsByPetType)
    .map(([type, breeds]) => `  ${type}: ${breeds.join(", ")}`)
    .join("\n");

  const systemInstruction = `You are a product tagging engine for Petyard, a pet e‑commerce platform.

TASK: Classify a product by selecting tags ONLY from the CLOSED vocabulary below.
Do NOT invent, rephrase, combine, or create new tags. Use EXACT strings from the lists.

═══ CLOSED VOCABULARY ═══

PET TYPES (REQUIRED — include ALL that apply, at least one):
  ${petTypes.join(", ")}

LIFE STAGES (include ONLY when the product name or description clearly states an age group):
  ${lifeStages.join(", ")}
  Mapping: puppy/kitten/junior/starter → baby | adult/senior/mature/all-ages → adult

BREED (include ONLY if the product name EXPLICITLY mentions a specific breed):
${breedLines}

HEALTH CONDITIONS (include ONLY if the product name or description EXPLICITLY states
it treats or supports this EXACT condition — NEVER infer from brand names, product names
that sound medical, ingredient implications, or general health claims):
  ${conditionTags.join(", ")}

DESCRIPTIVE (select all that accurately describe the product type, ingredients, or purpose):
  ${DESCRIPTIVE_TAGS.join(", ")}

═══ STRICT RULES ═══

1. You MUST include at least one pet type tag. If the product says "for dogs and cats",
   include BOTH "dog" AND "cat".
2. NEVER add a health condition tag based on inference or assumption.
   The condition word MUST appear in the product name or description.
   ❌ "Heptone" does NOT mean "hepatitis" — do NOT add hepatitis.
   ❌ "Kidney support" in a brand slogan does NOT mean "kidney-disease" — only add if
      the description EXPLICITLY says it treats kidney disease.
   ❌ "Immune boost" does NOT mean "immunity" — do NOT add condition tags for vague claims.
3. NEVER invent tags that are not in the vocabulary above.
   If no suitable tag exists in a category, skip that category entirely.
4. Return ONLY a flat JSON array of lowercase strings. No objects, no explanations,
   no markdown fences.
5. Return between 3 and 10 tags. Prefer precision over quantity.`;

  // Build the user message with available product data
  const parts = [`Product name (English): ${name_en}`];

  if (name_ar) parts.push(`Product name (Arabic): ${name_ar}`);
  if (desc_en) parts.push(`Description (English): ${desc_en}`);
  if (desc_ar) parts.push(`Description (Arabic): ${desc_ar}`);
  if (subcategoryName) parts.push(`Subcategory: ${subcategoryName}`);
  if (categoryName) parts.push(`Category: ${categoryName}`);
  if (brandName) parts.push(`Brand: ${brandName}`);

  const userMessage = parts.join("\n");

  return { systemInstruction, userMessage };
}

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

/**
 * Calls Gemini to generate product tags.
 * Returns a normalised, deduplicated, VALIDATED string array.
 * Returns `[]` on any failure – never throws.
 */
export async function generateProductTags(productData) {
  try {
    const ai = getGeminiAI();
    if (!ai) return [];

    const { systemInstruction, userMessage } = await buildTaggingPrompt(productData);

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: userMessage,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.1, // very low creativity for maximum consistency
        maxOutputTokens: 256,
      },
    });

    const raw = response.text;
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: try to extract a JSON array from prose text
      const match = raw.match(/\[\s*[\s\S]*?\]/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          console.error("[AI Tagging] Could not extract JSON from response:", raw.slice(0, 120));
          return [];
        }
      } else {
        console.error("[AI Tagging] Response is not JSON:", raw.slice(0, 120));
        return [];
      }
    }

    if (!Array.isArray(parsed)) return [];

    // Normalise every tag through the same slugify pipeline
    const normalizedTags = parsed
      .map((t) => (typeof t === "string" ? normalizeTag(t) : ""))
      .filter(Boolean);

    // Layer 2: Hard filter against the dynamic allowlist
    return await validateAndFilterTags(normalizedTags);
  } catch (err) {
    console.error("[AI Tagging] Failed to generate tags:", err.message || err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge helper
// ---------------------------------------------------------------------------

/**
 * Merges admin-provided tags with AI-generated tags.
 * Admin tags go through synonym mapping (so "renal" → "renal-support",
 * "diabetes" → "diabetic", etc.) to avoid semantic duplicates with AI tags,
 * but are NOT filtered against the allowlist — this preserves brand names,
 * custom labels, and other free-form tags that admins intentionally add.
 * AI tags are already validated inside generateProductTags().
 * Returns a deduplicated array.
 */
export async function mergeTagsWithAI(adminTags, aiTags) {
  // Step 1: Normalize (slugify) admin tags
  const normalized = adminTags.map((t) => normalizeTag(t)).filter(Boolean);
  // Step 2: Apply synonym mapping to align with canonical slugs (avoids duplicates)
  const synonymResolved = applySynonyms(normalized);
  // Step 3: Merge with AI tags — Set deduplicates exact matches
  return [...new Set([...synonymResolved, ...aiTags])];
}

// ---------------------------------------------------------------------------
// Exports for migration script & tests
// ---------------------------------------------------------------------------

export { BASELINE_CONDITION_TAGS, DESCRIPTIVE_TAGS, STATIC_ALLOWED_TAGS };
