import assert from "node:assert/strict";
import { assistantTestDbPattern } from "./mongoTarget.js";

async function closeServer(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// One hook owns all resources: denied collection cleanup must not skip disconnect or environment restoration.
export async function cleanupAssistantTestResources({ servers, cleanupCollections, disconnect, restoreEnvironment }) {
  const errors = [];
  for (const cleanup of [
    ...[...servers].map((server) => () => closeServer(server)),
    cleanupCollections, disconnect, restoreEnvironment,
  ]) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Assistant Mongo test cleanup failed");
}
export async function cleanupAssistantTestCollections(connection, expectedName) {
  assert.match(expectedName, assistantTestDbPattern, "Refusing cleanup outside an owned assistant test database");
  assert.equal(connection.name, expectedName, "Assistant test connection name changed");
  const db = connection.db;
  assert.equal(db.databaseName, expectedName, "Assistant test database handle changed");
  // Mongoose may still be creating collections/indexes; wait before dropping so they cannot reappear after teardown.
  const initialization = await Promise.allSettled(Object.values(connection.models ?? {}).map((model) => Promise.resolve().then(() => model.init())));
  const errors = initialization.filter((result) => result.status === "rejected").map((result) => result.reason);
  let collections = [];
  try { collections = await db.listCollections({}, { nameOnly: true }).toArray(); } catch (error) { errors.push(error); }
  for (const { name } of collections) {
    try { await db.dropCollection(name); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Assistant test collection cleanup failed");
}

