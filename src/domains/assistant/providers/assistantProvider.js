import { getOpenAIModelProfile } from "./openaiProfile.js";
import { createOpenAIResponsesAdapter } from "./openaiResponses.js";
import { fail } from "./providerContract.js";

// Only explicitly supported profiles can be selected; no automatic fallback after paid work.
const providers = Object.freeze({
  openai: Object.freeze({ credentialEnv: "OPENAI_API_KEY", profile: getOpenAIModelProfile, create: createOpenAIResponsesAdapter }),
});
const definition = (provider) => typeof provider === "string" && Object.hasOwn(providers, provider) ? providers[provider] : null;

export function getAssistantModelProfile(provider, model) {
  return definition(provider)?.profile(model) ?? null;
}

export function hasAssistantCredentials(config, env) {
  const provider = definition(config.provider);
  if (!provider?.profile(config.model)) return false;
  const credential = env[provider.credentialEnv];
  return typeof credential === "string" && Boolean(credential.trim());
}

export function createAssistantAdapter(config, env = process.env) {
  if (config?.enabled !== true) fail("assistant_disabled");
  const provider = definition(config.provider);
  const profile = provider?.profile(config.model);
  if (!profile) fail("unsupported_model");
  return provider.create({ apiKey: env[provider.credentialEnv], model: profile.model });
}
