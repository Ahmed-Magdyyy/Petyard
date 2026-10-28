import { randomUUID } from "node:crypto";

export const authorizedAssistantAtlasHost = "magdy.pbupj.mongodb.net";
export const assistantTestDbPattern = /^ai_test_[a-z0-9]+_[a-f0-9]{12}$/;

export function createAssistantTestDbName(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid assistant test database timestamp");
  return `ai_test_${now.toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

// Test-only target gate. Errors deliberately omit the supplied URI and credentials.
export function validateAssistantMongoTarget(value, atlasOptIn) {
  let uri;
  try { uri = new URL(value); } catch { throw new Error("Invalid assistant test Mongo target"); }
  const local = uri.protocol === "mongodb:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)
    && !uri.username && !uri.password;
  const atlas = uri.protocol === "mongodb+srv:" && uri.hostname === authorizedAssistantAtlasHost
    && atlasOptIn === authorizedAssistantAtlasHost && !uri.port;
  if ((!local && !atlas) || uri.pathname !== "/assistant_foundation_test" || uri.hash ||
      [...uri.searchParams.keys()].some((key) => !["replicaSet", "retryWrites", "w", "appName", "authSource"].includes(key))) {
    throw new Error("Assistant test Mongo target is not authorized");
  }
  return uri;
}
