import { GoogleGenAI } from "@google/genai";

let aiInstance = null;

/**
 * Returns a lazy-initialized GoogleGenAI instance.
 * Returns null when no API key is configured so callers can
 * gracefully degrade instead of crashing.
 */
export function getGeminiAI() {
  if (aiInstance) return aiInstance;

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn(
      "[Gemini] GEMINI_API_KEY is not set. AI tagging is disabled."
    );
    return null;
  }

  aiInstance = new GoogleGenAI({ apiKey });
  console.log("[Gemini] AI client initialized");
  return aiInstance;
}
