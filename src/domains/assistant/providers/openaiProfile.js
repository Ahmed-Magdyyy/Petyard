// Official model page reviewed 2026-10-18: https://developers.openai.com/api/docs/models/gpt-6-luna
// Reserve the whole provider context; payload bytes do not prove a smaller billed-token ceiling.
export const openaiLunaProfile = Object.freeze({ provider: "openai", model: "gpt-6-luna", serviceTier: "default",
  contextWindowTokens: 1_050_000, reasoningEfforts: Object.freeze(["none", "low"]) });

const profiles = Object.freeze({ [openaiLunaProfile.model]: openaiLunaProfile });
export const getOpenAIModelProfile = (model) => typeof model === "string" && Object.hasOwn(profiles, model) ? profiles[model] : null;
