import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantDietaryWarning, AssistantAccount, AssistantChat, AssistantMessage, AssistantMemory, AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { listDietaryWarnings, editDietaryWarning, removeDietaryWarning, recordDietaryWarning } from "../../../src/domains/assistant/customer/assistant.dietary-warnings.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

function fixture(t) {
  mockAssistantTransactions(t);
  const owner = new mongoose.Types.ObjectId(); const pet = new mongoose.Types.ObjectId(); const now = new Date();
  const state = { owner, pet, subject: `pet:${pet}`, rows: [], events: [], saves: 0, suppression: [] };
  const query = (read) => {
    let maximum = Infinity; let sorting;
    const result = () => { const value = read(); return Array.isArray(value)
      ? [...value].sort((a, b) => sorting ? String(b._id).localeCompare(String(a._id)) : 0).slice(0, maximum) : value; };
    return { session() { return this; }, maxTimeMS() { return this; }, sort(value) { sorting = value; return this; },
      limit(value) { maximum = value; return this; }, async lean() { return result(); },
      then(resolve, reject) { return Promise.resolve().then(result).then(resolve, reject); } };
  };
  state.chat = { _id: new mongoose.Types.ObjectId(), owner, contextVersion: 0, nextSequence: 7, contextAfterSequence: 0, subjects: [],
    async save() { state.saves++; } };
  state.run = { _id: new mongoose.Types.ObjectId(), owner, chat: state.chat._id, contextVersion: 0, purpose: "customer",
    subjectId: state.subject, input: "Milo has a food allergy", userSequence: 7 };
  state.source = { _id: new mongoose.Types.ObjectId(), owner, chat: state.chat._id, run: state.run._id, role: "user", sequence: 7,
    subjectId: state.subject, text: state.run.input, expiresAt: new Date(now.getTime() + 3600000) };
  t.mock.method(AssistantAccount, "findOneAndUpdate", (filter) => query(() => ({ owner: filter.owner, blocked: true })));
  t.mock.method(AssistantChat, "findOneAndUpdate", (filter) => query(() => String(filter.owner) === String(owner) ? state.chat
    : { _id: new mongoose.Types.ObjectId(), owner: filter.owner, subjects: [], contextVersion: 0 }));
  t.mock.method(PetModel, "exists", (filter) => query(() => String(filter._id) === String(pet) && String(filter.petOwner) === String(owner)));
  t.mock.method(AssistantMessage, "findOne", (filter) => query(() => state.source && matchesQuery(state.source, filter) ? state.source : null));
  t.mock.method(AssistantMemory, "updateMany", async (filter, update, options) => {
    assert.ok(options.session); state.suppression.push({ filter, update }); return { modifiedCount: 0 };
  });
  t.mock.method(AssistantEvent, "create", async ([record], options) => {
    assert.ok(options.session); state.events.push(record); return [{ _id: new mongoose.Types.ObjectId() }];
  });
  t.mock.method(AssistantDietaryWarning, "find", (filter) => query(() => state.rows.filter((row) => matchesQuery(row, filter))));
  t.mock.method(AssistantDietaryWarning, "findOne", (filter) => query(() => state.rows.find((row) => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantDietaryWarning, "findOneAndUpdate", (filter, update, options) => query(() => {
    assert.ok(options.session); assert.equal(options.runValidators, true);
    const row = state.rows.find((value) => matchesQuery(value, filter)); if (!row) return null;
    Object.assign(row, update.$set);
    for (const key of Object.keys(update.$unset ?? {})) delete row[key];
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
    row.updatedAt = new Date(); return row;
  }));
  t.mock.method(AssistantDietaryWarning, "create", async ([record], options) => {
    assert.ok(options.session); const model = new AssistantDietaryWarning({ ...record, createdAt: now, updatedAt: now });
    assert.equal(model.validateSync(), undefined); const row = model.toObject(); state.rows.push(row); return [row];
  });
  state.capture = () => recordDietaryWarning(state.run, { subjectId: state.subject, quote: state.run.input }, testConfig(), {});
  state.bind = () => { state.run.contextVersion = state.chat.contextVersion; };
  return state;
}

test("warning schema requires source/subject/text, has source uniqueness and no automatic expiry", () => {
  const model = new AssistantDietaryWarning({ owner: new mongoose.Types.ObjectId(), subjectId: "invalid", source: "chat" });
  assert.ok(model.validateSync());
  assert.ok(AssistantDietaryWarning.schema.indexes().some(([key, options]) => options.unique && key.owner && key.subjectId && key.sourceMessage));
  assert.equal(AssistantDietaryWarning.schema.indexes().some(([, options]) => options.expireAfterSeconds !== undefined), false);
  for (const field of ["owner", "subjectId", "sourceMessage", "reportedAt"]) assert.equal(AssistantDietaryWarning.schema.path(field).options.immutable, true);
});

test("capture persists only sourced owner/pet data and invalidates context without clinical audit text", async (t) => {
  const state = fixture(t); const created = await state.capture();
  assert.equal(created.duplicate, false); assert.equal(created.warning.text, state.run.input); assert.equal(created.warning.source, "chat");
  assert.equal(created.contextVersion, 1); assert.equal(state.chat.contextAfterSequence, 7);
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].sourceMessage, state.source._id);
  assert.equal(state.events[0].type, "dietary_warning_recorded");
  assert.equal(JSON.stringify(state.events).includes(state.run.input), false);
  assert.equal(Object.hasOwn(created.warning, "sourceMessage"), false);
  assert.equal(state.suppression.length, 1);
});

