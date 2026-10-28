import mongoose from "mongoose";
import { AssistantAccount, AssistantChat, AssistantAdminChat, AssistantRun, AssistantMessage,
  AssistantAdminMessage } from "../../../../src/domains/assistant/shared/assistant.models.js";

export function persistenceSeed(manifest, config, now = new Date()) {
  const ids = Object.fromEntries(Object.entries(manifest.records).map(([name, values]) =>
    [name, values.map((value) => new mongoose.Types.ObjectId(value))]));
  const owner = ids.users[0]; const foreign = ids.users[1];
  const expiry = new Date(now.getTime() + 3600_000);
  const seed = [];
  function add(Model, value) {
    const model = new Model({ ...value, createdAt: now, updatedAt: now });
    const error = model.validateSync(); if (error) throw error;
    seed.push({ collection: Model.collection.name, document: model.toObject() });
  }
  for (const _id of ids.users) seed.push({ collection: "users", document: {
    _id, email: `${_id}@assistant-test.invalid`, name: manifest.marker, role: "admin", enabledControls: ["analytics"], active: true,
    phoneVerified: true, account_status: "confirmed", deletedAt: null,
  } });
  add(AssistantAccount, { _id: ids.assistantaccounts[0], owner });
  add(AssistantChat, { _id: ids.assistantchats[0], owner });
  for (const [index, actor] of [owner, foreign].entries()) {
    add(AssistantAdminChat, { _id: ids.assistantadminchats[index], owner: actor });
  }
  for (const [index, purpose] of ["customer", "admin_business", "admin_business"].entries()) {
    const actor = index === 2 ? foreign : owner;
    const chat = index === 0 ? ids.assistantchats[0] : ids.assistantadminchats[index - 1];
    const message = index === 0 ? ids.assistantmessages[0] : ids.assistantadminmessages[index - 1];
    add(AssistantRun, { _id: ids.assistantruns[index], owner: actor, chat, purpose, key: `${manifest.marker}/${index}`,
      hash: "synthetic-persistence-only", status: "completed", contextVersion: 0, input: "Synthetic retained reply",
      userSequence: 1, config, responseMessage: message, expiresAt: expiry });
    add(index === 0 ? AssistantMessage : AssistantAdminMessage, {
      _id: message, owner: actor, chat, run: ids.assistantruns[index], sequence: 1, role: "assistant",
      text: index === 0 ? "Customer-only synthetic text" : index === 1 ? "Business-only synthetic text" : "Foreign-only synthetic text",
      expiresAt: expiry,
    });
  }
  return { ids, seed };
}
