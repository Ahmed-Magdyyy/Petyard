import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAdminChat, AssistantAdminMessage, AssistantBudget, AssistantEvent,
  assistantModels } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { NotificationOutboxModel } from "../../../../src/domains/notification/notificationOutbox.model.js";

// Shared tests keep native transactions but never initialize stores or persist notifications/audits.
export function mockSharedAssistantStorage(t, manifest) {
  const events = [];
  for (const Model of [...Object.values(assistantModels), AssistantAdminChat, AssistantAdminMessage, NotificationOutboxModel]) {
    t.mock.method(Model, "createCollection", async () => {});
    t.mock.method(Model, "createIndexes", async () => {});
  }
  for (const Model of [AssistantBudget, NotificationOutboxModel]) {
    for (const method of ["find", "findOne", "findOneAndUpdate", "updateOne", "updateMany", "insertOne", "insertMany",
      "deleteOne", "deleteMany", "aggregate", "countDocuments", "bulkWrite"]) {
      t.mock.method(Model.collection, method, () => { throw new Error("Shared assistant test forbids financial/outbox access"); });
    }
  }
  t.mock.method(AssistantEvent, "create", async (documents, options) => {
    assert.equal(documents.length, 1); assert.ok(options?.session);
    assert.equal(String(documents[0].owner), manifest.records.users[0]);
    assert.equal(String(documents[0].run), manifest.records.assistantruns[0]);
    events.push(documents[0]); return [{ _id: new mongoose.Types.ObjectId() }];
  });
  return { events };
}