test("capture rejects wrong purpose, pet, session, context, source and invented quote", async (t) => {
  const state = fixture(t); const cfg = testConfig(); const observation = { subjectId: state.subject, quote: state.run.input };
  await assert.rejects(recordDietaryWarning(state.run, observation, cfg, null), { code: "assistant_accounting_unavailable" });
  await assert.rejects(recordDietaryWarning({ ...state.run, purpose: "admin_business" }, observation, cfg, {}), { code: "run_not_found" });
  await assert.rejects(recordDietaryWarning(state.run, { ...observation, subjectId: `pet:${new mongoose.Types.ObjectId()}` }, cfg, {}), { code: "invalid_dietary_warning" });
  await assert.rejects(recordDietaryWarning(state.run, { ...observation, quote: "invented" }, cfg, {}), { code: "invalid_dietary_warning" });
  await assert.rejects(recordDietaryWarning({ ...state.run, contextVersion: 99 }, observation, cfg, {}), { code: "context_changed" });
  state.source.text = "a different user statement";
  await assert.rejects(state.capture(), { code: "invalid_dietary_warning" });
  assert.equal(state.rows.length, 0); assert.equal(state.events.length, 0);
});

test("blocked owners can list and edit only their warnings; stale or concurrent edits cannot overwrite", async (t) => {
  const state = fixture(t); const { warning } = await state.capture();
  const listed = await listDietaryWarnings(state.owner, { subjectId: state.subject }, testConfig());
  assert.equal(listed.warnings.length, 1); assert.equal(listed.nextBefore, null);
  const edits = await Promise.allSettled(["Beef allergy", "Chicken allergy"].map((value) => editDietaryWarning(state.owner, warning.id,
    { expectedVersion: 1, text: value }, testConfig())));
  assert.equal(edits.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(edits.find((result) => result.status === "rejected").reason.code, "dietary_warning_changed");
  assert.equal(state.rows[0].version, 2); assert.equal(state.rows[0].source, "user_edit"); assert.equal(state.chat.contextVersion, 2);
  await assert.rejects(editDietaryWarning(new mongoose.Types.ObjectId(), warning.id, { expectedVersion: 2, text: "foreign" }, testConfig()), { code: "dietary_warning_not_found" });
});

test("removal scrubs text, keeps a suppression record and is idempotent without another context change", async (t) => {
  const state = fixture(t); const { warning } = await state.capture();
  await assert.rejects(removeDietaryWarning(state.owner, warning.id, { expectedVersion: 99 }, testConfig()), { code: "dietary_warning_changed" });
  const removed = await removeDietaryWarning(state.owner, warning.id, { expectedVersion: 1 }, testConfig());
  assert.equal(removed.duplicate, false); assert.equal(removed.warning.text, null); assert.equal(removed.warning.state, "removed");
  assert.equal(Object.hasOwn(state.rows[0], "text"), false); assert.equal(String(state.rows[0].sourceMessage), String(state.source._id));
  assert.equal(state.rows[0].version, 2); const context = state.chat.contextVersion; const auditCount = state.events.length;
  assert.equal((await removeDietaryWarning(state.owner, warning.id, { expectedVersion: 1 }, testConfig())).duplicate, true);
  assert.equal(state.chat.contextVersion, context); assert.equal(state.events.length, auditCount);
  state.bind(); const replay = await state.capture();
  assert.equal(replay.duplicate, true); assert.equal(replay.warning.state, "removed"); assert.equal(replay.warning.text, null);
  assert.equal(state.chat.contextVersion, context); assert.equal(state.rows.length, 1);
  assert.equal((await listDietaryWarnings(state.owner, { subjectId: state.subject }, testConfig())).warnings.length, 0);
  await assert.rejects(editDietaryWarning(state.owner, warning.id, { expectedVersion: 2, text: "restore" }, testConfig()), { code: "dietary_warning_changed" });
});

test("warning capture replay preserves an explicit edit; a fresh explicit source can add a new warning", async (t) => {
  const state = fixture(t); const { warning } = await state.capture();
  await editDietaryWarning(state.owner, warning.id, { expectedVersion: 1, text: "Explicit correction" }, testConfig());
  state.bind(); assert.equal((await state.capture()).warning.text, "Explicit correction"); assert.equal(state.rows.length, 1);
  state.source._id = new mongoose.Types.ObjectId();
  assert.equal((await state.capture()).duplicate, false); assert.equal(state.rows.length, 2);
});

test("deleted pets cannot receive new warnings but owners can still find and remove their retained data", async (t) => {
  const state = fixture(t); const { warning } = await state.capture(); state.bind();
  t.mock.method(PetModel, "exists", () => ({ session() { return Promise.resolve(false); } }));
  await assert.rejects(state.capture(), { code: "subject_not_found" });
  assert.equal((await listDietaryWarnings(state.owner, {}, testConfig())).warnings.length, 1);
  assert.deepEqual((await listDietaryWarnings(state.owner, { subjectId: `pet:${new mongoose.Types.ObjectId()}` }, testConfig())).warnings, []);
  assert.deepEqual((await listDietaryWarnings(new mongoose.Types.ObjectId(), { subjectId: state.subject }, testConfig())).warnings, []);
  assert.equal((await removeDietaryWarning(state.owner, warning.id, { expectedVersion: 1 }, testConfig())).warning.state, "removed");
});

test("expired unsaved subjects cannot receive warnings but their existing warning remains editable/removable", async (t) => {
  const state = fixture(t);
  const subject = "chat:12345678-1234-1234-1234-123456789012";
  state.chat.subjects = [{ id: subject, expiresAt: new Date(Date.now() + 60000) }];
  state.subject = subject; state.run.subjectId = subject; state.source.subjectId = subject;
  const { warning } = await state.capture(); state.bind(); state.chat.subjects[0].expiresAt = new Date(Date.now() - 1);
  await assert.rejects(state.capture(), { code: "subject_not_found" });
  assert.equal((await listDietaryWarnings(state.owner, {}, testConfig())).warnings[0].subjectId, subject);
  assert.equal((await editDietaryWarning(state.owner, warning.id, { expectedVersion: 1, text: "Explicit correction" }, testConfig())).warning.version, 2);
  assert.equal((await removeDietaryWarning(state.owner, warning.id, { expectedVersion: 2 }, testConfig())).warning.state, "removed");
});

test("listing has stable owner/subject pagination and excludes removed and other-pet records", async (t) => {
  const state = fixture(t); await state.capture(); state.bind(); state.source._id = new mongoose.Types.ObjectId(); await state.capture();
  state.rows.push({ ...state.rows[0], _id: new mongoose.Types.ObjectId(), owner: new mongoose.Types.ObjectId() });
  const first = await listDietaryWarnings(state.owner, { subjectId: state.subject, limit: "1" }, testConfig());
  assert.equal(first.warnings.length, 1); assert.equal(first.nextBefore, first.warnings[0].id);
  const second = await listDietaryWarnings(state.owner, { subjectId: state.subject, limit: "1", before: first.nextBefore }, testConfig());
  assert.equal(second.warnings.length, 1); assert.equal(second.nextBefore, null); assert.notEqual(first.warnings[0].id, second.warnings[0].id);
});

test("invalid controls and disabled configuration are rejected before warning mutations", async (t) => {
  const state = fixture(t); const id = String(new mongoose.Types.ObjectId());
  for (const body of [null, {}, { expectedVersion: "1", text: "x" }, { expectedVersion: 0, text: "x" },
    { expectedVersion: 1, text: " " }, { expectedVersion: 1, text: "x".repeat(501) }, { expectedVersion: 1, text: "x", owner: "foreign" }]) {
    await assert.rejects(editDietaryWarning(state.owner, id, body, testConfig()));
  }
  for (const query of [{ subjectId: null }, { subjectId: state.subject, owner: "foreign" }, { subjectId: state.subject, limit: ["1"] },
    { subjectId: state.subject, limit: "101" }, { subjectId: state.subject, before: "invalid" }]) await assert.rejects(listDietaryWarnings(state.owner, query, testConfig()));
  await assert.rejects(listDietaryWarnings(state.owner, { subjectId: state.subject }, { enabled: false }), { code: "assistant_disabled" });
  await assert.rejects(removeDietaryWarning(state.owner, id, { expectedVersion: 1 }, { enabled: false }), { code: "assistant_disabled" });
  assert.equal(state.rows.length, 0); assert.equal(state.saves, 0);
});
