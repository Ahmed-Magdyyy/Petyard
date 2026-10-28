import assert from "node:assert/strict";
import { mock } from "node:test";
import { catalogIntentCases } from "./catalogIntentCases.js";
import { buildContext } from "../../../../src/domains/assistant/customer/assistant.context.js";
import { AssistantDietaryWarning, AssistantMemory, AssistantMessage } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { validateRequest } from "../../../../src/domains/assistant/providers/providerContract.js";
import { testConfig } from "./foundationPolicy.js";

export const catalogIntentSubjects = [
  { id: "pet:111111111111111111111111", name: "Milo", species: "cat", saved: true,
    profile: { birthDate: "2021-01-01", breed: null, gender: null, chronicConditions: [], temporaryIssues: [] } },
  { id: "pet:222222222222222222222222", name: "Roy", species: "dog", saved: true,
    profile: { birthDate: "2024-01-01", breed: null, gender: null, chronicConditions: ["PRIVATE_ROY_PROFILE_MARKER"], temporaryIssues: [] } },
];
export const catalogIntentConfig = testConfig({ productSearchEnabled: true, maxOutputTokens: 1024, maxOutputChars: 8000,
  timeoutMs: 15000, maxContextBytes: 18000, maxMessageChars: 2000 });

export async function buildCatalogIntentRequest(fixture) {
  assert.ok(catalogIntentCases.includes(fixture), "Only the fixed reviewed pack is supported");
  const run = { _id: "synthetic-catalog-run", owner: "synthetic-owner", chat: "synthetic-chat", phase: "resolve", generation: 0,
    subjectId: fixture.expected.subjectId, subjectExplicit: false, userSequence: 1, contextVersion: 0, input: fixture.input,
    catalogContext: { warehouseId: "333333333333333333333333", language: fixture.language === "ar" ? "ar" : "en" } };
  const query = () => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, async lean() { return []; } });
  const mocks = [AssistantMemory, AssistantMessage, AssistantDietaryWarning].map((Model) => mock.method(Model, "find", query));
  try {
    const request = await buildContext(run, { contextVersion: 0, contextAfterSequence: 0, awaitingSubject: false },
      catalogIntentSubjects, catalogIntentConfig, null);
    validateRequest(request); return { run, request };
  } finally { for (const handle of mocks.reverse()) handle.mock.restore(); }
}

