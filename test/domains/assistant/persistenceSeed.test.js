import test from "node:test";
import assert from "node:assert/strict";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";
import { persistenceSeed } from "./fixtures/persistenceSeed.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { AssistantAccount, AssistantChat, AssistantAdminChat, AssistantRun, AssistantMessage,
  AssistantAdminMessage } from "../../../src/domains/assistant/shared/assistant.models.js";

test("persistence fixtures pass actual schemas, stay registered and expose no queued or financial work", () => {
  const manifest = createSharedMongoManifest("persistence"); const now = new Date("2026-10-20T10:00:00Z");
  const { seed } = persistenceSeed(manifest, testConfig(), now);
  assert.equal(seed.length, 12); assert.equal(Object.values(manifest.records).flat().length, 13);
  for (const { collection, document } of seed) {
    assert.ok(manifest.records[collection].includes(String(document._id)));
    assert.ok(!collection.includes("budget") && !collection.includes("outbox"));
    if (collection === "assistantruns") {
      assert.equal(document.status, "completed"); assert.equal(document.accounting, "none");
      assert.equal(document.reservation, null); assert.equal(document.expiresAt.getTime(), now.getTime() + 3600_000);
    }
  }
  for (const Model of [AssistantAccount, AssistantChat, AssistantAdminChat, AssistantRun, AssistantMessage, AssistantAdminMessage]) {
    assert.ok(Object.hasOwn(manifest.records, Model.collection.name));
    assert.equal(Model.schema.options.autoCreate, false); assert.equal(Model.schema.options.autoIndex, false);
  }
});

test("synthetic users have unique non-deliverable emails for the existing full unique email index", () => {
  const { seed } = persistenceSeed(createSharedMongoManifest("persistence"), testConfig());
  const emails = seed.filter((entry) => entry.collection === "users").map((entry) => entry.document.email);
  assert.equal(new Set(emails).size, 2);
  for (const email of emails) assert.match(email, /^[a-f\d]{24}@assistant-test\.invalid$/);
});
