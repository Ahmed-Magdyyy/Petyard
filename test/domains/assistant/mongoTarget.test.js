import test from "node:test";
import assert from "node:assert/strict";
import { assistantTestDbPattern, authorizedAssistantAtlasHost, createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";

test("generated assistant database names fit Atlas's 38-byte limit and retain an unmistakable unique test prefix", () => {
  for (const time of [0, Date.now(), Number.MAX_SAFE_INTEGER]) {
    const name = createAssistantTestDbName(time);
    assert.match(name, assistantTestDbPattern);
    assert.ok(Buffer.byteLength(name) <= 38);
    assert.notEqual(name, "petyard");
  }
  assert.notEqual(createAssistantTestDbName(), createAssistantTestDbName());
  assert.throws(() => createAssistantTestDbName(-1), /Invalid assistant test database timestamp/);
});

test("Mongo verification target accepts existing credential-free loopback replica sets", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const uri = validateAssistantMongoTarget(`mongodb://${host}:27018/assistant_foundation_test?replicaSet=test-rs`);
    assert.equal(uri.hostname, host);
    assert.equal(uri.pathname, "/assistant_foundation_test");
  }
});

test("Mongo verification permits only the exact approved Atlas SRV host with a separate matching opt-in", () => {
  const uri = validateAssistantMongoTarget(`mongodb+srv://synthetic-user:synthetic-password@${authorizedAssistantAtlasHost}/assistant_foundation_test?retryWrites=true&w=majority&appName=assistant-test`, authorizedAssistantAtlasHost);
  assert.equal(uri.hostname, authorizedAssistantAtlasHost);
  for (const optIn of [undefined, "", "other.mongodb.net"]) {
    assert.throws(() => validateAssistantMongoTarget(`mongodb+srv://${authorizedAssistantAtlasHost}/assistant_foundation_test`, optIn), /not authorized/);
  }
});

test("Mongo verification rejects other hosts, database names, protocols, credentials on loopback and routing overrides", () => {
  for (const uri of [
    "mongodb+srv://other.mongodb.net/assistant_foundation_test",
    `mongodb://${authorizedAssistantAtlasHost}/assistant_foundation_test`,
    `mongodb+srv://${authorizedAssistantAtlasHost}.example.com/assistant_foundation_test`,
    `mongodb+srv://${authorizedAssistantAtlasHost}/production`,
    "mongodb://127.0.0.1:27018/production",
    "mongodb://synthetic:synthetic@localhost/assistant_foundation_test",
    "https://127.0.0.1/assistant_foundation_test",
    `mongodb+srv://${authorizedAssistantAtlasHost}/assistant_foundation_test?proxyHost=other.example.com`,
    `mongodb+srv://${authorizedAssistantAtlasHost}/assistant_foundation_test#other`,
  ]) assert.throws(() => validateAssistantMongoTarget(uri, authorizedAssistantAtlasHost), /not authorized/);
  assert.throws(() => validateAssistantMongoTarget("synthetic-password invalid uri"), (error) => !error.message.includes("synthetic-password"));
});
