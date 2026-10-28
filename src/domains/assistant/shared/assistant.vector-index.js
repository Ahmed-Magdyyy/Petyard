import { reject } from "./assistant.errors.js";

function matchesDefinition(definition, expected) {
  if (!definition || Object.keys(definition).some(key => key !== "fields") || !Array.isArray(definition.fields) ||
      definition.fields.length !== expected.fields.length) return false;
  return expected.fields.every(field => {
    const actual = definition.fields.filter(row => row?.path === field.path);
    return actual.length === 1 && Object.keys(actual[0]).every(key => Object.hasOwn(field, key) || key === "quantization" && actual[0][key] === "none") &&
      Object.entries(field).every(([key, value]) => actual[0][key] === value);
  });
}

// READY proves structural readiness, not freshness or relevance of indexed documents.
export async function assertVectorIndex(collection, expected, code) {
  let rows;
  try { rows = await collection.aggregate([{ $listSearchIndexes: { name: expected.name } }, { $limit: 2 }], { maxTimeMS: 5000 }).toArray(); }
  catch { reject(code, 503); }
  const row = rows?.length === 1 ? rows[0] : null, version = row?.latestDefinitionVersion?.version;
  if (!row || typeof row.id !== "string" || !row.id.trim() || row.id.length > 200 || row.id.includes("\u0000") ||
      row.name !== expected.name || row.type !== expected.type || row.status !== "READY" || row.queryable !== true ||
      !Number.isSafeInteger(version) || version < 0 || !matchesDefinition(row.latestDefinition, expected.definition) ||
      !Array.isArray(row.statusDetail) || !row.statusDetail.length || row.statusDetail.some(host =>
        host?.status !== "READY" || host.queryable !== true || host.mainIndex?.status !== "READY" || host.mainIndex.queryable !== true ||
        host.mainIndex.definitionVersion?.version !== version || !matchesDefinition(host.mainIndex.definition, expected.definition) || host.stagedIndex)) reject(code, 503);
  return { id: row.id, name: row.name, version };
}
