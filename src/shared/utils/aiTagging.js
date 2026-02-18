import { getGeminiAI } from "../../config/gemini.js";
import { normalizeTag } from "./tagging.js";
import {
  petTypeTags,
  petLifeStageTags,
  knownBreedTagsByPetType,
} from "../constants/petTags.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_MODEL = "gemini-2.0-flash";

/** Descriptive tags AI is allowed to generate beyond the canonical sets. */
const DESCRIPTIVE_TAG_EXAMPLES = [
  "dry", "wet", "food", "treats", "toy", "litter", "shampoo",
  "supplement", "accessory", "collar", "leash", "bed", "bowl",
  "grooming", "dental", "training", "carrier", "cage",
  "chicken", "beef", "salmon", "tuna", "lamb", "turkey", "fish",
];

/** Health condition slugs the recommendation engine recognises. */
const CONDITION_TAGS = [
  // chronic
  "renal", "cardiac", "diabetes", "hepatic",
  // temporary
  "diarrhea", "ring-worm", "external-parasites",
  "internal-parasites", "hairball", "allergy",
];

// ---------------------------------------------------------------------------
// Prompt builder (pure function – easy to test)
// ---------------------------------------------------------------------------

/**
 * Builds the prompt and system instruction for Gemini.
 * Kept as a standalone function so it can be unit-tested without network calls.
 */
export function buildTaggingPrompt({
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

  const breedLines = Object.entries(knownBreedTagsByPetType)
    .map(([type, breeds]) => `  ${type}: ${breeds.join(", ")}`)
    .join("\n");

  const systemInstruction = `You are a product tagging assistant for a pet e‑commerce platform called Petyard.
Your job is to generate tags for products so the recommendation engine can match them to users' pets.

RULES:
1. You MUST include exactly ONE pet type tag: ${petTypes.join(", ")}
   If the product serves multiple pet types, include all relevant ones.
2. Include a life stage tag (${lifeStages.join(", ")}) when detectable from the product name or description.
   "puppy", "kitten", "junior" → baby.  "adult", "senior", "mature" → adult.
3. Include breed tags ONLY when the product explicitly targets a specific breed.
   Known breeds per type:
${breedLines}
4. Include health condition tags ONLY when the product specifically addresses a condition:
   ${CONDITION_TAGS.join(", ")}
5. Add descriptive tags for product category, food type, or main ingredients.
   Examples: ${DESCRIPTIVE_TAG_EXAMPLES.join(", ")}
6. Return ONLY a JSON array of lowercase, hyphenated strings. No explanations.
7. Return between 4 and 12 tags. Prefer quality over quantity.
8. NEVER invent brand-name tags. NEVER use Arabic text as tags.`;

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
 * Returns a normalised, deduplicated string array.
 * Returns `[]` on any failure – never throws.
 */
export async function generateProductTags(productData) {
  try {
    const ai = getGeminiAI();
    if (!ai) return [];

    const { systemInstruction, userMessage } = buildTaggingPrompt(productData);

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: userMessage,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.2,       // low creativity, high consistency
        maxOutputTokens: 256,   // tags are short
      },
    });

    const raw = response.text;
    if (!raw) return [];

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    // Normalise every tag through the same slugify pipeline the rest of the
    // codebase uses, then deduplicate.
    const tags = parsed
      .map((t) => (typeof t === "string" ? normalizeTag(t) : ""))
      .filter(Boolean);

    return [...new Set(tags)];
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
 * Admin tags always take priority (placed first).
 * Returns a deduplicated array.
 */
export function mergeTagsWithAI(adminTags, aiTags) {
  return [...new Set([...adminTags, ...aiTags])];
}
