import mongoose from "mongoose";
import { AssistantAdminChat, AssistantAdminMessage, assistantModels } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { NotificationOutboxModel } from "../../../../src/domains/notification/notificationOutbox.model.js";

export function mockAssistantTransactions(t) {
  // Restore this inherited accessor explicitly; the getter mock fails during teardown on this Mongoose connection.
  const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  const previous = mongoose.connection.db;
  mongoose.connection.db = { admin: () => ({ async command() { return { setName: "synthetic-test-only" }; } }) };
  t.after(() => {
    mongoose.connection.db = previous;
    if (descriptor) Object.defineProperty(mongoose.connection, "readyState", descriptor);
    else delete mongoose.connection.readyState;
  });
  for (const model of [...Object.values(assistantModels), AssistantAdminChat, AssistantAdminMessage, NotificationOutboxModel]) {
    t.mock.method(model, "createCollection", async () => {});
    t.mock.method(model, "createIndexes", async () => {});
  }
  t.mock.method(mongoose, "startSession", async () => ({ async withTransaction(callback) { return callback(); }, async endSession() {} }));
}
