import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantBudget, AssistantChat, AssistantDietaryWarning, AssistantEvent,
  AssistantMemory, AssistantMessage, AssistantRun } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../../src/domains/pet/pet.model.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { buildContext, subjectFingerprint, subjectFromPet } from "../../../../src/domains/assistant/customer/assistant.context.js";
import { finishRun } from "../../../../src/domains/assistant/customer/assistant.worker.service.js";
import { beginAttempt } from "../../../../src/domains/assistant/shared/assistant.attempts.js";
import { mockAssistantTransactions } from "./mockAssistantTransactions.js";
import { matchesQuery } from "./matchesQuery.js";
import { knownUsage, structuredReply, testConfig } from "./foundationPolicy.js";

export function customerChatFixture(t, input = "Milo has a chicken allergy", policy = {}) {
  mockAssistantTransactions(t);
  const owner = new mongoose.Types.ObjectId(); const pet = { _id: new mongoose.Types.ObjectId(), petOwner: owner, name: "Milo", type: "cat" };
  const subject = subjectFromPet(pet); const config = testConfig(policy);
  const state = { warnings: [], messages: [], events: [], budgetUpdates: [], unlocked: 0, saves: 0, pet, pets: [pet], subject, config };
  const query = (read) => {
    let limit = Infinity;
    const value = () => { const result = read(); return Array.isArray(result) ? result.slice(0, limit) : result; };
    return { select() { return this; }, sort() { return this; }, maxTimeMS() { return this; }, session() { return this; },
      limit(count) { limit = count; return this; }, async lean() { return value(); },
      then(resolve, reject) { return Promise.resolve().then(value).then(resolve, reject); } };
  };
  state.chat = { _id: new mongoose.Types.ObjectId(), owner, activeSubject: subject.id, subjects: [], contextVersion: 0,
    nextSequence: 1, contextAfterSequence: 0, async save() { state.saves++; } };
  state.run = { _id: new mongoose.Types.ObjectId(), owner, chat: state.chat._id, input, subjectId: subject.id,
    purpose: "customer", status: "dispatching", phase: "resolve", contextVersion: 0, userSequence: 1,
    subjectFingerprint: subjectFingerprint(subject), config, createdAt: new Date(), attempts: [],
    async save() { state.saves++; } };
  beginAttempt(state.run, { amount: 1000, budgetIds: ["synthetic-month", "synthetic-day"] });
  state.account = { owner, activeRun: state.run._id, blocked: false };
  state.source = { _id: new mongoose.Types.ObjectId(), owner, chat: state.chat._id, run: state.run._id, text: input,
    sequence: 1, role: "user", subjectId: subject.id, expiresAt: new Date(Date.now() + 60000) };
  state.prepared = { run: { ...state.run }, allowedSubjects: ["user", subject.id], subjectFingerprints: { [subject.id]: subjectFingerprint(subject) } };
  t.mock.method(AssistantRun, "findOne", (filter) => query(() => matchesQuery(state.run, filter) ? state.run : null));
  t.mock.method(AssistantAccount, "findOneAndUpdate", () => query(() => state.account));
  t.mock.method(AssistantAccount, "findOne", () => query(() => state.account));
  t.mock.method(AssistantAccount, "updateOne", async (_filter, update) => { if (update.$set?.activeRun === null) state.unlocked++; return { modifiedCount: 1 }; });
  t.mock.method(AssistantChat, "findOneAndUpdate", () => query(() => state.chat));
  t.mock.method(AssistantChat, "findById", () => query(() => state.chat));
  t.mock.method(UserModel, "findById", () => query(() => ({ active: true, phoneVerified: true })));
  t.mock.method(PetModel, "find", () => query(() => state.pets));
  t.mock.method(PetModel, "findOne", (filter) => query(() => state.pets.find((pet) => String(pet._id) === String(filter._id) && String(pet.petOwner) === String(filter.petOwner)) ?? null));
  t.mock.method(PetModel, "exists", (filter) => query(() => state.pets.some((pet) => String(filter._id) === String(pet._id) && String(filter.petOwner) === String(pet.petOwner))));
  t.mock.method(AssistantBudget, "updateOne", async (filter, update) => { state.budgetUpdates.push({ filter, update }); return { modifiedCount: 1 }; });
  t.mock.method(AssistantMemory, "find", () => query(() => []));
  t.mock.method(AssistantMemory, "updateMany", async () => ({ modifiedCount: 0 }));
  t.mock.method(AssistantMessage, "find", () => query(() => []));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => state.source && matchesQuery(state.source, filter) ? state.source : null));
  t.mock.method(AssistantMessage, "updateOne", async (filter, update) => {
    assert.ok(matchesQuery(state.source, filter)); Object.assign(state.source, update.$set); return { modifiedCount: 1 };
  });
  t.mock.method(AssistantMessage, "create", async ([record]) => { const message = { ...record, _id: new mongoose.Types.ObjectId() }; state.messages.push(message); return [message]; });
  t.mock.method(AssistantEvent, "create", async ([record]) => { state.events.push(record); return [{ _id: new mongoose.Types.ObjectId() }]; });
  t.mock.method(AssistantDietaryWarning, "find", (filter) => query(() => state.warnings.filter((row) => matchesQuery(row, filter))));
  t.mock.method(AssistantDietaryWarning, "findOne", (filter) => query(() => state.warnings.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantDietaryWarning, "create", async ([record]) => {
    const warning = new AssistantDietaryWarning({ ...record, createdAt: new Date(), updatedAt: new Date() });
    assert.equal(warning.validateSync(), undefined); const row = warning.toObject(); state.warnings.push(row); return [row];
  });
  state.report = () => structuredReply({ scope: "health", dietaryWarningAction: "report", dietaryWarningSubjectId: subject.id, dietaryWarningQuote: input });
  state.finish = (data = state.report(), usage = knownUsage) => finishRun(state.prepared,
    { structured: data, finishReason: "completed", toolCalls: [], usage }, null, { currentConfig: config });
  state.context = (overrides = {}) => buildContext(state.run, state.chat, [subject], { ...config, ...overrides }, {});
  return state;
}
